import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { appendEntry, applyTagUpdates, FileMutex, isWritableTarget, ProcessLock } from "../src/store.ts";
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

test("isWritableTarget rejects main file", () => {
	assert.equal(isWritableTarget("project", "FAILURES"), true);
	assert.equal(isWritableTarget("global", "USER"), true);
	assert.equal(isWritableTarget("project", "MEMORY"), false);
	assert.equal(isWritableTarget("global", "CONVENTIONS"), false);
});

test("applyTagUpdates rewrites only the given entries and keeps a .bak", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-tags-"));
	tmpDirs.push(root);
	const g = path.join(root, "global");
	const p = path.join(root, "proj");
	const dir = path.join(p, ".pi/agent/memory-auto");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "DECISIONS.md");
	await fs.writeFile(
		file,
		`<!-- mid: 20261001-aaaa | t: 2026-10-01 10:00:00 | p: proj | src: auto | tags: #a #b #c #d -->\nfirst\n\n<!-- mid: 20261002-bbbb | t: 2026-10-02 10:00:00 | p: proj | src: auto | tags: keep -->\nsecond\n\n`,
		"utf8",
	);
	const res = await applyTagUpdates({ layer: "project", file: "DECISIONS" }, { globalDir: g, projectRoot: p, mutex, plock }, new Map([["20261001-aaaa", ["alpha", "beta"]]]));
	assert.deepEqual(res, { changed: true, updated: 1 });
	const parsed = parseEntries(await fs.readFile(file, "utf8"));
	assert.deepEqual(parsed[0]!.tags, ["alpha", "beta"]);
	assert.deepEqual(parsed[1]!.tags, ["keep"]);
	assert.ok(await fs.stat(`${file}.bak`).then(() => true));
});

test("applyTagUpdates is a no-op for identical or empty updates", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-tags2-"));
	tmpDirs.push(root);
	const p = path.join(root, "proj");
	const dir = path.join(p, ".pi/agent/memory-auto");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "DECISIONS.md");
	const body = `<!-- mid: 20261001-aaaa | t: 2026-10-01 10:00:00 | p: proj | src: auto | tags: same -->\nx\n\n`;
	await fs.writeFile(file, body, "utf8");
	const before = await fs.readFile(file, "utf8");
	const deps = { globalDir: path.join(root, "g"), projectRoot: p, mutex, plock };
	assert.equal((await applyTagUpdates({ layer: "project", file: "DECISIONS" }, deps, new Map([["20261001-aaaa", ["same"]]]))).changed, false);
	assert.equal((await applyTagUpdates({ layer: "project", file: "DECISIONS" }, deps, new Map())).changed, false);
	assert.equal(await fs.readFile(file, "utf8"), before);
});
