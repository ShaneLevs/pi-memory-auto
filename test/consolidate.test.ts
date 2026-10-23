import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	buildConsolidationPrompt,
	parseConsolidationPlan,
	runConsolidation,
	type ConsolidationDeps,
} from "../src/consolidate.ts";
import { loadAllEntries } from "../src/search.ts";
import { FileMutex, ProcessLock } from "../src/store.ts";
import type { MemoryEntry } from "../src/types.ts";

function meta(id: string, tags: string, project = "proj", time = "2026-10-11 19:40:00"): string {
	return `<!-- mid: ${id} | t: ${time} | p: ${project} | src: auto | tags: ${tags} -->\n`;
}

async function setup(): Promise<{ globalDir: string; projectRoot: string; deps: ConsolidationDeps }> {
	const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mem-con-g-"));
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mem-con-p-"));
	const dir = path.join(projectRoot, ".pi", "agent", "memory-auto");
	await fs.mkdir(dir, { recursive: true });
	return {
		globalDir,
		projectRoot,
		deps: { globalDir, projectRoot, mutex: new FileMutex(), plock: new ProcessLock(globalDir), llmMaxTokens: 4096 },
	};
}

function entry(id: string, tags: string[], text: string, layer: "global" | "project" = "project"): { entry: MemoryEntry; file: string } {
	return {
		entry: { id, time: "2026-10-11 19:40:00", project: layer === "project" ? "proj" : "", layer, source: "auto", tags, text },
		file: `${layer}/DECISIONS.md`,
	};
}

function fakeRegistry(text: string) {
	return {
		complete: async () => ({ content: [{ type: "text", text }], stopReason: "stop" }),
	};
}

test("prompt lists ids, layers, keywords and bodies", () => {
	const prompt = buildConsolidationPrompt([entry("20261001-aaaa", ["pnpm"], "use pnpm")]);
	assert.match(prompt, /\[20261001-aaaa\] project project\/DECISIONS\.md \| keywords: pnpm/);
	assert.match(prompt, /use pnpm/);
});

test("parseConsolidationPlan accepts a valid merge and rename", () => {
	const byId = new Map([entry("20261001-aaaa", ["a"], "x").entry, entry("20261002-bbbb", ["b"], "y").entry].map((e) => [e.id, e]));
	const plan = parseConsolidationPlan(
		`===MERGE===
KEEP: 20261001-aaaa
DROP: 20261002-bbbb
TAGS: merged,keyword

===RENAME===
FROM: serializeConversation
TO: serialize-conversation`,
		byId,
	);
	assert.equal(plan.merges.length, 1);
	assert.deepEqual(plan.merges[0]!.dropIds, ["20261002-bbbb"]);
	assert.deepEqual(plan.merges[0]!.tags, ["merged", "keyword"]);
	assert.deepEqual(plan.keywordRenames, [{ from: "serializeConversation", to: "serialize-conversation" }]);
});

test("parseConsolidationPlan rejects unknown ids, self-merges, cross-layer and bad keywords", () => {
	const byId = new Map(
		[
			entry("20261001-aaaa", ["a"], "x").entry,
			entry("20261002-bbbb", ["b"], "y", "global").entry,
			entry("20261003-cccc", ["c"], "z").entry,
		].map((e) => [e.id, e]),
	);
	const plan = parseConsolidationPlan(
		`===MERGE===
KEEP: 20261001-aaaa
DROP: 20261002-bbbb, 99999999-zzzz, 20261001-aaaa

===MERGE===
KEEP: missing-id
DROP: 20261003-cccc

===RENAME===
FROM: ok
TO: 一二三四五六七八九`,
		byId,
	);
	assert.equal(plan.merges.length, 0); // cross-layer drop + self drop + unknown → nothing usable
	assert.equal(plan.keywordRenames.length, 0);
});

test("NOTHING_TO_MERGE leaves the store untouched", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.writeFile(file, `${meta("20261001-aaaa", "a")}one\n\n${meta("20261002-bbbb", "b")}two\n\n`, "utf8");
	const before = await fs.readFile(file, "utf8");
	const entries = await loadAllEntries(globalDir, projectRoot);
	const result = await runConsolidation(deps, entries, {}, fakeRegistry("NOTHING_TO_MERGE"));
	assert.equal(result.noop, true);
	assert.equal(await fs.readFile(file, "utf8"), before);
});

test("a merge drops the duplicate, rewrites the survivor and keeps a .bak", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.writeFile(
		file,
		`${meta("20261001-aaaa", "deploy", "proj", "2026-10-01 10:00:00")}Deploy with rsync.\n\n${meta("20261002-bbbb", "deploy,rsync", "proj", "2026-10-02 10:00:00")}Deploy with rsync --delete.\n\n`,
		"utf8",
	);
	const entries = await loadAllEntries(globalDir, projectRoot);
	const response = `===MERGE===
KEEP: 20261002-bbbb
DROP: 20261001-aaaa
TEXT: Deploy with rsync --delete.
TAGS: deploy,rsync`;
	const result = await runConsolidation(deps, entries, {}, fakeRegistry(response));
	assert.equal(result.noop, false);
	assert.equal(result.removed, 1);
	assert.equal(result.updated, 1);

	const raw = await fs.readFile(file, "utf8");
	assert.ok(!raw.includes("20261001-aaaa"));
	assert.ok(raw.includes("20261002-bbbb"));
	assert.ok(raw.includes("Deploy with rsync --delete."));
	assert.equal((await fs.readdir(path.join(projectRoot, ".pi/agent/memory-auto"))).filter((f) => f.endsWith(".bak")).length, 1);

	const after = await loadAllEntries(globalDir, projectRoot);
	assert.equal(after.length, 1);
});

test("keyword renames apply across the layer and never leave a memory keyword-less", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.writeFile(
		file,
		`${meta("20261001-aaaa", "serializeConversation")}a\n\n${meta("20261002-bbbb", "serialize-conversation,other")}b\n\n`,
		"utf8",
	);
	const entries = await loadAllEntries(globalDir, projectRoot);
	const response = `===RENAME===
FROM: serializeConversation
TO: serialize-conversation`;
	const result = await runConsolidation(deps, entries, {}, fakeRegistry(response));
	assert.equal(result.noop, false);
	const after = await loadAllEntries(globalDir, projectRoot);
	const keys = after.flatMap((e) => e.entry.tags);
	assert.ok(keys.every((k) => k === "serialize-conversation" || k === "other"));
	assert.equal(after.length, 2);
});

test("LLM failure leaves the store untouched (no-op)", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.writeFile(file, `${meta("20261001-aaaa", "a")}one\n\n${meta("20261002-bbbb", "b")}two\n\n`, "utf8");
	const before = await fs.readFile(file, "utf8");
	const entries = await loadAllEntries(globalDir, projectRoot);
	const failing = { complete: async () => ({ content: [], stopReason: "error" }) };
	const result = await runConsolidation(deps, entries, {}, failing);
	assert.equal(result.noop, true);
	assert.equal(await fs.readFile(file, "utf8"), before);
});
