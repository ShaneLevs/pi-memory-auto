/**
 * Index materializer: keeps each layer's MEMORY.md equal to its keyword table.
 *
 * MEMORY.md is derived state, not a source of truth — it is rebuilt
 * deterministically from the category files whenever they change, so it can
 * never go stale and needs no LLM.
 *
 * It also carries the consolidation watermark in a metadata comment:
 *
 *   <!-- stats: entries=16 keywords=51 sinceLast=3 lastConsolidated=- -->
 *
 * `sinceLast` counts memories added since the last consolidation. It grows by
 * the delta in entry count on every rebuild (so restarts, reloads and manual
 * edits are all handled) and is reset to 0 when a consolidation completes.
 * That is the trigger for "every N memories, consolidate".
 */

import fs from "node:fs/promises";
import path from "node:path";
import { MAIN_FILE } from "./constants.ts";
import { collectKeywords, renderKeywordTable, type IndexInput, type UsageMap } from "./index-map.ts";
import { loadAllEntries } from "./search.ts";
import { usagePath, parseUsage } from "./usage.ts";
import { FileMutex, mainFilePath, readFileOrEmpty } from "./store.ts";
import type { Layer } from "./types.ts";

/** Read one layer's keyword usage log (missing/corrupt reads as {}). */
async function loadLayerUsage(layer: Layer, globalDir: string, projectRoot: string): Promise<UsageMap> {
	try {
		return parseUsage(await fs.readFile(usagePath(layer, globalDir, projectRoot), "utf8"));
	} catch {
		return {};
	}
}

/** Banner written at the top of every generated MEMORY.md. */
export const INDEX_BANNER =
	"<!-- AUTO-GENERATED — do not edit. This file is owned entirely by the extension: it is rewritten on every memory write, rebuild and consolidation. The source of truth is the category files in this directory; the memory bodies are never inlined here. -->";

const STATS_RE = /<!--\s*stats:\s*entries=(\d+)\s+keywords=(\d+)\s+sinceLast=(\d+)\s+lastConsolidated=(\S+)\s*-->/;

export interface LayerStats {
	entries: number;
	keywords: number;
	/** Memories added since the last consolidation. */
	sinceLast: number;
	/** ISO timestamp of the last consolidation, or "-". */
	lastConsolidated: string;
	/** True when MEMORY.md changed on disk. */
	written: boolean;
}

export interface MaterializeDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
	/** Character budget for one layer's rendered table. */
	indexBudget: number;
	projectName?: string;
}

/** Parse the stats comment; returns zeros when absent. */
export function parseStats(raw: string): Omit<LayerStats, "written"> {
	const m = STATS_RE.exec(raw);
	if (!m) return { entries: 0, keywords: 0, sinceLast: 0, lastConsolidated: "-" };
	return {
		entries: Number(m[1]),
		keywords: Number(m[2]),
		sinceLast: Number(m[3]),
		lastConsolidated: m[4] ?? "-",
	};
}

/** Render the full MEMORY.md content for a layer (banner + stats + keywords). */
export function renderIndexFile(
	entries: IndexInput[],
	layer: Layer,
	stats: Omit<LayerStats, "written">,
	usage: UsageMap = {},
): string {
	const table = collectKeywords(entries, layer, { usage });
	if (table.entryCount === 0) return "";
	const { text } = renderKeywordTable(table.rows, { budget: Number.MAX_SAFE_INTEGER });
	const statsLine = `<!-- stats: entries=${table.entryCount} keywords=${table.total} sinceLast=${stats.sinceLast} lastConsolidated=${stats.lastConsolidated} -->`;
	return `${INDEX_BANNER}\n${statsLine}\n${text}\n`;
}

/**
 * Rebuild one layer's MEMORY.md.
 * - `resetCounter` is passed after a consolidation: sinceLast restarts at 0.
 * - Writes only when bytes differ.
 */
export async function materializeLayer(
	deps: MaterializeDeps,
	layer: Layer,
	entries: IndexInput[],
	opts: { resetCounter?: boolean; usage?: UsageMap } = {},
): Promise<LayerStats> {
	const filePath = mainFilePath(layer, deps.globalDir, deps.projectRoot);
	return deps.mutex.run(filePath, async () => {
		const existing = await readFileOrEmpty(filePath);
		const previous = parseStats(existing);
		const usage = opts.usage ?? (await loadLayerUsage(layer, deps.globalDir, deps.projectRoot));
		const table = collectKeywords(entries, layer, { usage });
		const entriesNow = table.entryCount;

		if (entriesNow === 0) {
			// Nothing stored: drop a stale table instead of leaving old keywords behind.
			if (existing) await fs.rm(filePath, { force: true });
			return { entries: 0, keywords: 0, sinceLast: 0, lastConsolidated: previous.lastConsolidated, written: Boolean(existing) };
		}

		// Growth since the previous rebuild; merging shrinks the count, so clamp at 0.
		const growth = existing ? Math.max(0, entriesNow - previous.entries) : 0;
		const sinceLast = opts.resetCounter ? 0 : previous.sinceLast + growth;
		const lastConsolidated = opts.resetCounter ? new Date().toISOString() : previous.lastConsolidated;
		const nextStats = { entries: entriesNow, keywords: table.total, sinceLast, lastConsolidated };

		const content = renderIndexFile(entries, layer, nextStats, usage);
		if (existing === content) return { ...nextStats, written: false };
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, "utf8");
		return { ...nextStats, written: true };
	});
}

/**
 * Rebuild the keyword table(s) from one scan of the entries. Never throws.
 *
 * `opts.layers` limits which MEMORY.md files are written, so a project-scoped
 * command cannot touch the user's global index file.
 */
export async function materializeAll(
	deps: MaterializeDeps,
	opts: { resetCounter?: boolean; layers?: readonly Layer[] } = {},
): Promise<{ global: LayerStats; project: LayerStats }> {
	const empty: LayerStats = { entries: 0, keywords: 0, sinceLast: 0, lastConsolidated: "-", written: false };
	const layers = opts.layers ?? (["global", "project"] as const);
	try {
		const entries = await loadAllEntries(deps.globalDir, deps.projectRoot);
		const global = layers.includes("global") ? await materializeLayer(deps, "global", entries, opts) : empty;
		const project = layers.includes("project") ? await materializeLayer(deps, "project", entries, opts) : empty;
		return { global, project };
	} catch {
		return { global: empty, project: empty };
	}
}
