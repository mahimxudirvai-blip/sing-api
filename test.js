"use strict";

/**
 * sing-api tests — the Saavn candidate scoring (duration matching +
 * version penalties) and the full searchSaavn selection with a
 * stubbed Saavn response. No real network: global fetch is stubbed.
 *
 *   npm test   (node --openssl-legacy-provider test.js — DES-ECB
 *   needs the legacy provider, same as the server itself)
 */

const assert = require("assert");
const crypto = require("crypto");

const { scoreSaavnCandidate, searchSaavn } = require("./index");

// Same static DES key as index.js (well-known Saavn key).
const SAAVN_DES_KEY = Buffer.from("38346591", "utf8");

function encryptSaavnUrl(url) {
	const cipher = crypto.createCipheriv("des-ecb", SAAVN_DES_KEY, null);
	return Buffer.concat([cipher.update(url, "utf8"), cipher.final()]).toString("base64");
}

let count = 0;
const results = [];
async function test(name, fn) {
	try {
		await fn();
		count++;
		results.push({ name, ok: true });
	}
	catch (error) {
		results.push({ name, ok: false, error });
	}
}

async function main() {
	const base = { title: "Pasoori", artist: "Ali Sethi", duration: 277, playCount: 1000000 };

	await test("scoring: duration within 5s adds +0.5", () => {
		const without = scoreSaavnCandidate("Pasoori", base, {});
		const withMatch = scoreSaavnCandidate("Pasoori", base, { targetDuration: 277 });
		assert.ok(Math.abs((withMatch - without) - 0.5) < 1e-9, `expected +0.5, got ${withMatch - without}`);
	});

	await test("scoring: duration within 15s adds +0.3", () => {
		const without = scoreSaavnCandidate("Pasoori", base, {});
		const withClose = scoreSaavnCandidate("Pasoori", base, { targetDuration: 290 });
		assert.ok(Math.abs((withClose - without) - 0.3) < 1e-9, `expected +0.3, got ${withClose - without}`);
	});

	await test("scoring: duration more than 60s off subtracts 0.3", () => {
		const without = scoreSaavnCandidate("Pasoori", base, {});
		const far = scoreSaavnCandidate("Pasoori", base, { targetDuration: 120 });
		assert.ok(Math.abs((far - without) - (-0.3)) < 1e-9, `expected -0.3, got ${far - without}`);
	});

	await test("scoring: a (Reprise) title loses 0.4 unless the query asks for it", () => {
		const reprise = { ...base, title: "Pasoori (Reprise)", artist: "JalRaj" };
		const plain = scoreSaavnCandidate("Pasoori", base, {});
		const repr = scoreSaavnCandidate("Pasoori", reprise, {});
		assert.ok(Math.abs((repr - plain) - (-0.4)) < 1e-9, `expected -0.4, got ${repr - plain}`);
		const asked = scoreSaavnCandidate("Pasoori reprise", reprise, {});
		const askedPlain = scoreSaavnCandidate("Pasoori reprise", base, {});
		assert.ok(asked >= askedPlain, "asking for the reprise must not penalise it");
	});

	await test("scoring: cover/remix/karaoke/lofi titles are penalised", () => {
		const plain = scoreSaavnCandidate("Pasoori", base, {});
		// Parenthetical forms isolate the -0.4 (the exact-title bonus
		// survives the paren strip); a bare "Pasoori Cover" also loses
		// the +0.3 exact bonus, so it scores lower still.
		for (const variant of ["Pasoori (Cover)", "Pasoori (Remix)", "Pasoori (Karaoke)", "Pasoori (Lofi)"]) {
			const s = scoreSaavnCandidate("Pasoori", { ...base, title: variant }, {});
			assert.ok(Math.abs((s - plain) - (-0.4)) < 1e-9, `${variant}: expected -0.4, got ${s - plain}`);
		}
		const bare = scoreSaavnCandidate("Pasoori", { ...base, title: "Pasoori Cover" }, {});
		assert.ok(bare < plain - 0.4, `bare cover must lose the penalty AND the exact bonus, got ${bare - plain}`);
	});

	await test("scoring: an Unknown artist loses 0.2", () => {
		const plain = scoreSaavnCandidate("Pasoori", base, {});
		const unknown = scoreSaavnCandidate("Pasoori", { ...base, artist: "Unknown" }, {});
		assert.ok(Math.abs((unknown - plain) - (-0.2)) < 1e-9, `expected -0.2, got ${unknown - plain}`);
	});

	await test("scoring: an empty artist is NOT penalised (Saavn leaves it blank)", () => {
		const plain = scoreSaavnCandidate("Pasoori", base, {});
		const empty = scoreSaavnCandidate("Pasoori", { ...base, artist: "" }, {});
		assert.ok(Math.abs(empty - plain) < 1e-9, `expected no penalty, got ${empty - plain}`);
	});

	await test("scoring: an Artist Title query gives the title-suffix bonus", () => {
		const cand = { title: "Pasoori", artist: "", duration: 0, playCount: 0 };
		const suffix = scoreSaavnCandidate("Ali Sethi Pasoori", cand, {});
		const reversed = scoreSaavnCandidate("Pasoori Ali Sethi", cand, {});
		assert.ok(Math.abs((suffix - reversed) - 0.3) < 1e-9, `expected +0.3, got ${suffix - reversed}`);
		// The suffix bonus lifts a perfect title match above the 0.5
		// searchSaavn threshold (without it the 3-word query caps at 1/3).
		assert.ok(suffix >= 0.5, `artist-prefixed title match must clear 0.5, got ${suffix}`);
	});

	await test("searchSaavn: artist-prefixed query with no original in the results still returns a full-length track", async () => {
		const savedFetch = globalThis.fetch;
		try {
			// Fixture mirrors Saavn's live top results for "Pasoori"
			// (2026-11-14): the reprise is first, the Ali Sethi
			// original is NOT among them, most artists are blank.
			const mk = (title, subtitle, playCount, duration, tag) => ({
				type: "song",
				title,
				subtitle,
				play_count: String(playCount),
				more_info: {
					encrypted_media_url: encryptSaavnUrl(`https://aac.saavncdn.com/${tag}_96.mp4`),
					duration: String(duration),
					"320kbps": "true"
				}
			});
			const results = [
				mk("Pasoori (Reprise)", "JalRaj", 204703, 181, "reprise"),
				mk("Pasoori", "", 2574, 153, "v153"),
				mk("Pasoori", "Angel", 13681, 208, "v208"),
				mk("Pasoori", "", 33, 237, "v237"),
				mk("Pasoori", "Dream Reverb", 92, 221, "v221")
			];
			globalThis.fetch = async () => ({
				ok: true,
				status: 200,
				json: async () => ({ results })
			});
			const song = await searchSaavn("Ali Sethi Pasoori", { targetDuration: 277 });
			assert.ok(song, "must return a song, not null (null falls to the dead YouTube stream)");
			assert.strictEqual(song.title, "Pasoori");
			// Closest full-length non-version track wins (221s, Dream
			// Reverb); the reprise must never win.
			assert.strictEqual(song.duration, 221);
			assert.strictEqual(song.artist, "Dream Reverb");
			assert.ok(song.audioUrl.includes("v221_320.mp4"), `got ${song.audioUrl}`);
		}
		finally {
			globalThis.fetch = savedFetch;
		}
	});

	await test("searchSaavn: with duration=277 the Ali Sethi original beats the JalRaj reprise", async () => {
		const savedFetch = globalThis.fetch;
		try {
			const reprise = {
				type: "song",
				title: "Pasoori (Reprise)",
				subtitle: "JalRaj",
				play_count: "5000000",
				more_info: {
					encrypted_media_url: encryptSaavnUrl("https://aac.saavncdn.com/reprise_96.mp4"),
					duration: "181",
					"320kbps": "true"
				}
			};
			const original = {
				type: "song",
				title: "Pasoori",
				subtitle: "Ali Sethi, Shae Gill",
				play_count: "9000000",
				more_info: {
					encrypted_media_url: encryptSaavnUrl("https://aac.saavncdn.com/original_96.mp4"),
					duration: "277",
					"320kbps": "true"
				}
			};
			// The reprise is listed FIRST (as Saavn returned it live).
			globalThis.fetch = async () => ({
				ok: true,
				status: 200,
				json: async () => ({ results: [reprise, original] })
			});
			const song = await searchSaavn("Pasoori", { targetDuration: 277 });
			assert.ok(song, "a song must be found");
			assert.strictEqual(song.title, "Pasoori");
			assert.match(song.artist, /Ali Sethi/);
			assert.strictEqual(song.duration, 277);
			assert.ok(song.audioUrl.includes("original_320.mp4"), `must pick the original's URL, got ${song.audioUrl}`);
		}
		finally {
			globalThis.fetch = savedFetch;
		}
	});

	await test("searchSaavn: without a duration the version penalty still prefers the original", async () => {
		const savedFetch = globalThis.fetch;
		try {
			const reprise = {
				type: "song",
				title: "Pasoori (Reprise)",
				subtitle: "JalRaj",
				play_count: "5000000",
				more_info: {
					encrypted_media_url: encryptSaavnUrl("https://aac.saavncdn.com/reprise_96.mp4"),
					duration: "181",
					"320kbps": "true"
				}
			};
			const original = {
				type: "song",
				title: "Pasoori",
				subtitle: "Ali Sethi, Shae Gill",
				play_count: "1000000",
				more_info: {
					encrypted_media_url: encryptSaavnUrl("https://aac.saavncdn.com/original_96.mp4"),
					duration: "277",
					"320kbps": "true"
				}
			};
			globalThis.fetch = async () => ({
				ok: true,
				status: 200,
				json: async () => ({ results: [reprise, original] })
			});
			const song = await searchSaavn("Pasoori", {});
			assert.ok(song, "a song must be found");
			assert.strictEqual(song.title, "Pasoori");
			assert.match(song.artist, /Ali Sethi/);
		}
		finally {
			globalThis.fetch = savedFetch;
		}
	});

	const failed = results.filter(r => !r.ok);
	for (const r of results) console.log(`${r.ok ? "  ok " : "FAIL "} - ${r.name}`);
	console.log(`\nsing-api service: ${count}/${results.length} tests passed`);
	if (failed.length) {
		for (const f of failed) console.error("\n" + f.name + ":\n", f.error);
		process.exit(1);
	}
}

main().catch(error => { console.error(error); process.exit(1); });
