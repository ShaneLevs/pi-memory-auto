import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { parseEntries } from "../src/entry.ts";
import { MAX_KEYWORDS } from "../src/keywords.ts";
import {
	REKEY_BATCH_SIZE,
	buildRekeyPrompt,
	parseRekeyResponse,
	runKeywordRekey,
} from "../src/rekey.ts";
import { loadAllEntries } from "../src/search.ts";
import { FileMutex, ProcessLock } from "../src/store.ts";
import type { MemoryEntry } from "../src/types.ts";

const tmpDirs: string[] = [];
after(async () => {
	for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

function meta(id: string, tags: string, project = "proj", time = "2026-10-11 19:40:00"): string {
	return `<!-- mid: ${id} | t: ${time} | p: ${project} | src: auto | tags: ${tags} -->\n`;
}

function entry(id: string, tags: string[], text: string, layer: "global" | "project" = "project"): { entry: MemoryEntry; file: string } {
	return {
		entry: { id, time: "2026-10-11 19:40:00", project: layer === "project" ? "proj" : "", layer, source: "auto", tags, text },
		file: `${layer}/DECISIONS.md`,
	};
}

function fakeRegistry(text: string | ((prompt: string) => string)) {
	return {
		complete: async (_model: unknown, context: unknown) => {
			const prompt = JSON.stringify(context);
			const out = typeof text === "function" ? text(prompt) : text;
			return { content: [{ type: "text", text: out }], stopReason: "stop" };
		},
	};
}

async function setup() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-rekey-"));
	tmpDirs.push(root);
	const globalDir = path.join(root, "global");
	const projectRoot = path.join(root, "proj");
	await fs.mkdir(path.join(projectRoot, ".pi/agent/memory-auto"), { recursive: true });
	await fs.mkdir(globalDir, { recursive: true });
	const deps = { globalDir, projectRoot, mutex: new FileMutex(), plock: new ProcessLock(globalDir), llmMaxTokens: 2048 };
	return { globalDir, projectRoot, deps };
}

test("buildRekeyPrompt shows ids, current keywords and truncated bodies", () => {
	const long = "x".repeat(5000);
	const prompt = buildRekeyPrompt([entry("20261001-aaaa", ["#a", "#b"], long)]);
	assert.match(prompt, /\[20261001-aaaa\] project · project\/DECISIONS\.md/);
	assert.match(prompt, /current keywords: #a, #b/);
	assert.ok(prompt.length < 3000, "body is truncated");
});

test("parseRekeyResponse accepts plain lines, tolerates bullets and brackets", () => {
	const byId = new Map([entry("20261001-aaaa", ["old"], "x").entry, entry("20261002-bbbb", ["old"], "y").entry].map((e) => [e.id, e]));
	const parsed = parseRekeyResponse(
		["- [20261001-aaaa] | deploy, rsync", "* 20261002-bbbb | serialize-conversation", "20261003-zzzz | nope"].join("\n"),
		byId,
	);
	assert.deepEqual(parsed.updates, [
		{ id: "20261001-aaaa", keywords: ["deploy", "rsync"] },
		{ id: "20261002-bbbb", keywords: ["serialize-conversation"] },
	]);
	assert.deepEqual(parsed.rejected, []);
});

test("parseRekeyResponse drops unknown ids and caps at 3 keywords", () => {
	const byId = new Map([entry("20261001-aaaa", [], "x").entry].map((e) => [e.id, e]));
	const parsed = parseRekeyResponse("20261001-aaaa | a1, a2, a3, a4\n20269999-zzzz | ghost", byId);
	assert.equal(parsed.updates.length, 1);
	assert.equal(parsed.updates[0]!.keywords.length, MAX_KEYWORDS);
	assert.deepEqual(parsed.rejected, []);
});

test("parseRekeyResponse reports unusable keyword lists instead of silently accepting them", () => {
	const byId = new Map([entry("20261001-aaaa", ["old"], "x").entry].map((e) => [e.id, e]));
	const parsed = parseRekeyResponse("20261001-aaaa | 一二三四五六七八九\n20261001-aaaa | deploy", byId);
	// First line rejected (9 CJK chars); the duplicate id on the second line is
	// ignored because the id was already seen.
	assert.deepEqual(parsed.updates, []);
	assert.deepEqual(parsed.rejected, ["20261001-aaaa"]);
});

test("runKeywordRekey rewrites dirty legacy tags with model output and keeps a .bak", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.writeFile(file, `${meta("20261001-aaaa", "#ui-taste #design-feedback #screenshots #verification")}design notes\n\n`, "utf8");
	const entries = await loadAllEntries(globalDir, projectRoot);
	const result = await runKeywordRekey(deps, entries, {}, fakeRegistry("20261001-aaaa | ui-taste, design-feedback"));
	assert.equal(result.updated, 1);
	assert.equal(result.changedFiles, 1);
	const parsed = parseEntries(await fs.readFile(file, "utf8"));
	assert.deepEqual(parsed[0]!.tags, ["ui-taste", "design-feedback"]);
	await fs.stat(`${file}.bak`);
});

test("runKeywordRekey leaves already-good keywords untouched (no rewrite)", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	const body = `${meta("20261001-aaaa", "deploy,rsync")}deploy notes\n\n`;
	await fs.writeFile(file, body, "utf8");
	const entries = await loadAllEntries(globalDir, projectRoot);
	const result = await runKeywordRekey(deps, entries, {}, fakeRegistry("20261001-aaaa | rsync, deploy"));
	assert.equal(result.agreed, 1);
	assert.equal(result.updated, 0);
	assert.equal(result.changedFiles, 0);
	assert.equal(await fs.readFile(file, "utf8"), body);
	await assert.rejects(fs.stat(`${file}.bak`));
});

