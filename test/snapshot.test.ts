import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SnapshotManager } from "../src/snapshot.ts";

async function makeDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-auto-snap-"));
}

const PREAMBLE = "<memory-auto>preamble</memory-auto>";
const BUDGET = 100;

function writeMain(dir: string, layer: "global" | "project", content: string): Promise<void> {
	const sub = layer === "project" ? path.join(dir, "proj", ".pi", "agent", "memory-auto") : dir;
	return (async () => {
		await fs.mkdir(sub, { recursive: true });
		await fs.writeFile(path.join(sub, "MEMORY.md"), content, "utf8");
	})();
}

const PROJECT_ROOT = "/tmp/proj"; // matches mainFilePath("project", ...) layout in the test below

// Note: project main path = <projectRoot>/.pi/agent/memory-auto/MEMORY.md.
// The projectRoot used by getInjection is passed directly, so we create a temp dir and pass it.

test("getInjection: no overflow when content fits budget", async () => {
	const dir = await makeDir();
	await writeMain(dir, "global", "Short global memory.");
	const proj = await makeDir();
	await writeMain(proj, "project", "Short project memory.");
	const snapshots = new SnapshotManager();
	const r = await snapshots.getInjection({ globalDir: dir, projectRoot: proj, preamble: PREAMBLE, budget: BUDGET });
	assert.ok(r.text!.includes("Short global memory."));
	assert.deepEqual(r.overflowedLayers, []);
});

test("getInjection: overflowing layer reported", async () => {
	const dir = await makeDir();
	await writeMain(dir, "global", "x".repeat(BUDGET + 50));
	const proj = await makeDir();
	await writeMain(proj, "project", "short");
	const snapshots = new SnapshotManager();
	const r = await snapshots.getInjection({ globalDir: dir, projectRoot: proj, preamble: PREAMBLE, budget: BUDGET });
	assert.deepEqual(r.overflowedLayers, ["global"]);
	// Injected text is still trimmed to the budget.
	assert.ok(r.text!.length <= BUDGET + PREAMBLE.length + 100);
});

test("getInjection: snapshot reuse returns no overflow again", async () => {
	const dir = await makeDir();
	await writeMain(dir, "global", "y".repeat(BUDGET + 50));
	const proj = await makeDir();
	const snapshots = new SnapshotManager();
	const first = await snapshots.getInjection({ globalDir: dir, projectRoot: proj, preamble: PREAMBLE, budget: BUDGET });
	assert.deepEqual(first.overflowedLayers, ["global"]);
	// Second call reuses the snapshot: no re-render, no overflow re-report.
	const second = await snapshots.getInjection({ globalDir: dir, projectRoot: proj, preamble: PREAMBLE, budget: BUDGET });
	assert.equal(second.text, null);
	assert.deepEqual(second.overflowedLayers, []);
});
