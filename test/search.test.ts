import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSearchResult, searchEntries as searchEntriesAt, tokenize } from "../src/search.ts";
import type { LoadedEntry } from "../src/search.ts";
import type { MemoryEntry, SearchMode } from "../src/types.ts";

/** Every search in this file runs on a fixed clock, so the staleness feature
 *  (staleness.ts) cannot make these fixtures expire years after they were written. */
const NOW = Date.parse("2026-04-01T00:00:00");
function searchEntries(all: LoadedEntry[], mode: SearchMode, query: string, page: number, pageSize: number, opts: { reviewMonths?: number } = {}) {
	return searchEntriesAt(all, mode, query, page, pageSize, { now: NOW, ...opts });
}

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

test("tokenize splits on whitespace/punctuation and drops stopwords", () => {
	assert.deepEqual(tokenize("how do I fix the XSS?"), ["fix", "xss"]);
	assert.deepEqual(tokenize("#pnpm, #ci"), ["pnpm", "ci"]);
	// Chinese words survive; single CJK chars are meaningful
	assert.deepEqual(tokenize("部署 检查"), ["部署", "检查"]);
});

test("keyword mode: multi-word query matches on ANY token (the old regex bug)", () => {
	// Previously compiled as one regex → zero hits. Now "xss" matches.
	const r = searchEntries(data, "keyword", "tokens xss vulnerability", 1, 10);
	assert.equal(r.fallback, false);
	assert.equal(r.hits[0]!.entry.id, "20260101-aaaa");
});

test("keyword mode ranks by coverage (more matched tokens first)", () => {
	const r = searchEntries(data, "keyword", "pnpm frozen-lockfile", 1, 10);
	assert.equal(r.hits[0]!.entry.id, "20260301-cccc"); // matches both tokens
	assert.equal(r.total, 2); // the other pnpm entry still matches one token
});

test("keyword mode auto-detects an entry id query", () => {
	const r = searchEntries(data, "keyword", "20260201-bbbb", 1, 10);
	assert.equal(r.total, 1);
	assert.equal(r.hits[0]!.entry.id, "20260201-bbbb");
});

test("id mode returns exactly one entry", () => {
	const r = searchEntries(data, "id", "20260301-cccc", 1, 10);
	assert.equal(r.total, 1);
	assert.equal(r.fallback, false);
	assert.equal(searchEntries(data, "id", "nope", 1, 10).total, 0);
});

test("unmatched keyword falls back to newest entries instead of an empty result", () => {
	const r = searchEntries(data, "keyword", "完全无关的中文关键词", 1, 10);
	assert.equal(r.fallback, true);
	assert.equal(r.total, 3);
	assert.equal(r.hits[0]!.entry.id, "20260301-cccc");
	const text = formatSearchResult(r, "keyword", "完全无关的中文关键词");
	assert.match(text, /No memory matched/);
	assert.match(text, /most recent/);
});

test("fallback lists the current project's memories before global ones", () => {
	const mixed = [
		{ ...mk("20260101-aaaa", "2026-01-01 10:00:00", "old global note"), file: "global/LESSONS.md" },
		{ ...mk("20260301-cccc", "2026-03-01 10:00:00", "newer project note"), file: "project/DECISIONS.md" },
	];
	const r = searchEntries(mixed, "keyword", "zzz-nothing-matches", 1, 10);
	assert.equal(r.fallback, true);
	assert.equal(r.hits[0]!.file, "project/DECISIONS.md");
});

test("tag mode matches any wanted tag, tolerating '#' and substrings", () => {
	assert.equal(searchEntries(data, "tag", "pnpm", 1, 10).total, 2);
	assert.equal(searchEntries(data, "tag", "#ci", 1, 10).total, 1);
	assert.equal(searchEntries(data, "tag", "convent", 1, 10).total, 1);
});

test("recent mode sorts by time desc", () => {
	const r = searchEntries(data, "recent", "", 1, 10);
	assert.deepEqual(r.hits.map((h) => h.entry.id), ["20260301-cccc", "20260201-bbbb", "20260101-aaaa"]);
});

test("all mode fuses keyword + tag + recency", () => {
	const r = searchEntries(data, "all", "pnpm", 1, 10);
	assert.ok(r.total >= 2);
	assert.equal(r.hits[0]!.entry.id, "20260301-cccc");
	assert.equal(searchEntries(data, "all", "", 1, 10).total, 3);
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

test("formatSearchResult handles an empty store", () => {
	const text = formatSearchResult(searchEntries([], "keyword", "zzz", 1, 10), "keyword", "zzz");
	assert.match(text, /No memories stored yet/);
});

test("superseded entries never outrank a live memory and are labeled", () => {
	const live = mk("20261002-bbbb", "2026-10-02 10:00:00", "Use PostgreSQL for JSON support", ["db"]);
	const dead: { entry: MemoryEntry; file: string } = {
		...mk("20261001-aaaa", "2026-10-01 10:00:00", "Use MySQL for the store", ["db"]),
		entry: { ...mk("20261001-aaaa", "2026-10-01 10:00:00", "Use MySQL for the store", ["db"]).entry, supersededBy: live.entry.id },
	};
	const r = searchEntries([dead, live], "tag", "db", 1, 10);
	assert.equal(r.hits.length, 2);
	assert.equal(r.hits[0]!.entry.id, live.entry.id);
	assert.equal(r.hits[1]!.entry.id, dead.entry.id, "still retrievable");
	const text = formatSearchResult(r, "tag", "db");
	assert.match(text, /superseded by \[20261002-bbbb\]/);
});
