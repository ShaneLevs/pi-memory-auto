import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SnapshotManager } from "../src/snapshot.ts";

const PREAMBLE = "<memory-auto>preamble</memory-auto>";
const BUDGET = 400;

function meta(id: string, tags: string, project: string): string {
	return `<!-- mid: ${id} | t: 2026-10-11 19:40:00 | p: ${project} | src: auto | tags: ${tags} -->`;
}

async function dirs(): Promise<{ globalDir: string; projectRoot: string }> {
	const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mem-global-"));
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mem-proj-"));
	return { globalDir, projectRoot };
}

async function writeCategory(root: string, file: string, body: string): Promise<void> {
	const dir = path.join(root, ".pi", "agent", "memory-auto");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, file), body, "utf8");
}

test("no entries → no injection", async () => {
	const { globalDir, projectRoot } = await dirs();
	const snapshots = new SnapshotManager();
	const text = await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	assert.equal(text, "");
});

test("index is produced from category files alone (no MEMORY.md needed)", async () => {
	const { globalDir, projectRoot } = await dirs();
	await fs.writeFile(path.join(globalDir, "USER.md"), `${meta("20261001-aaaa", "language,中文", "-")}\nPrefers Chinese, terse answers.\n`, "utf8");
	await writeCategory(projectRoot, "DECISIONS.md", `${meta("20261002-bbbb", "pnpm,包管理器", "proj")}\nUse pnpm, not npm.\n`);
	const snapshots = new SnapshotManager();
	const text = await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	assert.ok(text);
	assert.ok(text!.includes("#language"));
	assert.ok(text!.includes("#pnpm"));
	// Only keywords are injected — never the memory bodies.
	assert.ok(!text!.includes("Use pnpm, not npm."));
	assert.ok(!text!.includes("Prefers Chinese"));
	assert.ok(text!.includes("global — 1 memory"));
	assert.ok(text!.includes("project:"));
});

test("snapshot is reused within a session (returns null, cache-safe)", async () => {
	const { globalDir, projectRoot } = await dirs();
	await writeCategory(projectRoot, "FAILURES.md", `${meta("20261001-aaaa", "x", "proj")}\nbody\n`);
	const snapshots = new SnapshotManager();
	const first = await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	assert.ok(first && first.length > 0);
	const second = await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	assert.equal(second, null);
});

test("compaction dirties the snapshot; new entries show up after it", async () => {
	const { globalDir, projectRoot } = await dirs();
	await writeCategory(projectRoot, "FAILURES.md", `${meta("20261001-aaaa", "old-topic", "proj")}\nbody\n`);
	const snapshots = new SnapshotManager();
	await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	await writeCategory(projectRoot, "FAILURES.md", `${meta("20261001-aaaa", "old-topic", "proj")}\nbody\n\n${meta("20261002-bbbb", "new-topic", "proj")}\nother\n`);
	snapshots.markCompacted();
	const text = await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	assert.ok(text!.includes("#new-topic"));
});

test("reset() forces a re-render (session start)", async () => {
	const { globalDir, projectRoot } = await dirs();
	await writeCategory(projectRoot, "FAILURES.md", `${meta("20261001-aaaa", "x", "proj")}\nbody\n`);
	const snapshots = new SnapshotManager();
	await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	snapshots.reset();
	const text = await snapshots.getInjection({ globalDir, projectRoot, preamble: PREAMBLE, indexBudget: BUDGET });
	assert.ok(text && text.length > 0);
});
