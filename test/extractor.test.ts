import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runReview } from "../src/extractor.ts";
import { loadAllEntries } from "../src/search.ts";
import { FileMutex, ProcessLock } from "../src/store.ts";

const tmpDirs: string[] = [];
after(async () => {
	for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-extractor-"));
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

const ENTRY = `===ENTRY===
FILE: LESSONS.md
LAYER: global
TAGS: deploy,rsync
TEXT: Back up the previous release before rsync --delete.`;

test("a successful review reports ok and the entries it wrote", async () => {
	const { globalDir, projectRoot, deps } = await setup();
	const outcome = await runReview(deps, "[User]: hi", {}, registry(ENTRY));
	assert.equal(outcome.ok, true);
	assert.equal(outcome.written.length, 1);
	assert.equal((await loadAllEntries(globalDir, projectRoot)).length, 1);
});

test("ok:true with nothing written means the conversation held nothing new", async () => {
	const { deps } = await setup();
	const outcome = await runReview(deps, "[User]: hi", {}, registry("NOTHING_TO_SAVE"));
	assert.deepEqual(outcome, { written: [], ok: true });
});

test("a failed provider call is ok:false so the caller keeps the transcript", async () => {
	const { globalDir, projectRoot, deps } = await setup();
	const outcome = await runReview(deps, "[User]: hi", {}, { complete: async () => ({ content: [], stopReason: "error" }) });
	assert.equal(outcome.ok, false, "a failed call must NOT look like 'nothing to store'");
	assert.deepEqual(outcome.written, []);
	assert.deepEqual(await loadAllEntries(globalDir, projectRoot), []);
});

test("an abort is also ok:false", async () => {
	const { deps } = await setup();
	const outcome = await runReview(deps, "[User]: hi", {}, { complete: async () => ({ content: [{ type: "text", text: ENTRY }], stopReason: "aborted" }) });
	assert.equal(outcome.ok, false);
});

test("an empty transcript is a real result, not a failure", async () => {
	const { deps } = await setup();
	assert.deepEqual(await runReview(deps, "   ", {}, registry(ENTRY)), { written: [], ok: true });
});

test("SUPERSEDES retires the named memory instead of adding a contradicting row", async () => {
	const { globalDir, projectRoot, deps } = await setup();
	const first = await runReview(deps, "[User]: deploy with rsync", {}, registry(ENTRY));
	const oldId = first.written[0]!.id;
	const second = await runReview(
		deps,
		"[User]: deploy with GitHub Actions now",
		{},
		registry(`===ENTRY===
FILE: LESSONS.md
LAYER: global
TAGS: deploy,rsync
TEXT: Deploy runs through the GitHub Actions workflow.
SUPERSEDES: ${oldId}`),
	);
	assert.equal(second.ok, true);
	const all = await loadAllEntries(globalDir, projectRoot);
	assert.equal(all.length, 2, "the old row is kept on disk");
	const old = all.find(({ entry }) => entry.id === oldId);
	assert.equal(old?.entry.supersededBy, second.written[0]!.id);
	const live = all.filter(({ entry }) => !entry.supersededBy);
	assert.equal(live.length, 1);
	assert.match(live[0]!.entry.text, /GitHub Actions/);
});
