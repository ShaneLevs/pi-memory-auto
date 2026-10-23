import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runHandoff } from "../src/handoff.ts";
import { MAX_KEYWORDS } from "../src/keywords.ts";
import { loadAllEntries } from "../src/search.ts";
import { FileMutex, ProcessLock } from "../src/store.ts";

const tmpDirs: string[] = [];
after(async () => {
	for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-handoff-"));
	tmpDirs.push(root);
	const globalDir = path.join(root, "global");
	const projectRoot = path.join(root, "proj");
	await fs.mkdir(globalDir, { recursive: true });
	const deps = { globalDir, projectRoot, mutex: new FileMutex(), plock: new ProcessLock(globalDir), llmMaxTokens: 2048 };
	return { globalDir, projectRoot, deps };
}

const registry = (text: string) => ({
	complete: async () => ({ content: [{ type: "text", text }], stopReason: "stop" }),
});

test("handoff keeps the keyword contract (the 'handoff' marker is not a 4th keyword)", async () => {
	const { globalDir, projectRoot, deps } = await setup();
	const response = `===ENTRY===
FILE: LESSONS.md
LAYER: global
TAGS: deploy,rsync,backup
TEXT: Back up the previous release before rsync --delete.`;
	const written = await runHandoff(deps, "some transcript", {}, registry(response));
	assert.equal(written.length, 1);
	assert.ok(written[0]!.tags.length <= MAX_KEYWORDS, `got ${written[0]!.tags.length} keywords`);
	assert.deepEqual(written[0]!.tags, ["deploy", "rsync", "backup"]);

	const after = await loadAllEntries(globalDir, projectRoot);
	assert.equal(after.length, 1);
	assert.deepEqual(after[0]!.entry.tags, ["deploy", "rsync", "backup"]);
});

test("handoff still adds the marker when there is keyword budget for it", async () => {
	const { globalDir, projectRoot, deps } = await setup();
	const response = `===ENTRY===
FILE: LESSONS.md
LAYER: global
TAGS: deploy
TEXT: Back up before rsync --delete.`;
	const written = await runHandoff(deps, "transcript", {}, registry(response));
	assert.deepEqual(written[0]!.tags, ["deploy", "handoff"]);
	const after = await loadAllEntries(globalDir, projectRoot);
	assert.equal(after.length, 1);
});

test("handoff writes nothing for an empty transcript", async () => {
	const { deps } = await setup();
	assert.deepEqual(await runHandoff(deps, "   ", {}, registry("===ENTRY=== ...")), []);
});
