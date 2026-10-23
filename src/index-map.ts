/**
 * Keyword table builder — the only injected memory content.
 *
 * MEMORY.md (and the injected block) is a table of unique keywords: one line
 * per keyword, no bodies, no gists. The agent sees the keyword, decides it
 * relates to the current task, and calls memory_search with that keyword (plus
 * its own synonyms/translations) to pull the entry text.
 *
 * Invariants (see keywords.ts for the per-keyword rules):
 * - one line per canonical keyword key, so `serializeConversation` and
 *   `serialize-conversation` cannot both appear
 * - many memories may share a keyword (the count is shown); one memory may
 *   have 1–3 keywords
 * - at most MAX_KEYWORDS_PER_LAYER keywords; the least-used ones are dropped
 * - deterministic: same entries → same bytes, so the session snapshot is stable
 */

import { MAIN_FILE } from "./constants.ts";
import { MAX_KEYWORDS, MAX_KEYWORDS_PER_LAYER, coerceKeywords, keywordDisplay, keywordKey } from "./keywords.ts";

export { MAX_KEYWORDS_PER_LAYER };
import type { Layer, MemoryEntry } from "./types.ts";

export interface IndexInput {
	entry: MemoryEntry;
	/** Source label, e.g. "project/FAILURES.md". */
	file: string;
}

export interface LayerIndexOptions {
	/** Character budget for this layer's rendered table. */
	budget: number;
	/** Max keyword lines listed (defaults to the 200-per-layer cap). */
	maxKeywords?: number;
	/** Current time (ms); injectable for deterministic tests. */
	now?: number;
	/** Project name for the header; inferred from entries when absent. */
	projectName?: string;
	/** Print the layer header line (off for the MEMORY.md file body). */
	header?: boolean;
	/** Keyword recall counts, for ranking (see usage.ts). */
	usage?: UsageMap;
}

/** Keyword key -> recall count from memory_search (usage.ts). */
export type UsageMap = Record<string, number>;

export interface KeywordRow {
	/** Canonical matching key. */
	key: string;
	/** Display form. */
	display: string;
	/** How many memories use this keyword. */
	count: number;
}

export interface KeywordTable {
	rows: KeywordRow[];
	/** Distinct keywords found (before the per-layer cap). */
	total: number;
	/** Keywords dropped by the per-layer cap. */
	dropped: number;
	/** Memories in this layer (excluding MEMORY.md itself). */
	entryCount: number;
	/** Memories that had no usable keyword and got a derived one. */
	derived: number;
	/** Memories replaced by a newer entry: on disk, but out of the index. */
	superseded: number;
}

export interface LayerIndex {
	text: string;
	/** Keywords that did not fit the budget. */
	hidden: number;
	entryCount: number;
	keywordCount: number;
}

/**
 * Keywords used by one entry, normalized.
 *
 * Stored tag fields are repaired first (see coerceKeywords), so legacy entries
 * whose tags were space-separated contribute their individual keywords instead
 * of one unsearchable blob, and entries without any usable keyword get one
 * derived from the text — the index never loses reachability.
 */
export function entryKeywords(entry: MemoryEntry): { keywords: string[]; derived: boolean } {
	const { keywords, derived } = coerceKeywords(entry.tags, entry.text);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const keyword of keywords) {
		const key = keywordKey(keyword);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(keywordDisplay(keyword));
		if (out.length >= MAX_KEYWORDS) break;
	}
	return { keywords: out, derived };
}

