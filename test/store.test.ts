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
	const outcome = await appendEntry({ layer: "project", file: "FAILURES" }, "Things broke.", {
		tags: ["bug"],
		source: "user",
		globalDir,
		projectRoot,
		mutex,
		plock,
	});
	const entry = outcome.entry;
	assert.equal(outcome.deduped, false);
	assert.equal(outcome.file, "project/FAILURES.md");
	assert.equal(entry.layer, "project");
	assert.equal(entry.project, "proj");
	const raw = await fs.readFile(path.join(projectRoot, ".pi/agent/memory-auto/FAILURES.md"), "utf8");
	assert.match(raw, /<!-- mid: /);
	const parsed = parseEntries(raw);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0]!.text, "Things broke.");
});

test("appendEntry folds an identical body into the stored entry (seen/last bumped)", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-dedup-"));
	tmpDirs.push(root);
	const g = path.join(root, "global");
	const p = path.join(root, "proj");
	const deps = { globalDir: g, projectRoot: p, mutex, plock };

	const first = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use PostgreSQL for JSON support.", { tags: ["db"], ...deps });
	// Same body, different case/whitespace/trailing period: still the same memory.
	const second = await appendEntry({ layer: "project", file: "DECISIONS" }, "use postgresql   for JSON support", { tags: ["db"], ...deps });

	assert.equal(second.deduped, true);
	assert.equal(second.entry.id, first.entry.id);
	assert.equal(second.entry.seen, 2);

	const raw = await fs.readFile(path.join(p, ".pi/agent/memory-auto/DECISIONS.md"), "utf8");
	const parsed = parseEntries(raw);
	assert.equal(parsed.length, 1, "no duplicate row was appended");
	assert.equal(parsed[0]!.seen, 2);
	assert.match(parsed[0]!.last ?? "", /^\d{4}-\d{2}-\d{2} /);
	assert.match(raw, /\| seen: 2 \| last: /);
});

test("appendEntry dedupes across files of the same layer, not across layers", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-dedup-layer-"));
	tmpDirs.push(root);
	const g = path.join(root, "global");
	const p = path.join(root, "proj");
	const deps = { globalDir: g, projectRoot: p, mutex, plock };

	const first = await appendEntry({ layer: "project", file: "FAILURES" }, "Never trust the cached lockfile.", { tags: ["lock"], ...deps });
	const second = await appendEntry({ layer: "project", file: "CONVENTIONS" }, "Never trust the cached lockfile.", { tags: ["lock"], ...deps });
	assert.equal(second.deduped, true);
	assert.equal(second.entry.id, first.entry.id);
	assert.equal(second.file, "project/FAILURES.md");
	assert.equal(await fs.stat(path.join(p, ".pi/agent/memory-auto/CONVENTIONS.md")).then(() => true, () => false), false);

	// Same text in the other layer is a different memory (different audience).
	const global = await appendEntry({ layer: "global", file: "LESSONS" }, "Never trust the cached lockfile.", { tags: ["lock"], ...deps });
	assert.equal(global.deduped, false);
});

test("supersedes marks the replaced entry instead of deleting it", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-supersede-"));
	tmpDirs.push(root);
	const deps = { globalDir: path.join(root, "g"), projectRoot: path.join(root, "p"), mutex, plock };
	const file = path.join(root, "p", ".pi/agent/memory-auto/DECISIONS.md");

	const old = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use MySQL for the store.", { tags: ["db"], ...deps });
	const fixed = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use PostgreSQL for JSON support.", {
		tags: ["db"],
		supersedes: [old.entry.id],
		...deps,
	});

	assert.equal(fixed.superseded, 1);
	const parsed = parseEntries(await fs.readFile(file, "utf8"));
	assert.equal(parsed.length, 2, "the replaced row is kept");
	assert.equal(parsed[0]!.text, "Use MySQL for the store.");
	assert.equal(parsed[0]!.supersededBy, fixed.entry.id);
	assert.deepEqual(parsed[1]!.supersedes, [old.entry.id]);
});

test("supersedes ignores unknown, already-superseded and cross-layer ids", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-supersede2-"));
	tmpDirs.push(root);
	const deps = { globalDir: path.join(root, "g"), projectRoot: path.join(root, "p"), mutex, plock };

	const old = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use MySQL.", { tags: ["db"], ...deps });
	const glob = await appendEntry({ layer: "global", file: "LESSONS" }, "Never trust a cached lockfile.", { tags: ["lock"], ...deps });

	// A global id passed from a project write must not be touched.
	const first = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use PostgreSQL.", {
		tags: ["db"],
		supersedes: [old.entry.id, glob.entry.id, "20990101-9999"],
		...deps,
	});
	assert.equal(first.superseded, 1);

	// Re-superseding an already-dead id is a no-op (the first replacement wins).
	const second = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use SQLite for the local cache.", {
		tags: ["db"],
		supersedes: [old.entry.id],
		...deps,
	});
	assert.equal(second.superseded, 0);
	const globalRaw = await fs.readFile(path.join(root, "g", "LESSONS.md"), "utf8");
	assert.doesNotMatch(globalRaw, /superseded-by/);
});

test("appendEntry still appends near-but-different bodies", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-dedup-diff-"));
	tmpDirs.push(root);
	const deps = { globalDir: path.join(root, "g"), projectRoot: path.join(root, "p"), mutex, plock };
	const a = await appendEntry({ layer: "global", file: "TOOLING" }, "Use pnpm, not npm.", { tags: ["pnpm"], ...deps });
	const b = await appendEntry({ layer: "global", file: "TOOLING" }, "Use pnpm, not npm, in this repo.", { tags: ["pnpm"], ...deps });
	assert.equal(a.deduped, false);
	assert.equal(b.deduped, false);
	assert.notEqual(a.entry.id, b.entry.id);
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

test("re-asserting a superseded body appends a live row instead of bumping the dead one", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pma-revive-"));
	tmpDirs.push(root);
	const deps = { globalDir: path.join(root, "g"), projectRoot: path.join(root, "p"), mutex, plock };
	const file = path.join(root, "p", ".pi/agent/memory-auto/DECISIONS.md");

	const old = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use MySQL.", { tags: ["db"], ...deps });
	await appendEntry({ layer: "project", file: "DECISIONS" }, "Use PostgreSQL.", { tags: ["db"], supersedes: [old.entry.id], ...deps });

	const again = await appendEntry({ layer: "project", file: "DECISIONS" }, "Use MySQL.", { tags: ["db"], ...deps });
	assert.equal(again.deduped, false, "the fact is being asserted again, so it must come back to life");
	assert.notEqual(again.entry.id, old.entry.id);
	const parsed = parseEntries(await fs.readFile(file, "utf8"));
	assert.equal(parsed.length, 3);
	assert.equal(parsed[0]!.supersededBy !== undefined, true, "the dead row stays dead");
	assert.equal(parsed[2]!.supersededBy, undefined);
});
