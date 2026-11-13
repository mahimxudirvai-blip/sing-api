"use strict";
// sing-api — best working version. YouTube (yt-dlp) first, JioSaavn fallback.
// Zero npm dependencies (Node builtins only).
//
//   GET /sing?q=<song>        -> audio bytes directly (yt-dlp stream, or Saavn redirect)
//   GET /sing?q=<song>&info=1 -> JSON { ok, title, artist, duration, source }
//   GET /health               -> { ok: true, ytdlp, cookies, proxy, deno }
//
// Env:
//   PORT            (Railway sets this automatically)
//   YTDLP_PATH      (default: yt-dlp)
//   DENO_PATH       (default: /usr/local/bin/deno)
//   YTDLP_PROXY     (residential proxy URL — fixes YouTube 403 on datacenter IPs)
//   YTDLP_COOKIES   (cookie file contents — saved to /tmp at startup, never logged)
//   SAAVN_API_URL   (override the Saavn fallback endpoint)

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const DENO = process.env.DENO_PATH || "/usr/local/bin/deno";
const PROXY = process.env.YTDLP_PROXY || "";

// Cookies: prefer the env var (Railway), else a local cookies.txt (VPS).
// The env value is written to /tmp once at startup — never committed, never logged.
let COOKIE_FILE = path.join(__dirname, "cookies.txt");
if (process.env.YTDLP_COOKIES) {
	try {
		COOKIE_FILE = path.join(os.tmpdir(), "sing-cookies.txt");
		fs.writeFileSync(COOKIE_FILE, process.env.YTDLP_COOKIES, { mode: 0o600 });
	} catch { COOKIE_FILE = ""; }
}
if (COOKIE_FILE && !fs.existsSync(COOKIE_FILE)) COOKIE_FILE = "";

const SAAVN_ENDPOINTS = process.env.SAAVN_API_URL
	? [process.env.SAAVN_API_URL]
	: ["https://jio.shnwaz.dev/api/search/songs", "https://saavn.dev/api/search/songs"];
const SEARCH_TIMEOUT_MS = 30000;
const SAAVN_TIMEOUT_MS = 10000;
const FIRST_BYTE_TIMEOUT_MS = 30000;

let ytdlpOK = false;
spawn(YTDLP, ["--version"], { stdio: "ignore" }).on("close", (code) => { ytdlpOK = code === 0; });

function baseArgs() {
	const args = ["--ignore-config", "--no-warnings", "--no-playlist"];
	if (fs.existsSync(DENO)) args.push("--js-runtimes", `deno:${DENO}`);
	if (COOKIE_FILE) args.push("--cookies", COOKIE_FILE);
	if (PROXY) args.push("--proxy", PROXY);
	// The Android client often bypasses the web 403 on datacenter IPs.
	args.push("--extractor-args", "youtube:player_client=android,web");
	return args;
}

function runYtDlp(args, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("yt-dlp timed out"));
		}, timeoutMs);
		child.stdout.on("data", (d) => { out += d; });
		child.stderr.on("data", (d) => { err += d; });
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error("yt-dlp not found: " + e.message));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(err.trim().slice(-500) || "yt-dlp failed"));
			else resolve(out);
		});
	});
}

function words(s) {
	return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}

// Fraction of query words in the title, with a bonus for official uploads.
function scoreTitle(query, title) {
	const q = words(query);
	if (!q.length) return 0;
	const t = new Set(words(title));
	let score = q.filter((w) => t.has(w)).length / q.length;
	const lower = title.toLowerCase();
	if (lower.includes("official")) score += 0.15;
	if (lower.includes("music video")) score += 0.1;
	return score;
}

async function searchYouTube(query) {
	const raw = await runYtDlp([...baseArgs(), "--flat-playlist", "-J", `ytsearch3:${query}`], SEARCH_TIMEOUT_MS);
	const data = JSON.parse(raw);
	const entries = (data.entries || [data]).filter((e) => e && e.id);
	let best = null;
	let bestScore = 0;
	for (const e of entries) {
		const s = scoreTitle(query, e.title || "");
		if (s > bestScore) { bestScore = s; best = e; }
	}
	if (!best || bestScore < 0.5) return null;
	return {
		title: best.title || "Unknown",
		artist: best.uploader || best.channel || "Unknown",
		duration: best.duration || null,
		videoId: best.id,
		webpageUrl: `https://www.youtube.com/watch?v=${best.id}`
	};
}

