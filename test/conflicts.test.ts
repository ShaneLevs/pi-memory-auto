import assert from "node:assert/strict";
import { test } from "node:test";
import { buildConflictHintBlock, describeConflict, findConflictCandidates } from "../src/conflicts.ts";
import type { MemoryEntry } from "../src/types.ts";

function mk(
	id: string,
	tags: string[],
	text: string,
	time = "2026-10-11 19:40:00",
	layer: "global" | "project" = "project",
): { entry: MemoryEntry; file: string } {
	const entry: MemoryEntry = { id, time, project: layer === "project" ? "proj" : "", layer, source: "auto", tags, text };
	return { entry, file: `${layer}/DECISIONS.md` };
}

test("the same requirement with a changed value is a conflict", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["dev-server"], "The dev server listens on port 8080.", "2026-10-02 10:00:00"),
	]);
	assert.equal(found.length, 1);
	const pair = found[0]!;
	assert.equal(pair.older.id, "20261001-aaaa");
	assert.equal(pair.newer.id, "20261002-bbbb");
	assert.deepEqual(pair.divergingNumbers, ["3000", "8080"]);
	assert.deepEqual(pair.shared, ["dev-server"]);
	assert.ok(pair.score > 0.5);
});

test("a rewritten command with no numbers still counts", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["deploy"], "Deploy is done by running the rsync script on the staging host.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["deploy"], "Deploy is done by letting the GitHub Actions workflow push to staging.", "2026-10-02 10:00:00"),
	]);
	assert.equal(found.length, 1);
	assert.equal(found[0]!.newer.id, "20261002-bbbb");
	assert.deepEqual(found[0]!.divergingNumbers, []);
});

test("different facts sharing a keyword are not conflicts", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["deploy"], "Deploy goes through rsync to the staging host."),
		mk("20261002-bbbb", ["deploy"], "The agent must never print secrets in deploy logs."),
	]);
	assert.equal(found.length, 0);
});

test("no shared keyword means no conflict", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000."),
		mk("20261002-bbbb", ["proxy"], "The proxy listens on port 8080."),
	]);
	assert.equal(found.length, 0);
});

test("identical bodies are left to the duplicate layer", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["pnpm"], "Use pnpm for installs.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["pnpm"], "Use pnpm for installs.", "2026-10-02 10:00:00"),
	]);
	assert.equal(found.length, 0);
});

test("a superseded entry is never reported again", () => {
	const dead = mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000.", "2026-10-01 10:00:00");
	dead.entry.supersededBy = "20261002-bbbb";
	const found = findConflictCandidates([dead, mk("20261002-bbbb", ["dev-server"], "The dev server listens on port 8080.", "2026-10-02 10:00:00")]);
	assert.equal(found.length, 0);
});

test("layers are never compared with each other", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["dev-server"], "The dev server listens on port 8080.", "2026-10-02 10:00:00", "global"),
	]);
	assert.equal(found.length, 0);
});

test("newest statement wins even when listed first", () => {
	const found = findConflictCandidates([
		mk("20261002-bbbb", ["deploy"], "Deploy is done by letting the GitHub Actions workflow push to staging.", "2026-10-02 10:00:00"),
		mk("20261001-aaaa", ["deploy"], "Deploy is done by running the rsync script on the staging host.", "2026-10-01 10:00:00"),
	]);
	assert.equal(found[0]!.older.id, "20261001-aaaa");
	assert.equal(found[0]!.newer.id, "20261002-bbbb");
});

test("limitPerLayer caps the hints and ranking is deterministic", () => {
	const entries = [
		mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["dev-server"], "The dev server listens on port 8080.", "2026-10-02 10:00:00"),
		mk("20261003-cccc", ["dev-server"], "The dev server listens on port 9090.", "2026-10-03 10:00:00"),
	];
	const capped = findConflictCandidates(entries, { limitPerLayer: 1 });
	assert.equal(capped.length, 1);
	// Output follows input order; the SET of pairs must not depend on it.
	const signature = (list: ReturnType<typeof findConflictCandidates>) =>
		list.map((c) => `${c.older.id}>${c.newer.id}`).sort();
	assert.deepEqual(signature(findConflictCandidates(entries)), signature(findConflictCandidates([...entries].reverse())));
});

test("describeConflict names both sides and the differing values", () => {
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["dev-server"], "The dev server listens on port 8080.", "2026-10-02 10:00:00"),
	]);
	const line = describeConflict(found[0]!);
	assert.match(line, /shared: dev-server/);
	assert.match(line, /differing values: 3000, 8080/);
	assert.match(line, /older \[20261001-aaaa\]/);
	assert.match(line, /newer \[20261002-bbbb\]/);
});

test("the hint block is empty with no candidates and framed as a hint otherwise", () => {
	assert.equal(buildConflictHintBlock([]), "");
	const found = findConflictCandidates([
		mk("20261001-aaaa", ["dev-server"], "The dev server listens on port 3000.", "2026-10-01 10:00:00"),
		mk("20261002-bbbb", ["dev-server"], "The dev server listens on port 8080.", "2026-10-02 10:00:00"),
	]);
	const block = buildConflictHintBlock(found);
	assert.match(block, /^<possible-conflicts>/);
	assert.match(block, /They are hints, not verdicts/);
	assert.match(block, /SUPERSEDES: <id of the older one>/);
	assert.match(block, /<\/possible-conflicts>$/);
});
