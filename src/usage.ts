/**
 * Keyword usage log — the read half of a read/write loop.
 *
 * The injected index is the scarcest resource the extension has (a few thousand
 * characters per layer, shared by every keyword in the store). Ranking it by
 * "how many memories share this keyword" alone is a static guess: it says
 * nothing about whether the agent ever found anything with it. So every
 * successful `memory_search` credits the keywords that did the finding, and the
 * index ranks by `count + recalls` from then on.
 *
 * This is a SIDECAR, not memory: `usage.json` lives next to the category files,
 * is never loaded as an entry, never injected, and losing it costs nothing but
 * ranking quality (a missing or corrupt file reads as "no data"). Errors are
 * swallowed for the same reason.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { keywordKey } from "./keywords.ts";
import type { FileMutex } from "./store.ts";
import { memoryDir } from "./store.ts";
import type { Layer, SearchResult } from "./types.ts";

/** keyword key -> number of searches that recalled it. */
export type UsageMap = Record<string, number>;

interface UsageFile {
	v: 1;
	recalls: UsageMap;
	updated: string;
}

/** Cap on tracked keys, so a corrupted/long-lived file cannot grow forever. */
const MAX_KEYS = 5_000;
/** Credit cap per key: a keyword is either useful or not, the exact count stops
 *  mattering after a few hits, and an uncapped counter would let one noisy
 *  session bury every other keyword in the ranking. */
export const RECALL_CAP = 10;

export function usagePath(layer: Layer, globalDir: string, projectRoot: string): string {
	return path.join(memoryDir(layer, globalDir, projectRoot), "usage.json");
}

/** Parse a usage file; anything unreadable is "no data", never an error. */
export function parseUsage(raw: string): UsageMap {
	if (!raw.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as Partial<UsageFile>;
		const recalls = parsed?.recalls;
		if (!recalls || typeof recalls !== "object") return {};
		const out: UsageMap = {};
		for (const [key, value] of Object.entries(recalls)) {
			const n = Number(value);
			if (!key || !Number.isFinite(n) || n <= 0) continue;
			out[key] = Math.min(RECALL_CAP, Math.floor(n));
		}
		return out;
	} catch {
		return {};
	}
}

/** Add one recall for each key (capped). Pure; returns a new map. */
export function creditRecalls(usage: UsageMap, keys: Iterable<string>): UsageMap {
	const next: UsageMap = { ...usage };
	for (const key of keys) {
		const normalized = keywordKey(key);
		if (!normalized) continue;
		next[normalized] = Math.min(RECALL_CAP, (next[normalized] ?? 0) + 1);
	}
	if (Object.keys(next).length > MAX_KEYS) {
		// Keep the most-used keys; a runaway store still ranks sensibly.
		const trimmed = Object.entries(next)
			.sort((a, b) => b[1] - a[1])
			.slice(0, MAX_KEYS);
		return Object.fromEntries(trimmed);
	}
	return next;
}

/** Load both layers' usage maps. Never throws. */
export async function loadUsage(
	globalDir: string,
	projectRoot: string,
): Promise<{ global: UsageMap; project: UsageMap }> {
	const read = async (layer: Layer): Promise<UsageMap> => {
		try {
			return parseUsage(await fs.readFile(usagePath(layer, globalDir, projectRoot), "utf8"));
		} catch {
			return {};
		}
	};
	const [global, project] = await Promise.all([read("global"), read("project")]);
	return { global, project };
}

/**
 * Record one recall of each key, atomically (read-modify-write under the file
 * mutex, temp file + rename). Parallel searches in one session therefore cannot
 * lose each other's credits. Never throws for the caller's sake: a broken log
 * must not break memory_search.
 */
export async function recordRecalls(
	layer: Layer,
	keys: readonly string[],
	deps: { globalDir: string; projectRoot: string; mutex: FileMutex },
): Promise<void> {
	if (keys.length === 0) return;
	const filePath = usagePath(layer, deps.globalDir, deps.projectRoot);
	await deps.mutex.run(filePath, async () => {
		let current: UsageMap = {};
		try {
			current = parseUsage(await fs.readFile(filePath, "utf8"));
		} catch {
			current = {};
		}
		const payload: UsageFile = { v: 1, recalls: creditRecalls(current, keys), updated: new Date().toISOString() };
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
		await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await fs.rename(tmp, filePath);
	});
}

/**
 * Which keywords actually produced a result, grouped by the layer they live in.
 *
 * A keyword is credited only when (a) a returned memory carries it AND (b) it
 * appears in the query the agent typed. Crediting every keyword of every hit
 * instead would just re-measure `count`; crediting keywords the query never
 * mentioned would credit noise. A fallback (`no match → newest entries`) is
 * never credited: nothing was actually found.
 *
 * `recent` mode is excluded for the same reason — it is a listing, not a match.
 */
export function recalledByLayer(result: SearchResult, mode: string): { global: string[]; project: string[] } {
	const out: { global: string[]; project: string[] } = { global: [], project: [] };
	if (result.fallback || result.hits.length === 0 || mode === "recent") return out;
	const tokens = result.tokens.filter((t) => t.length > 0);
	if (tokens.length === 0) return out;

	for (const hit of result.hits) {
		const bucket = out[hit.entry.layer];
		for (const tag of hit.entry.tags) {
			const key = keywordKey(tag);
			if (!key || bucket.includes(key)) continue;
			if (tokens.some((t) => key === t || key.includes(t) || t.includes(key))) bucket.push(key);
		}
	}
	return out;
}