// Streams yt-dlp's stdout to the client. Resolves true if audio flowed,
// false (+ error text) if yt-dlp failed before the first byte.
function streamYouTube(res, song) {
	return new Promise((resolve) => {
		const child = spawn(YTDLP, [
			...baseArgs(),
			"-f", "bestaudio[ext=m4a]/bestaudio/best",
			"-o", "-",
			song.webpageUrl
		], { stdio: ["ignore", "pipe", "pipe"] });

		let stderr = "";
		let started = false;
		let done = false;
		const finish = (ok) => { if (!done) { done = true; resolve(ok); } };

		const firstByteTimer = setTimeout(() => {
			if (!started) { child.kill("SIGKILL"); finish(false); }
		}, FIRST_BYTE_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => {
			if (!started) {
				started = true;
				clearTimeout(firstByteTimer);
				res.writeHead(200, {
					"Content-Type": "audio/mp4",
					"Access-Control-Allow-Origin": "*",
					"X-Title": encodeURIComponent(song.title),
					"X-Artist": encodeURIComponent(song.artist),
					"X-Source": "youtube"
				});
			}
			res.write(chunk);
		});
		child.stderr.on("data", (d) => { stderr += d; });
		child.on("close", () => {
			clearTimeout(firstByteTimer);
			if (!started) finish(false);
			else { res.end(); finish(true); }
		});
		child.on("error", () => {
			clearTimeout(firstByteTimer);
			if (!started) finish(false);
			else { res.end(); finish(true); }
		});
		res.on("close", () => { try { child.kill("SIGKILL"); } catch {} });

		// Expose the failure details to the caller.
		child._getStderr = () => stderr.trim().slice(-500);
		res._ytDlpStderr = () => stderr.trim().slice(-500);
	});
}

async function fetchJson(url, timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "sing-api/1.0" } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

function bestAudioUrl(song) {
	const links = song.downloadUrl;
	if (typeof links === "string") return links;
	if (!Array.isArray(links) || !links.length) return null;
	let best = null;
	let bestKbps = -1;
	for (const l of links) {
		if (!l || !l.url) continue;
		const m = /(\d+)\s*kbps/i.exec(l.quality || "");
		const kbps = m ? Number(m[1]) : 0;
		if (kbps >= bestKbps) { bestKbps = kbps; best = l.url; }
	}
	return best;
}

async function searchSaavn(query) {
	for (const base of SAAVN_ENDPOINTS) {
		try {
			const json = await fetchJson(`${base}?query=${encodeURIComponent(query)}`, SAAVN_TIMEOUT_MS);
			const data = json && json.data;
			const results = ((data && data.results) || json.results || (Array.isArray(data) ? data : []) || [])
				.filter((r) => r && (r.name || r.title));
			let best = null;
			let bestScore = 0;
			for (const r of results) {
				const s = scoreTitle(query, r.name || r.title || "");
				if (s > bestScore) { bestScore = s; best = r; }
			}
			if (best && bestScore >= 0.5) {
				const audioUrl = bestAudioUrl(best);
				if (!audioUrl) return null;
				const artists = best.artists && best.artists.primary;
				return {
					title: best.name || best.title || "Unknown",
					artist: (Array.isArray(artists) && artists.length)
						? artists.map((a) => a.name).filter(Boolean).join(", ") || "Unknown"
						: (best.artist || best.singers || "Unknown"),
					duration: best.duration || null,
					audioUrl
				};
			}
			return null; // answered but no match — don't try the other instance
		} catch { /* try the next instance */ }
	}
	return null;
}

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Access-Control-Allow-Origin": "*" });
	res.end(body);
}

const server = http.createServer(async (req, res) => {
	let u;
	try {
		u = new URL(req.url, "http://localhost");
	} catch {
		return sendJson(res, 400, { ok: false, error: "Bad URL." });
	}

	if (u.pathname === "/health") {
		return sendJson(res, 200, {
			ok: true,
			service: "sing-api",
			ytdlp: ytdlpOK,
			cookies: Boolean(COOKIE_FILE),
			proxy: Boolean(PROXY),
			deno: fs.existsSync(DENO)
		});
	}
	if (u.pathname !== "/sing") {
		return sendJson(res, 404, { ok: false, error: "Use /sing?q=<song name>" });
	}

	const q = (u.searchParams.get("q") || "").trim();
	if (!q) {
		return sendJson(res, 400, { ok: false, error: "Missing q — e.g. /sing?q=perfect" });
	}

	// 1. YouTube via yt-dlp.
	try {
		const song = await searchYouTube(q);
		if (song) {
			if (u.searchParams.get("info") === "1") {
				return sendJson(res, 200, { ok: true, ...song, source: "youtube" });
			}
			const ok = await streamYouTube(res, song);
			if (ok) return; // streamed — response already finished
			// yt-dlp failed before the first byte (e.g. 403) — fall through to Saavn.
			var ytError = res._ytDlpStderr ? res._ytDlpStderr() : "YouTube download failed";
		}
	} catch (e) {
		var ytError = e.message;
	}

	// 2. JioSaavn fallback.
	try {
		const song = await searchSaavn(q);
		if (song) {
			if (u.searchParams.get("info") === "1") {
				return sendJson(res, 200, { ok: true, ...song, source: "saavn" });
			}
			res.writeHead(302, {
				Location: song.audioUrl,
				"Access-Control-Allow-Origin": "*",
				"X-Title": encodeURIComponent(song.title),
				"X-Artist": encodeURIComponent(song.artist),
				"X-Source": "saavn"
			});
			return res.end();
		}
	} catch { /* fall through to the error below */ }

	return sendJson(res, 502, {
		ok: false,
		error: "No working source for this song",
		details: (typeof ytError === "string" ? ytError : "YouTube and Saavn both failed").slice(-500)
	});
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(`sing-api listening on port ${PORT}`);
});
