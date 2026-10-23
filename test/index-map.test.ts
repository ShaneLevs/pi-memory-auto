import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_KEYWORDS_PER_LAYER, collectKeywords, renderKeywordTable, buildLayerIndex, buildMemoryIndex, type IndexInput } from "../src/index-map.ts";
import type { MemoryEntry } from "../src/types.ts";

function mk(id: string, tags: string[], text: string, opts: { layer?: "global" | "project"; file?: string; time?: string } = {}): IndexInput {
	const layer = opts.layer ?? "project";
	const entry: MemoryEntry = {
		id,
		time: opts.time ?? "2026-10-11 19:40:00",
		project: layer === "project" ? "proj" : "",
		layer,
		source: "auto",
		tags,
		text,
	};
	return { entry, file: opts.file ?? `${layer}/FAILURES.md` };
}

test("keywords are unique per layer and shared keywords are counted", () => {
	const entries = [
		mk("20261001-aaaa", ["deploy"], "deploy with rsync"),
		mk("20261002-bbbb", ["deploy", "rsync"], "rsync flags"),
	];
	const table = collectKeywords(entries, "project");
	const deploy = table.rows.find((r) => r.key === "deploy");
	assert.equal(deploy?.count, 2);
	assert.equal(table.rows.filter((r) => r.key === "deploy").length, 1);
	assert.equal(table.total, 2);
	assert.equal(table.entryCount, 2);
});

test("spelling variants collapse into one keyword", () => {
	const entries = [
		mk("20261001-aaaa", ["serializeConversation"], "a"),
		mk("20261002-bbbb", ["serialize-conversation"], "b"),
		mk("20261003-cccc", ["Serialize Conversation"], "c"),
	];
	const table = collectKeywords(entries, "project");
	assert.equal(table.rows.length, 1);
	assert.equal(table.rows[0]!.count, 3);
	// Deterministic display: the lexicographically smallest form wins.
	assert.equal(table.rows[0]!.display, "serialize-conversation");
});

test("most-shared keywords rank first, then alphabetical", () => {
	const entries = [
		mk("20261001-aaaa", ["zeta"], "1"),
		mk("20261002-bbbb", ["alpha", "zeta"], "2"),
	];
	const table = collectKeywords(entries, "project");
	assert.deepEqual(table.rows.map((r) => r.key), ["zeta", "alpha"]);
});

test("per-layer cap drops the least-used keywords and reports it", () => {
	const entries = Array.from({ length: MAX_KEYWORDS_PER_LAYER + 5 }, (_, i) =>
		mk(`2026100${i % 9}-aa${String(i).padStart(2, "0")}`, [`kw${i}`], `body ${i}`),
	);
	const table = collectKeywords(entries, "project");
	assert.equal(table.rows.length, MAX_KEYWORDS_PER_LAYER);
	assert.equal(table.total, MAX_KEYWORDS_PER_LAYER + 5);
	assert.equal(table.dropped, 5);
});

test("untagged entries get a derived keyword (never zero)", () => {
	const entries = [mk("20261001-aaaa", [], "call `pnpm install` first")];
	const table = collectKeywords(entries, "project");
	assert.equal(table.rows.length, 1);
	assert.equal(table.derived, 1);
	assert.ok(table.rows[0]!.key.length > 0);
});

test("MEMORY.md entries are not indexed", () => {
	const entries = [mk("20261001-aaaa", ["x"], "body", { file: "project/MEMORY.md" })];
	assert.equal(collectKeywords(entries, "project").entryCount, 0);
	assert.equal(buildLayerIndex(entries, "project", { budget: 500 }).text, "");
});

test("renderKeywordTable respects the budget and reports hidden keywords", () => {
	const rows = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, display: `k${i}`, count: 1 }));
	const { text, hidden, shown } = renderKeywordTable(rows, { budget: 60 });
	assert.ok(text.length < 120);
	assert.ok(shown < 20);
	assert.equal(hidden, 20 - shown);
	assert.match(text, /\(\+\d+ more keywords/);
});

test("header shows layer, memory count and keyword count", () => {
	const entries = [mk("20261001-aaaa", ["a", "b"], "x"), mk("20261002-bbbb", ["b"], "y", { layer: "global" })];
	const text = buildMemoryIndex(entries, { budget: 500, projectName: "myrepo" });
	assert.match(text, /global — 1 memory, 1 keyword/);
	assert.match(text, /project: myrepo — 1 memory, 2 keywords/);
	// Keyword counts are per layer: #b exists once in each layer, not twice.
	assert.equal((text.match(/^#b$/gm) ?? []).length, 2);
	assert.ok(!text.includes("#b (2)"));
});

test("deterministic for identical input", () => {
	const entries = [mk("20261001-aaaa", ["b", "a"], "one"), mk("20261002-bbbb", ["a"], "two")];
	assert.equal(buildMemoryIndex(entries, { budget: 900 }), buildMemoryIndex(entries, { budget: 900 }));
});
