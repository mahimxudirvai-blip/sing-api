
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");

const PORT = Number(process.env.PORT || 3000);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const DENO = process.env.DENO_PATH || "/usr/local/bin/deno";
const COOKIE_FILE = process.env.YTDLP_COOKIES || "/sing/cookies.txt";

const SEARCH_TIMEOUT = 15000;
const URL_TIMEOUT = 12000;
const MIN_SCORE = 0.5;

const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;
const CACHE_TTL = 5 * 60 * 1000;

const hits = new Map();
const cache = new Map();
const pending = new Map();

function rateLimited(ip) {
    const now = Date.now();
    const requests = (hits.get(ip) || [])
        .filter(time => now - time < RATE_WINDOW);

    if (requests.length >= RATE_LIMIT) {
        hits.set(ip, requests);
        return true;
    }

    requests.push(now);
    hits.set(ip, requests);
    return false;
}

function cookieArgs() {
    if (!fs.existsSync(COOKIE_FILE)) return [];
    return ["--cookies", COOKIE_FILE];
}

function runYtDlp(args, timeout) {
    return new Promise((resolve, reject) => {
        const child = spawn(YTDLP, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(new Error("yt-dlp timed out"), "YTDLP_TIMEOUT");
        }, timeout);

        function finish(error, code) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (error) {
                error.code = code;
                reject(error);
            } else {
                resolve(stdout.trim());
            }
        }

        child.stdout.on("data", data => {
            stdout += data.toString();

            if (stdout.length > 2_000_000) {
                child.kill("SIGKILL");
                finish(new Error("Output too large"), "YTDLP_FAILED");
            }
        });

        child.stderr.on("data", data => {
            stderr += data.toString();

            if (stderr.length > 20000) {
                stderr = stderr.slice(-20000);
            }
        });

        child.on("error", error => {
            finish(error, "YTDLP_UNAVAILABLE");
        });

        child.on("close", code => {
            if (code !== 0) {
                finish(
                    new Error(stderr.trim().slice(-500) || "yt-dlp failed"),
                    "YTDLP_FAILED"
                );
            } else {
                finish(null);
            }
        });
    });
}

function words(value) {
    return value.toLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N} ]/gu, " ")
        .split(/\s+/)
        .filter(Boolean);
}

function scoreTitle(query, title) {
    const queryWords = words(query);
    const titleWords = new Set(words(title));

    if (!queryWords.length) return 0;

    return queryWords.filter(word => titleWords.has(word)).length
        / queryWords.length;
}

async function searchSong(query) {
    const raw = await runYtDlp([
        "--dump-single-json",
        "--flat-playlist",
        "--no-warnings",
        "--ignore-errors",
        "--no-playlist",
        ...cookieArgs(),
        "--js-runtimes", `deno:${DENO}`,
        `ytsearch5:${query}`
    ], SEARCH_TIMEOUT);

    const data = JSON.parse(raw);
    const entries = (data.entries || []).filter(
        entry => entry && entry.id && entry.title
    );

    let best = null;
    let bestScore = 0;

    for (const entry of entries) {
        const score = scoreTitle(query, entry.title);

        if (score > bestScore) {
            best = entry;
            bestScore = score;
        }
    }

    return bestScore >= MIN_SCORE ? best : null;
}

async function audioUrl(videoId) {
    const raw = await runYtDlp([
        "-g",
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "--no-warnings",
        "--no-playlist",
        ...cookieArgs(),
        "--js-runtimes", `deno:${DENO}`,
        `https://www.youtube.com/watch?v=${videoId}`
    ], URL_TIMEOUT);

    return raw.split("\n")[0] || null;
}

function getCache(key) {
    const item = cache.get(key);

    if (!item) return null;

    if (Date.now() > item.expires) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

function setCache(key, data) {
    if (cache.size >= 500) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }

    cache.set(key, {
        data,
        expires: Date.now() + CACHE_TTL
    });
}

function sendJson(res, status, data) {
    const body = JSON.stringify(data);

    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });

    res.end(body);
}

async function getSong(query) {
    const key = query.toLowerCase();

    if (pending.has(key)) {
        return pending.get(key);
    }

    const task = (async () => {
        const song = await searchSong(query);

        if (!song) return null;

        const stream = await audioUrl(song.id);

        if (!stream) return null;

        const thumbnails = song.thumbnails || [];

        return {
            ok: true,
            title: song.title,
            artist: song.channel || song.uploader || null,
            duration: song.duration || null,
            thumbnail: thumbnails.length
                ? thumbnails[thumbnails.length - 1].url
                : null,
            videoId: song.id,
            webpageUrl: `https://www.youtube.com/watch?v=${song.id}`,
            audioUrl: stream
        };
    })();

    pending.set(key, task);

    try {
        return await task;
    } finally {
        pending.delete(key);
    }
}

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return sendJson(res, 405, {
            ok: false,
            error: "Method not allowed"
        });
    }

    let url;

    try {
        url = new URL(req.url, "http://localhost");
    } catch {
        return sendJson(res, 400, {
            ok: false,
            error: "Invalid URL"
        });
    }

    if (url.pathname === "/health") {
        return sendJson(res, 200, {
            ok: true,
            service: "sing-api",
            cookies: fs.existsSync(COOKIE_FILE)
        });
    }

    if (url.pathname !== "/sing") {
        return sendJson(res, 404, {
            ok: false,
            error: "Use /sing?q=song"
        });
    }

    const ip = req.socket.remoteAddress || "unknown";

    if (rateLimited(ip)) {
        return sendJson(res, 429, {
            ok: false,
            error: "Too many requests"
        });
    }

    const query = (url.searchParams.get("q") || "").trim();

    if (!query || query.length > 200) {
        return sendJson(res, 400, {
            ok: false,
            error: "Invalid or missing query"
        });
    }

    const key = query.toLowerCase();
    const cached = getCache(key);

    if (cached) {
        if (url.searchParams.get("stream") === "1") {
            res.writeHead(302, {
                Location: cached.audioUrl,
                "Cache-Control": "no-store"
            });
            return res.end();
        }

        return sendJson(res, 200, cached);
    }

    try {
        const result = await getSong(query);

        if (!result) {
            return sendJson(res, 404, {
                ok: false,
                error: "No matching song found"
            });
        }

        setCache(key, result);

        if (url.searchParams.get("stream") === "1") {
            res.writeHead(302, {
                Location: result.audioUrl,
                "Cache-Control": "no-store"
            });
            return res.end();
        }

        return sendJson(res, 200, result);

    } catch (error) {
        const status = error.code === "YTDLP_TIMEOUT" ? 504
            : error.code === "YTDLP_UNAVAILABLE" ? 500
            : 502;

        console.error("Sing API:", error.message);

        return sendJson(res, status, {
            ok: false,
            error: error.code === "YTDLP_TIMEOUT"
                ? "YouTube request timed out"
                : error.code === "YTDLP_UNAVAILABLE"
                    ? "yt-dlp is not installed"
                    : "YouTube extraction failed. Check cookies and yt-dlp."
        });
    }
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`sing-api listening on port ${PORT}`);
    console.log(`Cookie file: ${fs.existsSync(COOKIE_FILE) ? "Found" : "Not found"}`);
});