test("runKeywordRekey repairs locally when the model fails, so no entry loses its keyword", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.writeFile(file, `${meta("20261001-aaaa", "#a #b #c")}Use \`pnpm install\` first.\n\n`, "utf8");
	const entries = await loadAllEntries(globalDir, projectRoot);
	const failing = { complete: async () => ({ content: [], stopReason: "error" }) };
	const result = await runKeywordRekey(deps, entries, {}, failing);
	assert.equal(result.updated, 1);
	const parsed = parseEntries(await fs.readFile(file, "utf8"));
	assert.ok(parsed[0]!.tags.length >= 1);
	assert.ok(parsed[0]!.tags.length <= MAX_KEYWORDS);
	assert.deepEqual(parsed[0]!.tags, ["a", "b", "c"]);
});

test("runKeywordRekey batches large stores", async () => {
	const { projectRoot, globalDir, deps } = await setup();
	const file = path.join(projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	const many = Array.from({ length: REKEY_BATCH_SIZE + 3 }, (_, i) =>
		meta(`202610${String(i).padStart(2, "0")}-aa${String(i).padStart(2, "0")}`, "old"),
	).map((m, i) => `${m}body ${i}\n\n`);
	await fs.writeFile(file, many.join(""), "utf8");
	const entries = await loadAllEntries(globalDir, projectRoot);
	let calls = 0;
	const registry = {
		complete: async (_m: unknown, context: unknown) => {
			calls++;
			const prompt = JSON.stringify(context);
			const ids = [...prompt.matchAll(/(\d{8}-[0-9a-f]{4}) \|/g)].map((m) => m[1]!);
			return { content: [{ type: "text", text: ids.map((id) => `${id} | fresh`).join("\n") }], stopReason: "stop" };
		},
	};
	const progress: number[] = [];
	await runKeywordRekey(deps, entries, {}, registry, { onProgress: (done) => progress.push(done) });
	assert.equal(calls, Math.ceil(entries.length / REKEY_BATCH_SIZE));
	assert.deepEqual(progress, progress.slice().sort((a, b) => a - b));
	assert.equal(progress.at(-1), entries.length);
});
