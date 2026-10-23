import assert from "node:assert/strict";
import { test } from "node:test";
import { REVIEW_MONTHS, daysSinceVerified, fileOf, isStale, reviewMonthsFor, summarizeStaleness } from "../src/staleness.ts";
import { formatSearchResult, searchEntries } from "../src/search.ts";
import type { MemoryEntry } from "../src/types.ts";

const NOW = Date.parse("2026-10-01T00:00:00");

function mk(id: string, time: string, layer: "global" | "project" = "project", extra: Partial<MemoryEntry> = {}): MemoryEntry {
	return { id, time, project: layer === "project" ? "proj" : "", layer, source: "auto", tags: ["kw"], text: `body ${id}`, ...extra };
}

const at = (iso: string) => ({ entry: mk(`2026${iso.slice(5, 7)}${iso.slice(8, 10)}-aaaa`, `${iso} 10:00:00`), file: "project/FAILURES.md" });

test("fileOf strips the layer prefix and extension", () => {
	assert.equal(fileOf("project/FAILURES.md"), "FAILURES");
	assert.equal(fileOf("global/USER.md"), "USER");
});

test("per-file review intervals are the documented ones", () => {
	assert.equal(reviewMonthsFor("global/TOOLING.md"), 3);
	assert.equal(reviewMonthsFor("global/USER.md"), 6);
	assert.equal(reviewMonthsFor("project/CONVENTIONS.md"), 6);
	assert.equal(reviewMonthsFor("project/DECISIONS.md"), 12);
	assert.equal(REVIEW_MONTHS.FAILURES, 12);
	// Unknown/legacy labels fall back to the slowest interval, never to zero.
	assert.equal(reviewMonthsFor("project/UNKNOWN.md"), 12);
});

test("staleness is derived from the timestamp, per file interval", () => {
	const tooling = { ...at("2026-05-01"), file: "global/TOOLING.md" };
	assert.equal(isStale(tooling.entry, tooling.file, { now: NOW }), true, "5 months > 3");
	const decisions = { ...at("2026-05-01"), file: "project/DECISIONS.md" };
	assert.equal(isStale(decisions.entry, decisions.file, { now: NOW }), false, "5 months < 12");
});

test("re-confirming refreshes the clock (last wins over time)", () => {
	const entry = mk("20260101-aaaa", "2025-01-01 10:00:00", "project", { last: "2026-09-01 10:00:00" });
	assert.equal(isStale(entry, "project/DECISIONS.md", { now: NOW }), false);
	assert.ok(daysSinceVerified(entry, NOW) >= 29, "one month since the re-confirmation, not since the write");
});

test("superseded entries are never also reported as stale", () => {
	const entry = mk("20250101-aaaa", "2025-01-01 10:00:00", "project", { supersededBy: "20260101-bbbb" });
	assert.equal(isStale(entry, "project/FAILURES.md", { now: NOW }), false);
});

test("an override applies to every file; 0 keeps defaults", () => {
	const tooling = { ...at("2026-08-01"), file: "global/TOOLING.md" };
	assert.equal(isStale(tooling.entry, tooling.file, { now: NOW, reviewMonths: 1 }), true);
	assert.equal(isStale(tooling.entry, tooling.file, { now: NOW, reviewMonths: 0 }), false, "2 months < 3");
});

test("summarizeStaleness counts per file, busiest first", () => {
	const entries = [
		{ entry: mk("20250101-aaaa", "2025-01-01 10:00:00"), file: "project/DECISIONS.md" },
		{ entry: mk("20250102-bbbb", "2025-01-02 10:00:00"), file: "project/DECISIONS.md" },
		{ entry: mk("20250103-cccc", "2025-01-03 10:00:00"), file: "project/CONVENTIONS.md" },
		{ entry: mk("20260901-dddd", "2026-09-01 10:00:00"), file: "project/DECISIONS.md" },
	];
	const summary = summarizeStaleness(entries, "project", { now: NOW });
	assert.equal(summary.total, 3);
	assert.deepEqual(summary.byFile, [
		{ file: "DECISIONS.md", count: 2 },
		{ file: "CONVENTIONS.md", count: 1 },
	]);
});

test("search demotes stale hits below fresh ones and labels them", () => {
	const stale: MemoryEntry = { ...mk("20250101-aaaa", "2025-01-01 10:00:00"), tags: ["deploy"], text: "Deploy with rsync" };
	const fresh: MemoryEntry = { ...mk("20260901-bbbb", "2026-09-01 10:00:00"), tags: ["deploy"], text: "Deploy with rsync now" };
	const data = [
		{ entry: stale, file: "project/FAILURES.md" },
		{ entry: fresh, file: "project/FAILURES.md" },
	];
	const result = searchEntries(data, "tag", "deploy", 1, 10, { now: NOW });
	assert.equal(result.hits[0]!.entry.id, fresh.id, "fresh first even though the stale one is older/equal");
	assert.equal(result.hits[1]!.stale, true);
	assert.equal(result.hits[0]!.stale, undefined);
	const text = formatSearchResult(result, "tag", "deploy");
	assert.match(text, /stale \(\d+d, interval 12mo\) — verify before relying on it/);
});
