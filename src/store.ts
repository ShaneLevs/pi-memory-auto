/**
 * Storage layer: directories, append writes, per-file async mutex,
 * cross-process lockfile guard, and main-file consolidation trigger check.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { MAIN_FILE, PROJECT_DIR, WRITABLE_FILES, WRITE_DEBOUNCE_MS } from "./constants.ts";
import { generateEntryId, formatTime, serializeEntry } from "./entry.ts";
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

/** Result of an append operation. */
export interface AppendResult {
	entry: MemoryEntry;
	filePath: string;
	/** Cleaned (metadata-stripped) main-file length when the target was a main file — not used for category files. */
}

/**
 * Append one entry to a category file. Returns the stored entry.
 * Appends are atomic enough: single-process mutex + cross-process lockfile +
 * append-only writes.
 */
export async function appendEntry(
	target: WriteTarget,
	text: string,
	opts: { tags?: string[]; source?: MemorySource; globalDir: string; projectRoot: string; mutex: FileMutex; plock: ProcessLock; now?: Date },
): Promise<MemoryEntry> {
	const now = opts.now ?? new Date();
	const entry: MemoryEntry = {
		id: generateEntryId(now),
		time: formatTime(now),
		project: target.layer === "project" ? path.basename(opts.projectRoot) : "",
		layer: target.layer,
		source: opts.source ?? "user",
		tags: opts.tags ?? [],
		text: text.trim(),
	};
	const filePath = categoryFilePath(target, opts.globalDir, opts.projectRoot);
	const key = filePath;
	await opts.mutex.run(key, () =>
		opts.plock.withLock(key, async () => {
			await ensureDirForFile(filePath);
			await fs.appendFile(filePath, serializeEntry(entry), "utf8");
		}),
	);
	return entry;
}

/**
 * Cleaned main-file content: metadata comment lines stripped, whitespace compacted.
 * Used for the consolidation trigger check and as the base of render trimming.
 */
export function cleanMainContent(raw: string): string {
	return raw
		.split("\n")
		.filter((line) => !line.trim().startsWith("<!--") || !line.includes("-->"))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Read the cleaned length of a layer's main file (0 when missing).
 */
export async function mainCleanLength(layer: Layer, globalDir: string, projectRoot: string): Promise<number> {
	const raw = await readFileOrEmpty(mainFilePath(layer, globalDir, projectRoot));
	return cleanMainContent(raw).length;
}

/** Debounce helper for scheduling background consolidation. */
export class Debouncer {
	private timers = new Map<string, NodeJS.Timeout>();

	/** (Re)schedule `fn` for `key` after `ms`. */
	schedule(key: string, fn: () => void | Promise<void>, ms: number = WRITE_DEBOUNCE_MS): void {
		const existing = this.timers.get(key);
		if (existing) clearTimeout(existing);
		const t = setTimeout(() => {
			this.timers.delete(key);
			void fn();
		}, ms);
		// Don't hold the process open for debounced background work.
		t.unref?.();
		this.timers.set(key, t);
	}

	/** Cancel all pending timers (shutdown). */
	clearAll(): void {
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
	}
}

/** Validate that a target is writable (a category file, never the main file). */
export function isWritableTarget(layer: Layer, file: string): file is CategoryFile {
	return (WRITABLE_FILES[layer] as readonly string[]).includes(file);
}
