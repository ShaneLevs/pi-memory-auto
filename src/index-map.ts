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
import { MAX_KEYWORDS, MAX_KEYWORDS_PER_LAYER, deriveKeyword, keywordDisplay, keywordKey } from "./keywords.ts";

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
}

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
 * Legacy entries without tags get a keyword derived from their text (never
 * zero keywords), so every memory stays reachable from the index.
 */
export function entryKeywords(entry: MemoryEntry): { keywords: string[]; derived: boolean } {
	const keywords: string[] = [];
	const seen = new Set<string>();
	for (const tag of entry.tags) {
		const key = keywordKey(tag);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		keywords.push(keywordDisplay(tag));
	}
	// Rule: at most 3 keywords per memory. Legacy entries may carry more; the
	// first ones are the intended ones, and the rest stay searchable by text.
	if (keywords.length > 0) return { keywords: keywords.slice(0, MAX_KEYWORDS), derived: false };
	return { keywords: [deriveKeyword(entry.text)], derived: true };
}

/** Build the de-duplicated, ranked keyword table for one layer. */
export function collectKeywords(entries: IndexInput[], layer: Layer, opts: { maxKeywords?: number } = {}): KeywordTable {
	const cap = opts.maxKeywords ?? MAX_KEYWORDS_PER_LAYER;
	const byKey = new Map<string, KeywordRow>();
	let entryCount = 0;
	let derived = 0;

	for (const { entry, file } of entries) {
		if (entry.layer !== layer) continue;
		if (file.endsWith(`/${MAIN_FILE}`)) continue;
		entryCount++;

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
	// Rank: most-shared keywords first, then alphabetical (stable + scannable).
	rows.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const total = rows.length;
	const kept = rows.slice(0, cap);
	return { rows: kept, total, dropped: total - kept.length, entryCount, derived };
}

function countSuffix(count: number): string {
	return count > 1 ? ` (${count})` : "";
}

/**
 * Render a keyword table within `budget` characters.
 * `header` is prepended when provided (used for the injected block).
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
	const hidden = rows.length - shown;
	if (hidden > 0) lines.push(`(+${hidden} more keywords — memory_search mode:"recent")`);
	const body = lines.join("\n");
	const text = opts.header ? `${opts.header}\n${body}` : body;
	return { text, shown, hidden };
}

/** Build one layer's injected index section (header + keyword lines). */
export function buildLayerIndex(entries: IndexInput[], layer: Layer, opts: LayerIndexOptions): LayerIndex {
	const table = collectKeywords(entries, layer);
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
export function buildMemoryIndex(entries: IndexInput[], opts: LayerIndexOptions): string {
	const global = buildLayerIndex(entries, "global", opts).text;
	const project = buildLayerIndex(entries, "project", opts).text;
	return [global, project].filter(Boolean).join("\n\n");
}
