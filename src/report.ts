/**
 * Terminal report for the `/memory` command: the injected keyword index, the
 * consolidation watermark, and where the files live — without bodies.
 *
 * Pure and deterministic so it can be tested without a session.
 */

import { collectKeywords, type IndexInput } from "./index-map.ts";
import type { Layer } from "./types.ts";

export interface ReportLayerStats {
	entries: number;
	keywords: number;
	sinceLast: number;
	lastConsolidated: string;
}

export interface ReportOptions {
	globalDir: string;
	projectRoot: string;
	projectName?: string;
	/** Consolidation cadence, for the "due" marker. */
	threshold: number;
	global: ReportLayerStats;
	project: ReportLayerStats;
	/** Wrap width for keyword lists. */
	width?: number;
}

/** Join items into lines no longer than `width`, indented by two spaces. */
export function wrapKeywords(items: string[], width = 88, indent = "  "): string {
	if (items.length === 0) return `${indent}(none)`;
	const lines: string[] = [];
	let line = indent;
	for (const item of items) {
		const candidate = line === indent ? `${line}${item}` : `${line}  ${item}`;
		if (candidate.length > width && line !== indent) {
			lines.push(line);
			line = `${indent}${item}`;
			continue;
		}
		line = candidate;
	}
	lines.push(line);
	return lines.join("\n");
}

function layerBlock(
	layer: Layer,
	entries: IndexInput[],
	stats: ReportLayerStats,
	opts: ReportOptions,
): string {
	const table = collectKeywords(entries, layer);
	const label = layer === "global" ? "global" : `project: ${opts.projectName || "project"}`;
	if (table.entryCount === 0) return `${label} — (no memories)`;

	const due = opts.threshold > 0 && stats.sinceLast >= opts.threshold ? " · consolidation DUE" : "";
	const header = `${label} — ${table.entryCount} ${table.entryCount === 1 ? "memory" : "memories"} · ${table.total} keyword${table.total === 1 ? "" : "s"} · sinceLast=${stats.sinceLast}/${opts.threshold}${due}`;
	const items = table.rows.map((row) => `#${row.display}${row.count > 1 ? ` (${row.count})` : ""}`);
	const file = layer === "global" ? `${opts.globalDir}/MEMORY.md` : `${opts.projectRoot}/.pi/agent/memory-auto/MEMORY.md`;
	return [
		header,
		wrapKeywords(items, opts.width ?? 88),
		`  file: ${file}${table.dropped > 0 ? ` · ${table.dropped} over the 200-keyword cap` : ""}`,
	].join("\n");
}

/** Build the full `/memory` report (both layers + usage footer). */
export function buildMemoryReport(entries: IndexInput[], opts: ReportOptions): string {
	const blocks = [
		"pi-memory-auto · keyword index",
		`consolidation: every ${opts.threshold} new memories per layer · last: global ${opts.global.lastConsolidated}, project ${opts.project.lastConsolidated}`,
		"",
		layerBlock("global", entries, opts.global, opts),
		"",
		layerBlock("project", entries, opts.project, opts),
		"",
		"/memory show · /memory compact (merge duplicates now) · /memory rebuild (regenerate MEMORY.md)",
	];
	return blocks.join("\n");
}
