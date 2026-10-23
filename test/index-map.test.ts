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
	assert.match(text, /\(\+\d+ more — memory_search mode:"keyword"\)/);
});

test("renderKeywordTable packs the overflow inline before dropping keywords", () => {
	// 20 one-word keywords; a 160-char budget holds ~14 counted lines, so without
	// stage 2 six keywords would be dropped. Packed without counts, more fit.
	const rows = Array.from({ length: 20 }, (_, i) => ({ key: `keyword${i}`, display: `keyword${i}`, count: 1 }));
	const tight = renderKeywordTable(rows, { budget: 160 });
	const roomy = renderKeywordTable(rows, { budget: 10_000 });
	const packed = renderKeywordTable(rows, { budget: 200 });
	assert.ok(packed.shown >= tight.shown, "a bigger budget never shows fewer keywords");
	assert.equal(roomy.shown, 20);
	assert.equal(roomy.hidden, 0);
	// The inline run carries no counts.
	const inline = packed.text
		.split("\n")
		.filter(Boolean)
		.find((line) => line.includes(" ") && line.startsWith("#"));
	if (inline) assert.ok(!/\(\d+\)/.test(inline), `inline run has counts: ${inline}`);
});

test("counted lines come first, crowded by count (ranking is untouched by packing)", () => {
	const rows = [
		{ key: "shared", display: "shared", count: 3 },
		{ key: "lonely", display: "lonely", count: 1 },
	];
	const { text } = renderKeywordTable(rows, { budget: 1000 });
	assert.equal(text.split("\n")[0], "#shared (3)");
	assert.equal(text.split("\n")[1], "#lonely");
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

test("legacy space-separated tags become individual keywords, not one blob", () => {
	// Pre-0.5 data: the whole "#a #b #c" string was stored as a single tag.
	const entries = [
		mk("20261001-aaaa", ["#svg #antd-icons #qlmanage"], "icons"),
		mk("20261002-bbbb", ["svg"], "more icons"),
	];
	const table = collectKeywords(entries, "project");
	const displays = table.rows.map((r) => r.display);
	assert.ok(displays.includes("svg"), "#svg is its own keyword");
	assert.ok(displays.includes("antd-icons"));
	assert.ok(displays.includes("qlmanage"));
	assert.ok(!table.rows.some((r) => r.key.length > 24), "no unsearchable blob keyword");
	assert.equal(table.rows.find((r) => r.key === "svg")?.count, 2);
});

test("an entry with only invalid tags still contributes a derived keyword", () => {
	const entries = [mk("20261001-aaaa", ["一二三四五六七八九"], "call `pnpm install`")];
	const table = collectKeywords(entries, "project");
	assert.equal(table.entryCount, 1);
	assert.equal(table.derived, 1);
	assert.equal(table.rows[0]!.key, "pnpm");
});

test("a superseded entry keeps its row but contributes no keywords", () => {
	const fix = mk("20261005-eeee", ["postgres"], "use postgres");
	const dead: IndexInput = {
		...mk("20261001-aaaa", ["deploy", "rsync"], "deploy with rsync"),
		entry: { ...mk("20261001-aaaa", ["deploy", "rsync"], "deploy with rsync").entry, supersededBy: fix.entry.id },
	};
	const table = collectKeywords([dead, fix], "project");
	assert.equal(table.superseded, 1);
	assert.equal(table.entryCount, 2, "the row still exists on disk");
	assert.deepEqual(
		table.rows.map((r) => r.key),
		["postgres"],
		"the replaced entry's keywords leave the index",
	);
	const index = buildLayerIndex([dead, fix], "project", { budget: 3000 });
	assert.doesNotMatch(index.text, /deploy|rsync/);
});
