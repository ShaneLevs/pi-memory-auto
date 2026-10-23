/**
 * Storage layer: directories, append writes, per-file async mutex,
 * cross-process lockfile guard, and the main-file length helpers.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ENTRY_META_PREFIX, MAIN_FILE, PROJECT_DIR, WRITABLE_FILES } from "./constants.ts";
import { ENTRY_ID_RE, generateEntryId, formatTime, normalizeMemoryText, parseEntries, serializeEntry, serializeMetaLine } from "./entry.ts";
import { keywordKey } from "./keywords.ts";
import type { CategoryFile, Layer, MemoryEntry, MemorySource, WriteTarget } from "./types.ts";

/** Compute the memory directory for a layer. */
export function memoryDir(layer: Layer, globalDir: string, projectRoot: string): string {
	return layer === "global" ? globalDir : path.join(projectRoot, PROJECT_DIR);
}

/** Absolute path of a category (writable) file. */
export function categoryFilePath(target: WriteTarget, globalDir: string, projectRoot: string): string {
	return path.join(memoryDir(target.layer, globalDir, projectRoot), `${target.file}.md`);
}

/** Absolute path of the layer's main file. */
export function mainFilePath(layer: Layer, globalDir: string, projectRoot: string): string {
	return path.join(memoryDir(layer, globalDir, projectRoot), MAIN_FILE);
}

/** Ensure the directory for a path exists. */
export async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/** Read a file's text; empty string when missing. */
export async function readFileOrEmpty(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

/** Per-file async mutex: serializes read-modify-write cycles within this process. */
export class FileMutex {
	private chains = new Map<string, Promise<unknown>>();

	/** Run `fn` exclusively for `key`. */
	run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn); // run regardless of predecessor outcome
		this.chains.set(
			key,
			next.catch(() => undefined),
		);
		return next;
	}
}

/**
 * Cross-process advisory lock via O_EXCL lockfile with staleness check.
 * Best-effort: on contention we retry briefly, then proceed anyway (mtime
 * re-check inside callers guards against lost updates).
 */
