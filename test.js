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
