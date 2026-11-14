"use strict";
// sing-api — best working version. Raw JioSaavn first, YouTube (yt-dlp) fallback.
// Zero npm dependencies (Node builtins only). Run with --openssl-legacy-provider
// (DES-ECB, needed to decrypt Saavn media URLs, needs the legacy provider on Node 20+).
//
//   GET /sing?q=<song>        -> audio bytes directly (Saavn 302 redirect, or yt-dlp stream)
//   GET /sing?q=<song>&info=1 -> JSON { ok, title, artist, duration, source }
//   GET /sing?q=<song>&duration=<seconds> -> prefer a candidate whose
//       length is close to the target (the bot passes the YouTube
//       video's duration: a 112s cut of a 296s song is not the song)
//   GET /health               -> { ok: true, ytdlp, cookies, proxy, deno, des }
//
// Env:
//   PORT            (Railway sets this automatically)
//   YTDLP_PATH      (default: yt-dlp)
//   DENO_PATH       (default: /usr/local/bin/deno)
//   YTDLP_PROXY     (residential proxy URL — fixes YouTube 403 on datacenter IPs)
//   YTDLP_COOKIES   (cookie file contents — saved to /tmp at startup, never logged)

const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
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

const SEARCH_TIMEOUT_MS = 30000;
const SAAVN_TIMEOUT_MS = 10000;
const FIRST_BYTE_TIMEOUT_MS = 30000;

// JioSaavn encrypts media URLs with DES-ECB (static key, well known).
const SAAVN_DES_KEY = Buffer.from("38346591", "utf8");

let ytdlpOK = false;
let desOK = false;
spawn(YTDLP, ["--version"], { stdio: "ignore" })
	.on("close", (code) => { ytdlpOK = code === 0; })
	.on("error", () => { ytdlpOK = false; }); // yt-dlp missing: Saavn still works
try {
	crypto.createDecipheriv("des-ecb", SAAVN_DES_KEY, null);
	desOK = true;
} catch { desOK = false; }

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

function decodeEntities(s) {
	return String(s || "")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

async function fetchJson(url, timeoutMs, headers) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: ctrl.signal, headers });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

// --- JioSaavn (primary source — one HTTP call, direct 320kbps MP3) ---

function decryptSaavnUrl(encrypted) {
	const decipher = crypto.createDecipheriv("des-ecb", SAAVN_DES_KEY, null);
	const out = Buffer.concat([
		decipher.update(Buffer.from(encrypted, "base64")),
		decipher.final()
	]).toString("utf8").trim();
	return out || null;
}

// Version words that mark a non-original recording (a reprise, a
// cover, a remix…). Penalised unless the query itself asks for one —
// "pasoori reprise" should still match the reprise.
const VERSION_WORDS = ["reprise", "cover", "remix", "karaoke", "lofi", "lo-fi", "unplugged", "acoustic", "slowed", "reverb", "sped up"];

/**
 * Score one Saavn candidate. Word match + exact-title bonus +
 * popularity tie-break, then:
 *   - duration: +0.5 within 5s of the target, +0.3 within 15s,
 *     -0.3 when more than 60s off (the robust original-vs-cut
 *     signal — the bot knows the YouTube video's length);
 *   - version: -0.4 when the title carries a version word the query
 *     did not ask for;
 *   - unknown artist: -0.2 (Saavn failed to attribute it).
 */
function scoreSaavnCandidate(query, cand, opts = {}) {
	const q = String(query || "");
	const title = String((cand && cand.title) || "");
	const artist = String((cand && cand.artist) || "");
	let s = scoreTitle(q, `${title} ${artist}`.trim());
	const cleaned = title.replace(/\s*\([^)]*\)\s*/g, "").trim().toLowerCase();
	if (cleaned === q.trim().toLowerCase()) s += 0.3;
	const plays = Number(cand && cand.playCount) || 0;
	if (plays > 0) s += Math.min(0.1, Math.log10(plays + 1) * 0.01);
	const target = Number(opts && opts.targetDuration);
	const dur = Number(cand && cand.duration);
	if (Number.isFinite(target) && target > 0 && Number.isFinite(dur) && dur > 0) {
		const diff = Math.abs(dur - target);
		if (diff <= 5) s += 0.5;
		else if (diff <= 15) s += 0.3;
		else if (diff > 60) s -= 0.3;
	}
	const qLower = q.toLowerCase();
	const tLower = title.toLowerCase();
	if (VERSION_WORDS.some(w => tLower.includes(w) && !qLower.includes(w))) s -= 0.4;
	if (!artist || artist.toLowerCase() === "unknown") s -= 0.2;
	return s;
}