export class ProcessLock {
	private readonly ttlMs = 30_000;
	private readonly retryMs = 100;
	private readonly maxWaitMs = 2_000;

	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private lockPath(key: string): string {
		return path.join(this.dir, `.lock-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
	}

	async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const lp = this.lockPath(key);
		const deadline = Date.now() + this.maxWaitMs;
		let acquired = false;
		while (Date.now() < deadline) {
			try {
				await fs.mkdir(path.dirname(lp), { recursive: true });
				await fs.writeFile(lp, String(process.pid), { flag: "wx" });
				acquired = true;
				break;
			} catch {
				// Exists — check staleness.
				try {
					const st = await fs.stat(lp);
					if (Date.now() - st.mtimeMs > this.ttlMs) {
						await fs.rm(lp, { force: true });
						continue;
					}
				} catch {
					continue;
				}
				await new Promise((r) => setTimeout(r, this.retryMs));
			}
		}
		if (!acquired) {
			// Proceed without the lock; callers rely on append-only writes and mtime checks.
			return fn();
		}
		try {
			return await fn();
		} finally {
			await fs.rm(lp, { force: true }).catch(() => undefined);
		}
	}
}

/** Result of a write: the stored entry plus whether it was a re-confirmation. */
export interface AppendOutcome {
	/** The entry as it now exists on disk (a new row, or the bumped one). */
	entry: MemoryEntry;
	/** True when an identical body was already stored: nothing was appended. */
	deduped: boolean;
	/** Where the entry lives, e.g. "project/FAILURES.md". */
	file: string;
	/** How many stored entries this write marked as superseded. */
	superseded: number;
}

/**
 * Append one entry to a category file (or fold it into an existing identical one).
 *
 * Write-time idempotency: if the same body (after normalizeMemoryText) already
 * exists anywhere in the same layer, nothing is appended — the stored entry's
 * `seen`/`last` are bumped instead. The check spans the layer, not just the
 * target file, because the extractor flip-flops between e.g. LESSONS.md and
 * FAILURES.md for the same fact; catching that here is cheaper and more
 * reliable than hoping a later LLM consolidation round notices.
 *
 * Appends are atomic enough: single-process mutex + cross-process lockfile +
 * append-only writes.
 */
export async function appendEntry(
	target: WriteTarget,
	text: string,
	opts: {
		tags?: string[];
		source?: MemorySource;
		globalDir: string;
		projectRoot: string;
		mutex: FileMutex;
		plock: ProcessLock;
		now?: Date;
		/** Ids of stored entries this one replaces (same layer). */
		supersedes?: string[];
	},
): Promise<AppendOutcome> {
	const now = opts.now ?? new Date();
	const body = text.trim();
	const normalized = normalizeMemoryText(body);
	const supersedes = [...new Set((opts.supersedes ?? []).filter((id) => ENTRY_ID_RE.test(id)))];

	if (normalized) {
		for (const candidate of await findLayerEquivalents(target.layer, normalized, opts.globalDir, opts.projectRoot)) {
			// Re-find inside the lock: a consolidation may have rewritten the file
			// between the scan and this point, so the id alone is not enough.
			const bumped = await opts.mutex.run(candidate.filePath, () =>
				opts.plock.withLock(candidate.filePath, () => bumpEntry(candidate.filePath, normalized, now, supersedes)),
			);
			if (bumped) {
				// A deduped write can still replace older entries ("same text, but the
				// two entries it was spread across are now dead").
				const replaced = supersedes.length > 0 ? await markSuperseded(target.layer, supersedes, bumped.id, opts) : { changed: 0 };
				return { entry: bumped, deduped: true, file: `${target.layer}/${candidate.file}.md`, superseded: replaced.changed };
			}
		}
	}

	const entry: MemoryEntry = {
		id: generateEntryId(now),
		time: formatTime(now),
		project: target.layer === "project" ? path.basename(opts.projectRoot) : "",
		layer: target.layer,
		source: opts.source ?? "user",
		tags: opts.tags ?? [],
		text: body,
		...(supersedes.length > 0 ? { supersedes } : {}),
	};
	const filePath = categoryFilePath(target, opts.globalDir, opts.projectRoot);
	const key = filePath;
	await opts.mutex.run(key, () =>
		opts.plock.withLock(key, async () => {
			await ensureDirForFile(filePath);
			await fs.appendFile(filePath, serializeEntry(entry), "utf8");
		}),
	);
	const replaced = supersedes.length > 0 ? await markSuperseded(target.layer, supersedes, entry.id, opts) : { changed: 0 };
	return { entry, deduped: false, file: `${target.layer}/${target.file}.md`, superseded: replaced.changed };
}

/**
 * Mark stored entries as replaced by `byId` — the soft form of deletion.
 *
 * The entry keeps its row and its body; only the metadata gains
 * `superseded-by`. Consequences (all reversible by removing that field):
 * - its keywords stop contributing to MEMORY.md / the injected index
 *   (index-map.ts);
 * - search still finds it but never ranks it above a live memory, and labels it
 *   with the replacement id (search.ts);
 * - a later consolidation pass can merge the rows away normally.
 *
 * Already-superseded entries are left alone (the first replacement wins), ids
 * from another layer are ignored, and an unknown id changes nothing.
 */
export async function markSuperseded(
	layer: Layer,
	ids: readonly string[],
	byId: string,
	deps: { globalDir: string; projectRoot: string; mutex: FileMutex; plock: ProcessLock },
): Promise<{ changed: number }> {
	const wanted = new Set(ids.filter((id) => id !== byId && ENTRY_ID_RE.test(id)));
	if (wanted.size === 0) return { changed: 0 };

	let changed = 0;
	for (const file of WRITABLE_FILES[layer]) {
		const filePath = categoryFilePath({ layer, file }, deps.globalDir, deps.projectRoot);
		changed += await deps.mutex.run(filePath, () =>
			deps.plock.withLock(filePath, async () => {
				const raw = await readFileOrEmpty(filePath);
				if (!raw) return 0;
				const lines = raw.split("\n");
				let touched = 0;
				for (const entry of parseEntries(raw)) {
					if (!wanted.has(entry.id) || entry.supersededBy) continue;
					const metaRe = new RegExp(`^<!--\\s*mid:\\s*${entry.id}\\s*\\|`);
					const index = lines.findIndex((line) => metaRe.test(line.trim()));
					if (index < 0) continue;
					lines[index] = serializeMetaLine({ ...entry, supersededBy: byId });
					touched++;
				}
				if (touched === 0) return 0;
				const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
				await fs.writeFile(tmp, lines.join("\n"), "utf8");
				await fs.rename(tmp, filePath);
				return touched;
			}),
		);
	}
	return { changed };
}

/** Files of one layer that already hold a LIVE entry with this normalized body. */
async function findLayerEquivalents(
	layer: Layer,
	normalized: string,
	globalDir: string,
	projectRoot: string,
): Promise<{ file: CategoryFile; filePath: string }[]> {
	const out: { file: CategoryFile; filePath: string }[] = [];
	for (const file of WRITABLE_FILES[layer]) {
		const filePath = categoryFilePath({ layer, file }, globalDir, projectRoot);
		const raw = await readFileOrEmpty(filePath);
		if (!raw) continue;
		// A superseded row is not a match: re-asserting its body must revive the
		// fact as a new, live memory instead of bumping a dead one.
		if (parseEntries(raw).some((entry) => !entry.supersededBy && normalizeMemoryText(entry.text) === normalized)) {
			out.push({ file, filePath });
		}
	}
	return out;
}

/**
 * Increment `seen`/`last` of the entry holding this body. Returns undefined when
 * the entry is gone (merged away meanwhile), so the caller falls back to a plain
 * append.
 *
 * Exactly one metadata line is rewritten; the body text on disk is untouched.
 * Written via temp file + rename so a crash cannot truncate the category file.
 */
async function bumpEntry(filePath: string, normalized: string, now: Date, extraSupersedes: readonly string[] = []): Promise<MemoryEntry | undefined> {
	const raw = await readFileOrEmpty(filePath);
	if (!raw) return undefined;
	const existing = parseEntries(raw).find((entry) => !entry.supersededBy && normalizeMemoryText(entry.text) === normalized);
	if (!existing) return undefined;

	const supersedes = [...new Set([...(existing.supersedes ?? []), ...extraSupersedes])].filter((id) => id !== existing.id);
	const bumped: MemoryEntry = {
		...existing,
		seen: (existing.seen ?? 1) + 1,
		last: formatTime(now),
		...(supersedes.length > 0 ? { supersedes } : {}),
	};
	const lines = raw.split("\n");
	const metaRe = new RegExp(`^<!--\\s*mid:\\s*${existing.id}\\s*\\|`);
	const index = lines.findIndex((line) => metaRe.test(line.trim()));
	if (index < 0) return undefined;
	lines[index] = serializeMetaLine(bumped);

	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmp, lines.join("\n"), "utf8");
	await fs.rename(tmp, filePath);
	return bumped;
}

/** Validate that a target is writable (a category file, never the main file). */
export function isWritableTarget(layer: Layer, file: string): file is CategoryFile {
	return (WRITABLE_FILES[layer] as readonly string[]).includes(file);
}

// ── Consolidation edits ────────────────────────────────────────────────────

/** One merge: keep one entry, fold others into it, optionally rewrite it. */
export interface MergeOp {
	keepId: string;
	dropIds: string[];
	/** Replacement keyword list (already sanitized by the caller). */
	tags?: string[];
	/** Replacement body; omitted keeps the existing text. */
	text?: string;
}

/** Keyword-level rename applied to every entry in the layer. */
export interface KeywordRename {
	from: string;
	to: string;
}

export interface ConsolidationPlan {
	merges: MergeOp[];
	keywordRenames: KeywordRename[];
}

export interface ApplyDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
	plock: ProcessLock;
}

interface EntryBlock {
	id: string;
	entry: MemoryEntry;
}

/** Split a category file into head text + parsed entry blocks. */
function splitBlocks(raw: string): { head: string; blocks: EntryBlock[] } {
	const head: string[] = [];
	const blocks: EntryBlock[] = [];
	let current: string[] | null = null;
	const flush = () => {
		if (!current) return;
		const [entry] = parseEntries(current.join("\n"));
		if (entry) blocks.push({ id: entry.id, entry });
		current = null;
	};
	for (const line of raw.split("\n")) {
		if (line.trim().startsWith(ENTRY_META_PREFIX)) {
			flush();
			current = [line];
			continue;
		}
		if (current) current.push(line);
		else head.push(line);
	}
	flush();
	return { head: head.join("\n").replace(/\s+$/, ""), blocks };
}

/**
 * Apply a consolidation plan to one category file.
 *
 * Deterministic and conservative: unknown ids are ignored, a merge whose keep
 * target is missing is skipped, every memory keeps at least one keyword, and
 * the previous file is kept as `<file>.bak`. Never deletes the file itself.
 */
export async function applyConsolidation(
	target: WriteTarget,
	deps: ApplyDeps,
	plan: ConsolidationPlan,
): Promise<{ changed: boolean; removed: number; updated: number }> {
	const filePath = categoryFilePath(target, deps.globalDir, deps.projectRoot);
	return deps.mutex.run(filePath, () =>
		deps.plock.withLock(filePath, async () => {
			const raw = await readFileOrEmpty(filePath);
			if (!raw) return { changed: false, removed: 0, updated: 0 };
			const { head, blocks } = splitBlocks(raw);
			if (blocks.length === 0) return { changed: false, removed: 0, updated: 0 };

			const byId = new Map(blocks.map((b) => [b.id, b.entry]));
			const drops = new Set<string>();
			const rewrites = new Map<string, MemoryEntry>();
			for (const merge of plan.merges) {
				const keep = byId.get(merge.keepId);
				if (!keep) continue;
				for (const id of merge.dropIds) if (id !== merge.keepId && byId.has(id)) drops.add(id);
				const tags = merge.tags && merge.tags.length > 0 ? merge.tags : keep.tags;
				const text = merge.text?.trim() || keep.text;
				if (tags !== keep.tags || text !== keep.text) rewrites.set(keep.id, { ...keep, tags, text });
			}

			const renamed = (entry: MemoryEntry): MemoryEntry => {
				if (plan.keywordRenames.length === 0 || entry.tags.length === 0) return entry;
				const tags: string[] = [];
				const seen = new Set<string>();
				for (const tag of entry.tags) {
					const from = keywordKey(tag);
					const rename = plan.keywordRenames.find((r) => keywordKey(r.from) === from);
					const next = rename ? rename.to : tag;
					const key = keywordKey(next);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					tags.push(next);
				}
				if (tags.length === 0) return entry; // never leave an entry without a keyword
				return { ...entry, tags };
			};

			const kept: MemoryEntry[] = [];
			let removed = 0;
			let updated = 0;
			for (const block of blocks) {
				if (drops.has(block.id)) {
					removed++;
					continue;
				}
				const rewritten = rewrites.get(block.id);
				const next = renamed(rewritten ?? block.entry);
				if (next !== block.entry) updated++;
				kept.push(next);
			}
			if (removed === 0 && updated === 0) return { changed: false, removed: 0, updated: 0 };

			const content = `${head ? `${head}\n\n` : ""}${kept.map(serializeEntry).join("")}`;
			await fs.writeFile(`${filePath}.bak`, raw, "utf8");
			await fs.writeFile(filePath, content, "utf8");
			return { changed: true, removed, updated };
		}),
	);
}

/**
 * Rewrite the keyword list of specific entries in one category file.
 *
 * Used by the `/memory rebuild` keyword re-extraction pass. Conservative like
 * applyConsolidation: unknown ids are skipped, an update that would leave an
 * entry without a keyword is ignored, and the previous file is kept as `.bak`.
 */
export async function applyTagUpdates(
	target: WriteTarget,
	deps: ApplyDeps,
	updates: Map<string, string[]>,
): Promise<{ changed: boolean; updated: number }> {
	if (updates.size === 0) return { changed: false, updated: 0 };
	const filePath = categoryFilePath(target, deps.globalDir, deps.projectRoot);
	return deps.mutex.run(filePath, () =>
		deps.plock.withLock(filePath, async () => {
			const raw = await readFileOrEmpty(filePath);
			if (!raw) return { changed: false, updated: 0 };
			const { head, blocks } = splitBlocks(raw);
			if (blocks.length === 0) return { changed: false, updated: 0 };

			let updated = 0;
			const kept: MemoryEntry[] = [];
			for (const block of blocks) {
				const next = updates.get(block.id);
				if (!next || next.length === 0) {
					kept.push(block.entry);
					continue;
				}
				if (next.length === block.entry.tags.length && next.every((t, i) => t === block.entry.tags[i])) {
					kept.push(block.entry);
					continue;
				}
				updated++;
				kept.push({ ...block.entry, tags: next });
			}
			if (updated === 0) return { changed: false, updated: 0 };

			const content = `${head ? `${head}\n\n` : ""}${kept.map(serializeEntry).join("")}`;
			await fs.writeFile(`${filePath}.bak`, raw, "utf8");
			await fs.writeFile(filePath, content, "utf8");
			return { changed: true, updated };
		}),
	);
}
