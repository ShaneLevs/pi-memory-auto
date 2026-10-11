import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSearchResult, searchEntries } from "../src/search.ts";
import type { MemoryEntry } from "../src/types.ts";

function mk(id: string, time: string, text: string, tags: string[] = []): { entry: MemoryEntry; file: string } {
	return {
		entry: { id, time, project: "p", layer: "project", source: "user", tags, text },
		file: "project/FAILURES.md",
	};
}

const data = [
	mk("20260101-aaaa", "2026-01-01 10:00:00", "localStorage tokens cause XSS", ["security"]),
	mk("20260201-bbbb", "2026-02-01 10:00:00", "Use pnpm in this repo", ["pnpm", "convention"]),
	mk("20260301-cccc", "2026-03-01 10:00:00", "CI needs --frozen-lockfile", ["ci", "pnpm"]),
];

test("keyword mode matches regex, case-insensitive", () => {
	const r = searchEntries(data, "keyword", "xss", 1, 10);
	assert.equal(r.total, 1);
	assert.equal(r.hits[0]!.entry.id, "20260101-aaaa");
	// regex mode
	const r2 = searchEntries(data, "keyword", "pnpm|npm", 1, 10);
	assert.equal(r2.total, 2);
	// invalid regex falls back to substring
	const r3 = searchEntries(data, "keyword", "([", 1, 10);
	assert.equal(r3.total, 0);
});

test("tag mode matches any wanted tag", () => {
	const r = searchEntries(data, "tag", "pnpm", 1, 10);
	assert.equal(r.total, 2);
	const r2 = searchEntries(data, "tag", "#ci", 1, 10);
	assert.equal(r2.total, 1);
});

test("recent mode sorts by time desc", () => {
	const r = searchEntries(data, "recent", "", 1, 10);
	assert.deepEqual(r.hits.map((h) => h.entry.id), ["20260301-cccc", "20260201-bbbb", "20260101-aaaa"]);
});

test("all mode fuses keyword + tag + recency", () => {
	const r = searchEntries(data, "all", "pnpm", 1, 10);
	assert.ok(r.total >= 2);
	assert.equal(r.hits[0]!.entry.id, "20260301-cccc"); // newer + tag match
	// empty query returns everything
	const r2 = searchEntries(data, "all", "", 1, 10);
	assert.equal(r2.total, 3);
});

test("pagination", () => {
	const p1 = searchEntries(data, "recent", "", 1, 2);
	assert.equal(p1.hits.length, 2);
	assert.equal(p1.total, 3);
	assert.equal(p1.hasMore, true);
	const p2 = searchEntries(data, "recent", "", 2, 2);
	assert.equal(p2.hits.length, 1);
	assert.equal(p2.hasMore, false);
});

test("formatSearchResult includes metadata and pagination hint", () => {
	const r = searchEntries(data, "tag", "ci", 1, 10);
	const text = formatSearchResult(r, "tag", "ci");
	assert.match(text, /\[20260301-cccc\]/);
	assert.match(text, /project\/FAILURES\.md/);
	assert.match(text, /tags: ci,pnpm/);
	assert.match(text, /no more pages/);
});

test("empty result message", () => {
	const text = formatSearchResult(searchEntries(data, "keyword", "zzz", 1, 10), "keyword", "zzz");
	assert.match(text, /No memories found/);
});
