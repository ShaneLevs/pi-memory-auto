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

// ── Pagination: the whole store must be examined, not just the newest page ──

/** Write `count` entries with descending times so entry 0 is the newest. */
async function writeMany(file: string, count: number): Promise<void> {
	const blocks: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = `2026${String(i).padStart(4, "0")}-aaaa`;
		const minutes = String(59 - (i % 60)).padStart(2, "0");
		const hours = String(23 - Math.floor(i / 60)).padStart(2, "0");
		blocks.push(`${meta(id, `kw${i}`, "proj", `2026-10-11 ${hours}:${minutes}:00`)}body ${i}\n\n`);
	}
	await fs.writeFile(file, blocks.join(""), "utf8");
}

/** Records every prompt sent, replies NOTHING_TO_MERGE. */
function recordingRegistry() {
	const prompts: string[] = [];
	return {
		prompts,
		registry: {
			complete: async (_m: unknown, context: unknown) => {
				prompts.push(JSON.stringify(context));
				return { content: [{ type: "text", text: "NOTHING_TO_MERGE" }], stopReason: "stop" };
			},
		},
	};
}

test("entries beyond the per-call limit are examined in further rounds, not skipped", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	// 130 entries: an old fixed limit of 120 would silently drop the oldest 10.
	await writeMany(file, 130);
	const entries = await loadAllEntries(globalDir, projectRoot);
	assert.equal(entries.length, 130);

	const { prompts, registry } = recordingRegistry();
	const result = await runConsolidation(deps, entries, {}, registry);

	assert.equal(result.rounds, 2);
	assert.equal(prompts.length, 2);
	// Every entry appears in exactly one of the prompts.
	for (let i = 0; i < 130; i++) {
		const id = `2026${String(i).padStart(4, "0")}-aaaa`;
		const seen = prompts.filter((p) => p.includes(id)).length;
		assert.equal(seen, 1, `${id} appeared ${seen} times`);
	}
	assert.equal(result.noop, true);
});

test("a merge on page 1 is re-read before page 2 so ids stay consistent", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	// 122 entries: page 1 = 120 newest, page 2 = the 2 oldest.
	await writeMany(file, 122);
	const entries = await loadAllEntries(globalDir, projectRoot);

	let call = 0;
	const registry = {
		complete: async () => {
			call++;
			// First page: merge the two newest entries into one.
			if (call === 1) {
				return {
					content: [{ type: "text", text: "===MERGE===\nKEEP: 20260000-aaaa\nDROP: 20260001-aaaa" }],
					stopReason: "stop",
				};
			}
			return { content: [{ type: "text", text: "NOTHING_TO_MERGE" }], stopReason: "stop" };
		},
	};
	const result = await runConsolidation(deps, entries, {}, registry);
	assert.equal(result.removed, 1);
	assert.equal(result.rounds, 2); // still reached page 2 after the merge

	const after = await loadAllEntries(globalDir, projectRoot);
	assert.equal(after.length, 121);
});

test("a failed call stops the pass instead of hammering the provider", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await writeMany(file, 200);
	const entries = await loadAllEntries(globalDir, projectRoot);
	let calls = 0;
	const failing = {
		complete: async () => {
			calls++;
			return { content: [], stopReason: "error" };
		},
	};
	const result = await runConsolidation(deps, entries, {}, failing);
	assert.equal(calls, 1);
	assert.equal(result.rounds, 1);
	assert.equal(result.noop, true);
});