async function searchSaavn(query, opts = {}) {
	const url = "https://www.jiosaavn.com/api.php?__call=search.getResults" +
		`&_format=json&api_version=4&q=${encodeURIComponent(query)}&n=10&p=1`;
	const json = await fetchJson(url, SAAVN_TIMEOUT_MS, {
		"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
		"Referer": "https://www.jiosaavn.com/"
	});
	const results = (json && json.results) || [];
	let best = null;
	let bestScore = 0;
	for (const r of results) {
		if (!r || r.type !== "song") continue;
		const info = r.more_info || {};
		if (!info.encrypted_media_url) continue;
		const title = decodeEntities(r.title || "");
		const artist = decodeEntities(r.subtitle || info.music || "");
		// Score title + artist together, so "perfect ed sheeran" matches.
		const s = scoreSaavnCandidate(query, {
			title,
			artist,
			duration: Number(info.duration) || null,
			playCount: Number(r.play_count) || 0
		}, opts);
		if (s > bestScore) { bestScore = s; best = { r, info, title }; }
	}
	if (!best || bestScore < 0.5) return null;
	let audioUrl;
	try {
		audioUrl = decryptSaavnUrl(best.info.encrypted_media_url);
	} catch {
		return null;
	}
	if (!audioUrl) return null;
	// The decrypted URL is 96kbps — upgrade to 320kbps when the track has it.
	if (best.info["320kbps"] === "true" && audioUrl.endsWith("_96.mp4")) {
		audioUrl = audioUrl.slice(0, -"_96.mp4".length) + "_320.mp4";
	}
	return {
		title: best.title || "Unknown",
		artist: decodeEntities(best.r.subtitle || best.info.music || "Unknown"),
		duration: Number(best.info.duration) || null,
		audioUrl
	};
}

// --- YouTube via yt-dlp (fallback) ---

function baseArgs() {
	const args = ["--ignore-config", "--no-warnings", "--no-playlist"];
	if (fs.existsSync(DENO)) args.push("--js-runtimes", `deno:${DENO}`);
	if (COOKIE_FILE) args.push("--cookies", COOKIE_FILE);
	if (PROXY) args.push("--proxy", PROXY);
	// TV client first: it returns playable formats without a PO token
	// where android/web return none on datacenter IPs. Falls through to
	// android, iOS, then web.
	args.push("--extractor-args", "youtube:player_client=tv,android,ios,web");
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
// false if yt-dlp failed before the first byte.
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
		res._ytDlpStderr = () => stderr.trim().slice(-500);
	});
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
			deno: fs.existsSync(DENO),
			des: desOK
		});
	}
	if (u.pathname !== "/sing") {
		return sendJson(res, 404, { ok: false, error: "Use /sing?q=<song name>" });
	}

	const q = (u.searchParams.get("q") || "").trim();
	if (!q) {
		return sendJson(res, 400, { ok: false, error: "Missing q — e.g. /sing?q=perfect" });
	}
	const infoOnly = u.searchParams.get("info") === "1";
	// Optional target duration (seconds) from the bot — the YouTube
	// video's length. Ignored when missing or invalid.
	const targetDuration = Number(u.searchParams.get("duration"));
	const durationOpt = Number.isFinite(targetDuration) && targetDuration > 0 ? targetDuration : null;

	// 1. JioSaavn first — fast, free, no yt-dlp, no proxy needed.
	try {
		const song = await searchSaavn(q, durationOpt ? { targetDuration: durationOpt } : {});
		if (song) {
			if (infoOnly) {
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
	} catch { /* fall through to YouTube */ }

	// 2. YouTube via yt-dlp.
	try {
		const song = await searchYouTube(q);
		if (song) {
			if (infoOnly) {
				return sendJson(res, 200, { ok: true, ...song, source: "youtube" });
			}
			const ok = await streamYouTube(res, song);
			if (ok) return; // streamed — response already finished
			var ytError = res._ytDlpStderr ? res._ytDlpStderr() : "YouTube download failed";
		}
	} catch (e) {
		var ytError = e.message;
	}

	return sendJson(res, 502, {
		ok: false,
		error: "No working source for this song",
		details: (typeof ytError === "string" ? ytError : "Saavn and YouTube both failed").slice(-500)
	});
});

// Only listen when run directly (node index.js). Requiring the
// module (tests) must not start a server.
if (require.main === module) {
	server.listen(PORT, "0.0.0.0", () => {
		console.log(`sing-api listening on port ${PORT}`);
	});
}

module.exports = { scoreSaavnCandidate, scoreTitle, searchSaavn };
