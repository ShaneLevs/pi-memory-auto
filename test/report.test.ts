import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMemoryReport, wrapKeywords, type ReportLayerStats } from "../src/report.ts";
import type { IndexInput } from "../src/index-map.ts";
import type { MemoryEntry } from "../src/types.ts";

function mk(id: string, tags: string[], text: string, layer: "global" | "project" = "project"): IndexInput {
	const entry: MemoryEntry = { id, time: "2026-10-11 19:40:00", project: layer === "project" ? "proj" : "", layer, source: "auto", tags, text };
	return { entry, file: `${layer}/DECISIONS.md` };
}

const stats = (over: Partial<ReportLayerStats> = {}): ReportLayerStats => ({
	entries: 2,
	keywords: 3,
	sinceLast: 0,
	lastConsolidated: "-",
	...over,
});

/** Fixed clock: the report now includes staleness (staleness.ts), so fixtures
 *  must not age into "stale" years after this file was written. */
const NOW = Date.parse("2026-10-12T00:00:00");
const base = { globalDir: "/g", projectRoot: "/p", threshold: 20, global: stats(), project: stats(), now: NOW };

test("wrapKeywords indents and wraps without exceeding the width", () => {
	const out = wrapKeywords(["#aaaa", "#bbbb", "#cccc", "#dddd"], 20);
	assert.ok(out.startsWith("  #aaaa"));
	for (const line of out.split("\n")) assert.ok(line.length <= 20, line);
	assert.equal(wrapKeywords([], 20), "  (none)");
});

test("report lists both layers, counts and file paths", () => {
	const entries = [mk("20261001-aaaa", ["deploy", "rsync"], "SECRETBODY"), mk("20261002-bbbb", ["macos"], "ALSOBODY", "global")];
	const text = buildMemoryReport(entries, { ...base, projectName: "myrepo" });
	assert.match(text, /^pi-memory-auto · keyword index/);
	assert.match(text, /global — 1 memory · 1 keyword · sinceLast=0\/20/);
	assert.match(text, /project: myrepo — 1 memory · 2 keywords · sinceLast=0\/20/);
	assert.match(text, /#deploy/);
	assert.match(text, /file: \/g\/MEMORY.md/);
	assert.match(text, /file: \/p\/\.pi\/agent\/memory-auto\/MEMORY\.md/);
	assert.ok(!text.includes("SECRETBODY") && !text.includes("ALSOBODY"), "bodies are not shown");
});

test("shared keywords show their count", () => {
	const entries = [mk("20261001-aaaa", ["deploy"], "x"), mk("20261002-bbbb", ["deploy"], "y")];
	const text = buildMemoryReport(entries, base);
	assert.match(text, /#deploy \(2\)/);
});

test("consolidation DUE marker appears at the threshold", () => {
	const text = buildMemoryReport([mk("20261001-aaaa", ["a"], "x")], { ...base, project: stats({ entries: 1, keywords: 1, sinceLast: 20 }) });
	assert.match(text, /sinceLast=20\/20 · consolidation DUE/);
});

test("empty layers are reported, not omitted", () => {
	const text = buildMemoryReport([], base);
	assert.match(text, /global — \(no memories\)/);
	assert.match(text, /project: project — \(no memories\)/);
});

test("caps beyond 200 keywords are surfaced", () => {
	const entries = Array.from({ length: 205 }, (_, i) => mk(`2026100${i % 9}-aa${String(i).padStart(2, "0")}`, [`kw${i}`], `x${i}`));
	const text = buildMemoryReport(entries, base);
	assert.match(text, /5 over the 200-keyword cap/);
});

test("superseded entries are surfaced as a health counter", () => {
	const live = mk("20261002-bbbb", ["postgres"], "use postgres");
	const dead: IndexInput = {
		...mk("20261001-aaaa", ["mysql"], "use mysql"),
		entry: { ...mk("20261001-aaaa", ["mysql"], "use mysql").entry, supersededBy: live.entry.id },
	};
	const text = buildMemoryReport([live, dead], base);
	assert.match(text, /health: 1 superseded \(kept on disk, out of the index\)/);
	assert.doesNotMatch(text, /#mysql/);
});

test("near-duplicate pairs are listed with an actionable command", () => {
	const entries = [
		mk("20261001-aaaa", ["deploy", "rsync"], "Deploy goes through rsync to the staging host."),
		mk("20261002-bbbb", ["deploy", "rsync"], "Deploy uses rsync to reach the staging host."),
	];
	const text = buildMemoryReport(entries, base);
	assert.match(text, /merge candidates \(1\) — \/memory compact project:/);
	assert.match(text, /\[20261001-aaaa\] ↔ \[20261002-bbbb\]/);
	assert.match(text, /shared: deploy, rsync/);
});
