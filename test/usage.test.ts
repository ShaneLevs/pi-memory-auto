import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { RECALL_CAP, creditRecalls, loadUsage, parseUsage, recalledByLayer, recordRecalls, usagePath } from "../src/usage.ts";
import { FileMutex } from "../src/store.ts";
import { collectKeywords } from "../src/index-map.ts";
import { searchEntries } from "../src/search.ts";
import type { MemoryEntry, SearchResult } from "../src/types.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pma-usage-"));
const tmpDirs: string[] = [tmp];
after(async () => {
	for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

function mk(id: string, tags: string[], text: string, layer: "global" | "project" = "project"): { entry: MemoryEntry; file: string } {
	const entry: MemoryEntry = { id, time: "2026-10-11 19:40:00", project: layer === "project" ? "proj" : "", layer, source: "auto", tags, text };
	return { entry, file: `${layer}/DECISIONS.md` };
}

test("parseUsage: garbage, negative and non-object payloads read as no data", () => {
	assert.deepEqual(parseUsage(""), {});
	assert.deepEqual(parseUsage("not json"), {});
	assert.deepEqual(parseUsage('{"v":1}'), {});
	assert.deepEqual(parseUsage('{"recalls":{"a":-1,"b":0,"c":2,"d":"x"}}'), { c: 2 });
	// Above the cap is clamped on read, so a hand-edited file cannot skew ranking.
	assert.deepEqual(parseUsage(`{"recalls":{"a":${RECALL_CAP + 99}}}`), { a: RECALL_CAP });
});

test("creditRecalls normalizes keys, caps per key and keeps the rest", () => {
	const once = creditRecalls({ old: 3 }, ["Deploy Thing", "deploy-thing", "deploy thing"]);
	assert.equal(once.old, 3);
	// All three spellings collapse to one canonical key.
	assert.equal(once.deploything, 3);
	let capped: Record<string, number> = {};
	for (let i = 0; i < RECALL_CAP + 5; i++) capped = creditRecalls(capped, ["hot"]);
	assert.equal(capped.hot, RECALL_CAP);
});

test("recordRecalls persists per layer and accumulates across calls", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-usage-rec-"));
	tmpDirs.push(root);
	const deps = { globalDir: path.join(root, "g"), projectRoot: path.join(root, "p"), mutex: new FileMutex() };

	await Promise.all([recordRecalls("project", ["deploy"], deps), recordRecalls("project", ["deploy", "rsync"], deps)]);
	const loaded = await loadUsage(deps.globalDir, deps.projectRoot);
	assert.equal(loaded.project.deploy, 2);
	assert.equal(loaded.project.rsync, 1);
	assert.deepEqual(loaded.global, {});

	const raw = await fs.readFile(usagePath("project", deps.globalDir, deps.projectRoot), "utf8");
	assert.match(raw, /"v": 1/);
	assert.match(raw, /"updated":/);
});

test("recordRecalls with no keys writes nothing", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-usage-empty-"));
	tmpDirs.push(root);
	const deps = { globalDir: path.join(root, "g"), projectRoot: path.join(root, "p"), mutex: new FileMutex() };
	await recordRecalls("global", [], deps);
	assert.equal(await fs.stat(usagePath("global", deps.globalDir, deps.projectRoot)).then(() => true, () => false), false);
});

test("recalledByLayer credits only keywords the query actually used", () => {
	const data = [
		mk("20260101-aaaa", ["deploy", "rsync"], "Deploy goes through rsync", "project"),
		mk("20260102-bbbb", ["pnpm"], "Use pnpm", "global"),
	];
	const result: SearchResult = searchEntries(data, "tag", "deploy", 1, 10);
	const credited = recalledByLayer(result, "tag");
	assert.deepEqual(credited.project, ["deploy"]);
	assert.deepEqual(credited.global, [], "rsync was not in the query");

	assert.deepEqual(recalledByLayer(searchEntries(data, "tag", "nothing-here", 1, 10), "tag"), { global: [], project: [] });
	// `recent` is a listing, not a match: it must not inflate the counters.
	assert.deepEqual(recalledByLayer(searchEntries(data, "recent", "", 1, 10), "recent"), { global: [], project: [] });
});

test("usage lifts a recalled keyword above a merely shared one in the index", () => {
	const entries = [
		mk("20260101-aaaa", ["deploy"], "d1"),
		mk("20260102-bbbb", ["rsync"], "r1"),
		mk("20260103-cccc", ["rsync"], "r2"),
		mk("20260104-dddd", ["rsync"], "r3"),
	];
	const plain = collectKeywords(entries, "project");
	assert.deepEqual(
		plain.rows.map((r) => r.key),
		["rsync", "deploy"],
		"without usage, the most-shared keyword leads",
	);
	const used = collectKeywords(entries, "project", { usage: { deploy: 4 } });
	assert.deepEqual(
		used.rows.map((r) => r.key),
		["deploy", "rsync"],
		"a keyword that keeps finding things outranks a shared one",
	);
});
