/**
 * Terminal report for the `/memory` command: the injected keyword index, the
 * consolidation watermark, the health signals that need a human decision, and
 * where the files live — without dumping the store (a merge candidate shows a
 * 60-char snippet, because a duplicate cannot be judged otherwise).
 *
 * Pure and deterministic so it can be tested without a session.
 */

import { collectKeywords, type IndexInput, type UsageMap } from "./index-map.ts";
import { describeConflict, findConflictCandidates } from "./conflicts.ts";
import { describeCandidate, findDuplicateCandidates, type DuplicateCandidate } from "./duplicates.ts";
import { summarizeStaleness, type StalenessSummary } from "./staleness.ts";
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
	/** Max near-duplicate pairs listed per layer (default 5). */
	maxCandidates?: number;
	/** Max likely-superseded pairs listed per layer (default 3). */
	maxConflicts?: number;
	/** Keyword recall counts from memory_search (usage.ts). */
	usage?: { global?: UsageMap; project?: UsageMap };
	/** Staleness override in months (0 = per-file defaults, see staleness.ts). */
	reviewMonths?: number;
	/** Current time (ms); injectable for deterministic tests. */
	now?: number;
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
	const usage = layer === "global" ? opts.usage?.global : opts.usage?.project;
	const table = collectKeywords(entries, layer, { ...(usage ? { usage } : {}) });
	const label = layer === "global" ? "global" : `project: ${opts.projectName || "project"}`;
	if (table.entryCount === 0) return `${label} — (no memories)`;

	const due = opts.threshold > 0 && stats.sinceLast >= opts.threshold ? " · consolidation DUE" : "";
	const header = `${label} — ${table.entryCount} ${table.entryCount === 1 ? "memory" : "memories"} · ${table.total} keyword${table.total === 1 ? "" : "s"} · sinceLast=${stats.sinceLast}/${opts.threshold}${due}`;
	const health = healthLine(table, usage ?? {}, summarizeStaleness(entries, layer, { reviewMonths: opts.reviewMonths ?? 0, now: opts.now }));
	const items = table.rows.map((row) => `#${row.display}${row.count > 1 ? ` (${row.count})` : ""}`);
	const file = layer === "global" ? `${opts.globalDir}/MEMORY.md` : `${opts.projectRoot}/.pi/agent/memory-auto/MEMORY.md`;
	const candidates = candidateBlock(layer, entries, opts);
	const conflicts = conflictBlock(layer, entries, opts);
	return [
		header,
		wrapKeywords(items, opts.width ?? 88),
		...(health ? [health] : []),
		...(candidates ? [candidates] : []),
		...(conflicts ? [conflicts] : []),
		`  file: ${file}${table.dropped > 0 ? ` · ${table.dropped} over the 200-keyword cap` : ""}`,
	].join("\n");
}

/**
 * Health counters that need a decision (nothing here is automatic).
 *
 * A non-zero counter is an instruction, not a warning: superseded rows can be
 * merged away by a consolidation round, never-recalled keywords are what
 * `/memory rebuild` re-derives, and stale entries are re-confirmed by writing
 * them again or replaced with `supersedes`. Nothing is ever deleted
 * automatically.
 */
function healthLine(table: ReturnType<typeof collectKeywords>, usage: UsageMap, stale: StalenessSummary): string {
	const parts: string[] = [];
	if (table.superseded > 0) parts.push(`${table.superseded} superseded (kept on disk, out of the index)`);

	// "Never recalled" is only meaningful once searching has actually happened:
	// on a fresh install every keyword has zero recalls, which would read as a
	// problem when it is just an empty log.
	const recalls = table.rows.reduce((sum, row) => sum + (usage[row.key] ?? 0), 0);
	if (recalls >= 5) {
		const cold = table.rows.filter((row) => (usage[row.key] ?? 0) === 0).length;
		if (cold > 0) parts.push(`${cold}/${table.rows.length} keywords never recalled`);
	}

	if (stale.total > 0) {
		const detail = stale.byFile.map((f) => `${f.file} ${f.count}`).join(", ");
		parts.push(`${stale.total} stale — re-verify (${detail})`);
	}

	return parts.length > 0 ? `  health: ${parts.join(" · ")}` : "";
}

/**
 * Near-duplicate pairs for one layer.
 *
 * These are the only entries a consolidation round should look at first, so
 * the block is also the thing that turns "consolidate every N memories" (which
 * usually finds nothing) into a targeted action.
 */
function candidateBlock(layer: Layer, entries: IndexInput[], opts: ReportOptions): string {
	const scoped = entries.filter(({ entry }) => entry.layer === layer);
	if (scoped.length < 2) return "";
	const found: DuplicateCandidate[] = findDuplicateCandidates(scoped, { limit: opts.maxCandidates ?? 5 });
	if (found.length === 0) return "";
	const cmd = layer === "global" ? "user" : "project";
	const lines = [`  merge candidates (${found.length}) — /memory compact ${cmd}:`];
	for (const candidate of found) {
		for (const line of describeCandidate(candidate, 60).split("\n")) lines.push(`    ${line}`);
	}
	return lines.join("\n");
}

/**
 * Pairs that look like two VERSIONS OF ONE FACT, newer one second.
 *
 * These are the memories behind the "I changed the requirement and the old one
 * kept being read" failure: a merge will not touch them (they are not
 * duplicates — see conflicts.ts), so they need either a supersede or a human
 * verdict. Both are shown, newest last, because judging the pair requires
 * seeing what changed.
 */
function conflictBlock(layer: Layer, entries: IndexInput[], opts: ReportOptions): string {
	const scoped = entries.filter(({ entry }) => entry.layer === layer);
	if (scoped.length < 2) return "";
	const found = findConflictCandidates(scoped, { limitPerLayer: opts.maxConflicts ?? 3 });
	if (found.length === 0) return "";
	const cmd = layer === "global" ? "user" : "project";
	const lines = [
		`  possible superseded requirements (${found.length}) — older vs newer; if the newer one is current, write it again with supersedes:[older id], or /memory compact ${cmd} to let the pass decide:`,
	];
	for (const candidate of found) {
		for (const line of describeConflict(candidate, 60).split("\n")) lines.push(`    ${line}`);
	}
	return lines.join("\n");
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
		"/memory compact <project|user> (merge duplicates) · /memory rebuild <project|user> (re-derive keywords)",
	];
	return blocks.join("\n");
}