/** Build the de-duplicated, ranked keyword table for one layer. */
export function collectKeywords(
	entries: IndexInput[],
	layer: Layer,
	opts: { maxKeywords?: number; usage?: UsageMap } = {},
): KeywordTable {
	const cap = opts.maxKeywords ?? MAX_KEYWORDS_PER_LAYER;
	const usage = opts.usage ?? {};
	const byKey = new Map<string, KeywordRow>();
	let entryCount = 0;
	let derived = 0;
	let superseded = 0;

	for (const { entry, file } of entries) {
		if (entry.layer !== layer) continue;
		if (file.endsWith(`/${MAIN_FILE}`)) continue;
		entryCount++;
		// A replaced memory keeps its row and stays searchable, but its keywords
		// must not occupy index slots that live memories need. This is the whole
		// "forgetting" story for the index: stop advertising it, delete nothing.
		if (entry.supersededBy) {
			superseded++;
			continue;
		}

		const { keywords, derived: isDerived } = entryKeywords(entry);
		if (isDerived) derived++;
		for (const display of keywords) {
			const key = keywordKey(display);
			const existing = byKey.get(key);
			if (!existing) {
				byKey.set(key, { key, display, count: 1 });
				continue;
			}
			existing.count++;
			// Deterministic display choice: keep the lexicographically smallest form.
			if (display < existing.display) existing.display = display;
		}
	}

	const rows = [...byKey.values()];
	// Rank: most-shared first, then keywords the agent has actually recalled
	// with (usage.ts), then alphabetical (stable + scannable).
	//
	// Recalls are capped at 4 for ranking, so a keyword that is both shared by
	// several memories and proven useful wins the budget, while one lucky search
	// cannot promote a singleton over a keyword used by five memories.
	const weight = (row: KeywordRow): number => row.count + Math.min(usage[row.key] ?? 0, 4);
	rows.sort((a, b) => {
		const diff = weight(b) - weight(a);
		if (diff !== 0) return diff;
		if (b.count !== a.count) return b.count - a.count;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
	const total = rows.length;
	const kept = rows.slice(0, cap);
	return { rows: kept, total, dropped: total - kept.length, entryCount, derived, superseded };
}

function countSuffix(count: number): string {
	return count > 1 ? ` (${count})` : "";
}

/**
 * Render a keyword table within `budget` characters.
 * `header` is prepended when provided (used for the injected block).
 *
 * Degrades in stages instead of cutting once (claude-mem's ContextBudget idea,
 * at keyword granularity — a keyword is never half-written):
 *
 * 1. one line per keyword with its memory count;
 * 2. the remaining keywords packed onto continuation lines WITHOUT counts
 *    (a count costs 4 chars and is the least useful information in the table);
 * 3. only past that is the rest collapsed into a "+N more" hint.
 *
 * Stage 2 roughly doubles the number of topics that fit a fixed budget, and the
 * hint points at `keyword` search (a real lookup), not at `recent` (a listing).
 */
export function renderKeywordTable(
	rows: KeywordRow[],
	opts: { budget: number; header?: string; maxKeywords?: number },
): { text: string; shown: number; hidden: number } {
	const limit = Math.min(rows.length, opts.maxKeywords ?? MAX_KEYWORDS_PER_LAYER);
	const lines: string[] = [];
	let used = opts.header ? opts.header.length : 0;
	let shown = 0;

	for (let i = 0; i < limit; i++) {
		const row = rows[i]!;
		const line = `#${row.display}${countSuffix(row.count)}`;
		if (used + line.length + 1 > opts.budget) break;
		lines.push(line);
		used += line.length + 1;
		shown++;
	}

	// Stage 2: pack what is left without the counts.
	let inline = "";
	while (shown < limit) {
		const item = `#${rows[shown]!.display}`;
		const candidate = inline ? `${inline} ${item}` : item;
		if (used + candidate.length + 1 > opts.budget) break;
		inline = candidate;
		shown++;
	}
	if (inline) {
		lines.push(inline);
		used += inline.length + 1;
	}

	const hidden = rows.length - shown;
	if (hidden > 0) lines.push(`(+${hidden} more — memory_search mode:"keyword")`);
	const body = lines.join("\n");
	const text = opts.header ? `${opts.header}\n${body}` : body;
	return { text, shown, hidden };
}

/** Build one layer's injected index section (header + keyword lines). */
export function buildLayerIndex(entries: IndexInput[], layer: Layer, opts: LayerIndexOptions): LayerIndex {
	const table = collectKeywords(entries, layer, { ...(opts.usage ? { usage: opts.usage } : {}) });
	if (table.entryCount === 0) return { text: "", hidden: 0, entryCount: 0, keywordCount: 0 };

	const projectName = opts.projectName || entries.find((e) => e.entry.layer === "project")?.entry.project || "";
	const label = layer === "global" ? "global" : `project: ${projectName || "project"}`;
	const header =
		opts.header === false
			? undefined
			: `${label} — ${table.entryCount} ${table.entryCount === 1 ? "memory" : "memories"}, ${table.total} keyword${table.total === 1 ? "" : "s"}`;
	const { text, hidden } = renderKeywordTable(table.rows, {
		budget: opts.budget,
		...(header ? { header } : {}),
		...(opts.maxKeywords !== undefined ? { maxKeywords: opts.maxKeywords } : {}),
	});
	return { text, hidden, entryCount: table.entryCount, keywordCount: table.total };
}

/** Build both layer sections joined with a blank line (used by injection). */
export function buildMemoryIndex(entries: IndexInput[], opts: LayerIndexOptions & { usageByLayer?: { global?: UsageMap; project?: UsageMap } }): string {
	const global = buildLayerIndex(entries, "global", { ...opts, ...(opts.usageByLayer?.global ? { usage: opts.usageByLayer.global } : {}) }).text;
	const project = buildLayerIndex(entries, "project", { ...opts, ...(opts.usageByLayer?.project ? { usage: opts.usageByLayer.project } : {}) }).text;
	return [global, project].filter(Boolean).join("\n\n");
}
