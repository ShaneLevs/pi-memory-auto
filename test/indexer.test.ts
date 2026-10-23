import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { materializeAll, materializeLayer, parseStats } from "../src/indexer.ts";
import { loadAllEntries } from "../src/search.ts";
import { FileMutex } from "../src/store.ts";

function meta(id: string, tags: string, project: string): string {
	return `<!-- mid: ${id} | t: 2026-10-11 19:40:00 | p: ${project} | src: auto | tags: ${tags} -->`;
}

async function setup(): Promise<{ globalDir: string; projectRoot: string; mutex: FileMutex }> {
	const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mem-idx-g-"));
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mem-idx-p-"));
	return { globalDir, projectRoot, mutex: new FileMutex() };
}

async function writeCategory(root: string, file: string, body: string): Promise<void> {
	const dir = path.join(root, ".pi", "agent", "memory-auto");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, file), body, "utf8");
}

const deps = (dirs: { globalDir: string; projectRoot: string; mutex: FileMutex }, indexBudget = 3000) => ({ ...dirs, indexBudget });

test("MEMORY.md is created from entries alone and carries stats", async () => {
	const dirs = await setup();
	await writeCategory(dirs.projectRoot, "DECISIONS.md", `${meta("20261001-aaaa", "pnpm,deploy", "proj")}\nUse pnpm.\n`);
	const stats = await materializeLayer(deps(dirs), "project", await loadAllEntries(dirs.globalDir, dirs.projectRoot));
	assert.equal(stats.entries, 1);
	assert.equal(stats.keywords, 2);
	assert.equal(stats.sinceLast, 0); // first build: the existing entries are the baseline
	assert.equal(stats.written, true);

	const raw = await fs.readFile(path.join(dirs.projectRoot, ".pi/agent/memory-auto/MEMORY.md"), "utf8");
	assert.match(raw, /AUTO-GENERATED keyword table/);
	assert.match(raw, /<!-- stats: entries=1 keywords=2 sinceLast=0/);
	assert.match(raw, /#pnpm/);
	assert.match(raw, /#deploy/);
	assert.ok(!raw.includes("Use pnpm."), "the body must not be in the index");
});

test("sinceLast counts memories added since the last rebuild", async () => {
	const dirs = await setup();
	const file = path.join(dirs.projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await writeCategory(dirs.projectRoot, "DECISIONS.md", `${meta("20261001-aaaa", "a", "proj")}\nfirst\n`);
	await materializeAll(deps(dirs));
	await fs.appendFile(file, `${meta("20261002-bbbb", "b", "proj")}\nsecond\n`, "utf8");
	const stats = await materializeAll(deps(dirs));
	assert.equal(stats.project.entries, 2);
	assert.equal(stats.project.sinceLast, 1);
});

test("resetCounter zeroes the watermark after a consolidation", async () => {
	const dirs = await setup();
	await writeCategory(dirs.projectRoot, "DECISIONS.md", `${meta("20261001-aaaa", "a", "proj")}\nfirst\n`);
	await materializeAll(deps(dirs));
	const file = path.join(dirs.projectRoot, ".pi/agent/memory-auto/DECISIONS.md");
	await fs.appendFile(file, `${meta("20261002-bbbb", "b", "proj")}\nsecond\n`, "utf8");
	const grown = await materializeAll(deps(dirs));
	assert.equal(grown.project.sinceLast, 1);

	const reset = await materializeAll(deps(dirs), { resetCounter: true });
	assert.equal(reset.project.sinceLast, 0);
	assert.notEqual(reset.project.lastConsolidated, "-");
});

test("stale MEMORY.md is removed when its layer becomes empty", async () => {
	const dirs = await setup();
	await writeCategory(dirs.projectRoot, "DECISIONS.md", `${meta("20261001-aaaa", "a", "proj")}\nfirst\n`);
	await materializeAll(deps(dirs));
	const file = path.join(dirs.projectRoot, ".pi/agent/memory-auto/MEMORY.md");
	assert.ok(await fs.stat(file));

	await fs.rm(path.join(dirs.projectRoot, ".pi/agent/memory-auto/DECISIONS.md"));
	await materializeAll(deps(dirs));
	await assert.rejects(fs.stat(file));
});

test("parseStats reads the watermark and tolerates a missing comment", () => {
	const stats = parseStats("<!-- stats: entries=4 keywords=9 sinceLast=3 lastConsolidated=2026-10-23T10:00:00.000Z -->");
	assert.deepEqual(stats, { entries: 4, keywords: 9, sinceLast: 3, lastConsolidated: "2026-10-23T10:00:00.000Z" });
	assert.deepEqual(parseStats("nothing here"), { entries: 0, keywords: 0, sinceLast: 0, lastConsolidated: "-" });
});

test("rebuild is idempotent (no rewrite when content is unchanged)", async () => {
	const dirs = await setup();
	await writeCategory(dirs.projectRoot, "DECISIONS.md", `${meta("20261001-aaaa", "a", "proj")}\nfirst\n`);
	await materializeAll(deps(dirs));
	const second = await materializeAll(deps(dirs));
	assert.equal(second.project.written, false);
});
