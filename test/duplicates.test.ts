import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCandidate, findDuplicateCandidates, jaccard, textTokens } from "../src/duplicates.ts";
import type { MemoryEntry } from "../src/types.ts";

function mk(id: string, tags: string[], text: string, layer: "global" | "project" = "project"): { entry: MemoryEntry; file: string } {
	const entry: MemoryEntry = { id, time: "2026-10-11 19:40:00", project: layer === "project" ? "proj" : "", layer, source: "auto", tags, text };
	return { entry, file: `${layer}/DECISIONS.md` };
}

test("identical bodies are a 100% candidate", () => {
	const found = findDuplicateCandidates([mk("20261001-aaaa", ["pnpm"], "Use pnpm for installs."), mk("20261002-bbbb", ["npm"], "use pnpm for installs")]);
	assert.equal(found.length, 1);
	assert.equal(found[0]!.score, 1);
	assert.equal(found[0]!.a.id, "20261001-aaaa");
});

test("reworded duplicates are found", () => {
	const found = findDuplicateCandidates([
		mk("20261001-aaaa", ["deploy", "rsync"], "Deploy goes through rsync to the staging host."),
		mk("20261002-bbbb", ["deploy", "rsync"], "Deploy uses rsync to reach the staging host."),
	]);
	assert.equal(found.length, 1);
	assert.ok(found[0]!.score >= 0.5);
	assert.deepEqual(found[0]!.shared, ["deploy", "rsync"]);
});

test("different facts about the same subsystem are not candidates", () => {
	const found = findDuplicateCandidates([
		mk("20261001-aaaa", ["deploy", "rsync"], "Deploy goes through rsync to the staging host."),
		mk("20261002-bbbb", ["deploy", "rsync"], "The staging host has 4GB of RAM and no swap."),
	]);
	assert.equal(found.length, 0);
});

test("layers are never compared with each other", () => {
	const found = findDuplicateCandidates([
		mk("20261001-aaaa", ["pnpm"], "Use pnpm for installs."),
		mk("20261002-bbbb", ["pnpm"], "Use pnpm for installs.", "global"),
	]);
	assert.equal(found.length, 0);
});

test("numbers are significant: differing ports are not the same memory", () => {
	const found = findDuplicateCandidates([mk("20261001-aaaa", ["port"], "Dev server listens on port 80"), mk("20261002-bbbb", ["port"], "Dev server listens on port 81")]);
	assert.equal(found.length, 0);
});

test("Chinese text is compared as bigrams", () => {
	const a = textTokens("优先使用 pnpm 安装依赖");
	assert.ok(a.has("安装") && a.has("依赖"));
	assert.ok(jaccard(a, textTokens("安装依赖请用 pnpm")) > 0.4);
	const found = findDuplicateCandidates([mk("20261001-aaaa", ["依赖", "pnpm"], "优先使用 pnpm 安装依赖"), mk("20261002-bbbb", ["依赖", "pnpm"], "安装依赖请用 pnpm")]);
	assert.equal(found.length, 1);
});

test("limit keeps the best pairs and output is deterministic", () => {
	const entries = [
		mk("20261001-aaaa", ["a"], "the build script runs tsc before bundling"),
		mk("20261002-bbbb", ["a"], "the build script runs tsc before bundling"),
		mk("20261003-cccc", ["a"], "the build script runs tsc before the bundling step"),
		mk("20261004-dddd", ["b"], "unrelated note about database pooling"),
	];
	const all = findDuplicateCandidates(entries);
	const capped = findDuplicateCandidates(entries, { limit: 1 });
	assert.equal(capped.length, 1);
	assert.equal(capped[0]!.score, all[0]!.score);
	assert.deepEqual(findDuplicateCandidates(entries), all);
});

test("describeCandidate reports both ids, the score and a snippet", () => {
	const [candidate] = findDuplicateCandidates([mk("20261001-aaaa", ["deploy", "rsync"], "Deploy goes through rsync to staging."), mk("20261002-bbbb", ["deploy", "rsync"], "Deploy goes through rsync to staging host.")]);
	const line = describeCandidate(candidate!, 20);
	assert.match(line, /\[20261001-aaaa\] ↔ \[20261002-bbbb\] \d+%/);
	assert.match(line, /shared: deploy, rsync/);
	assert.ok(line.includes("…"), "long bodies are truncated");
});
