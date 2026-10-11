import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { appendEntry, cleanMainContent, FileMutex, isWritableTarget, mainCleanLength, ProcessLock } from "../src/store.ts";
import { parseEntries } from "../src/entry.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pma-store-"));
const globalDir = path.join(tmp, "global");
const projectRoot = path.join(tmp, "proj");
const mutex = new FileMutex();
const plock = new ProcessLock(globalDir);
const tmpDirs: string[] = [tmp];
after(async () => {
	for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

test("appendEntry writes serialized entry with metadata", async () => {
	const entry = await appendEntry({ layer: "project", file: "FAILURES" }, "Things broke.", {
		tags: ["bug"],
		source: "user",
		globalDir,
		projectRoot,
		mutex,
		plock,
	});
	assert.equal(entry.layer, "project");
	assert.equal(entry.project, "proj");
	const raw = await fs.readFile(path.join(projectRoot, ".pi/agent/memory-auto/FAILURES.md"), "utf8");
	assert.match(raw, /<!-- mid: /);
	const parsed = parseEntries(raw);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0]!.text, "Things broke.");
});

test("concurrent appends all land (mutex serializes)", async () => {
	await Promise.all(
		Array.from({ length: 20 }, (_, i) =>
			appendEntry({ layer: "global", file: "LESSONS" }, `entry ${i}`, {
				globalDir,
				projectRoot,
				mutex,
				plock,
			}),
		),
	);
	const raw = await fs.readFile(path.join(globalDir, "LESSONS.md"), "utf8");
	assert.equal(parseEntries(raw).length, 20);
});

test("cleanMainContent strips metadata and compacts blank lines", () => {
	const raw = "<!-- mid: a -->\nfoo\n\n\n\n<!-- mid: b -->\nbar\n";
	assert.equal(cleanMainContent(raw), "foo\n\nbar");
});

test("mainCleanLength counts cleaned chars", async () => {
	const main = path.join(projectRoot, ".pi/agent/memory-auto/MEMORY.md");
	await fs.mkdir(path.dirname(main), { recursive: true });
	await fs.writeFile(main, "<!-- mid: x -->\n" + "y".repeat(1200), "utf8");
	assert.ok((await mainCleanLength("project", globalDir, projectRoot)) >= 1200);
});

test("isWritableTarget rejects main file", () => {
	assert.equal(isWritableTarget("project", "FAILURES"), true);
	assert.equal(isWritableTarget("global", "USER"), true);
	assert.equal(isWritableTarget("project", "MEMORY"), false);
	assert.equal(isWritableTarget("global", "CONVENTIONS"), false);
});
