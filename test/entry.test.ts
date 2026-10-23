import assert from "node:assert/strict";
import { test } from "node:test";
import { generateEntryId, formatTime, normalizeMemoryText, parseEntries, parseTime, serializeEntry } from "../src/entry.ts";
import type { MemoryEntry } from "../src/types.ts";

const entry: MemoryEntry = {
	id: "20261011-a1b2",
	time: "2026-10-11 19:40:00",
	project: "pi-memory-auto",
	layer: "project",
	source: "user",
	tags: ["decision", "auth"],
	text: "Use URL-prefix versioning for the API.",
};

test("serialize -> parse roundtrip", () => {
	const md = serializeEntry(entry);
	const parsed = parseEntries(md);
	assert.equal(parsed.length, 1);
	const e = parsed[0]!;
	assert.equal(e.id, entry.id);
	assert.equal(e.time, entry.time);
	assert.equal(e.project, entry.project);
	assert.equal(e.layer, "project");
	assert.equal(e.source, "user");
	assert.deepEqual(e.tags, entry.tags);
	assert.equal(e.text, entry.text);
});

test("global entry: project is '-' and layer global", () => {
	const md = serializeEntry({ ...entry, project: "", layer: "global", tags: [] });
	const parsed = parseEntries(md)[0]!;
	assert.equal(parsed.project, "");
	assert.equal(parsed.layer, "global");
	assert.deepEqual(parsed.tags, []);
});

test("multi-line text preserved", () => {
	const md = serializeEntry({ ...entry, text: "line one\nline two" });
	const parsed = parseEntries(md)[0]!;
	assert.equal(parsed.text, "line one\nline two");
});

test("multiple entries + header text ignored", () => {
	const md = `# Notes\n\n${serializeEntry(entry)}Some stray text\n\n${serializeEntry({ ...entry, id: "20261011-c3d4", text: "second" })}`;
	const parsed = parseEntries(md);
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0]!.id, entry.id);
	assert.equal(parsed[1]!.id, "20261011-c3d4");
	assert.equal(parsed[1]!.text, "second");
});

test("tags containing pipe are escaped", () => {
	const md = serializeEntry({ ...entry, tags: ["a|b"] });
	const parsed = parseEntries(md)[0]!;
	assert.deepEqual(parsed.tags, ["a|b"]);
});

test("generateEntryId shape and formatTime/parseTime roundtrip", () => {
	assert.match(generateEntryId(), /^\d{8}-[0-9a-f]{4}$/);
	const now = new Date(2026, 9, 11, 19, 40, 0);
	const t = formatTime(now);
	assert.equal(t, "2026-10-11 19:40:00");
	assert.equal(parseTime(t), now.getTime());
	assert.equal(parseTime("garbage"), 0);
});

test("seen/last roundtrip; absent for a never-reconfirmed entry", () => {
	// seen === 1 leaves the original byte format alone.
	assert.doesNotMatch(serializeEntry(entry), /seen:/);
	const md = serializeEntry({ ...entry, seen: 4, last: "2026-10-24 09:00:00" });
	assert.match(md, /\| seen: 4 \| last: 2026-10-24 09:00:00 -->/);
	const parsed = parseEntries(md)[0]!;
	assert.equal(parsed.seen, 4);
	assert.equal(parsed.last, "2026-10-24 09:00:00");
	assert.equal(parsed.text, entry.text);
});

test("supersedes / superseded-by roundtrip, invalid ids rejected", () => {
	const md = serializeEntry({ ...entry, supersedes: ["20260101-abcd"], supersededBy: "20260202-ef01" });
	assert.match(md, /\| supersedes: 20260101-abcd \| superseded-by: 20260202-ef01/);
	const parsed = parseEntries(md)[0]!;
	assert.deepEqual(parsed.supersedes, ["20260101-abcd"]);
	assert.equal(parsed.supersededBy, "20260202-ef01");

	const bad = parseEntries("<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: - | src: auto | tags: x | superseded-by: garbage -->\nbody\n\n")[0]!;
	assert.equal(bad.supersededBy, undefined, "a malformed replacement id must not de-index the entry");
	const selfRef = parseEntries("<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: - | src: auto | tags: x | supersedes: 20261011-a1b2 -->\nbody\n\n")[0]!;
	assert.equal(selfRef.supersedes, undefined);
});

test("normalizeMemoryText ignores case/whitespace/trailing punctuation only", () => {
	assert.equal(normalizeMemoryText("  Use   PostgreSQL.\n"), normalizeMemoryText("use postgresql"));
	assert.notEqual(normalizeMemoryText("use postgresql"), normalizeMemoryText("use postgres"));
	assert.notEqual(normalizeMemoryText("auth token in env"), normalizeMemoryText("token auth in env"));
});

test("malformed meta gets defaults, empty text dropped", () => {
	// Meta line with no body -> dropped (empty text).
	const md = "<!-- mid: x -->\n\n";
	assert.equal(parseEntries(md).length, 0);
	// Malformed meta followed by other text: the meta line itself becomes an entry header;
	// following prose is its body (tolerant behavior) — here it should produce one entry.
	const md2 = "<!-- mid: x -->\nno meta text here\n";
	assert.equal(parseEntries(md2).length, 1);
	const md3 = `<!-- mid: abc | t: 2026-10-11 19:40:00 | p: - | src: auto | tags: - -->\nhello\n\n`;
	const e = parseEntries(md3)[0]!;
	assert.equal(e.id, "abc");
	assert.equal(e.source, "auto");
	assert.equal(e.layer, "global");
	assert.equal(e.text, "hello");
});
