/**
 * memory_search implementation.
 *
 * Retrieval is keyword-driven by design: the injected memory index shows the
 * agent a topic map, and the agent searches with a keyword plus its own
 * synonyms/translations.
 *
 * Query handling is token-based, not regex-based. The previous implementation
 * compiled the *whole query* into one case-insensitive regex, so any multi-word
 * or natural-language query could only match if every word appeared contiguously
 * — which is why the only two real searches ever made (both multi-word, one in
 * Chinese) returned nothing. Now a query is split into tokens, a hit requires
 * only one token (OR semantics), and ranking is by coverage (how many tokens
 * matched), then tag hits, then recency.
 */

import { PROJECT_CATEGORY_FILES, GLOBAL_CATEGORY_FILES } from "./constants.ts";
import { parseEntries, parseTime } from "./entry.ts";
import { MAX_KEYWORDS, coerceKeywords, keywordKey } from "./keywords.ts";
import { daysSinceVerified, isStale, reviewMonthsFor } from "./staleness.ts";
import { categoryFilePath, memoryDir, readFileOrEmpty } from "./store.ts";
import type { MemoryEntry, SearchHit, SearchMode, SearchResult } from "./types.ts";

export interface LoadedEntry {
	entry: MemoryEntry;
	/** Source label, e.g. "project/FAILURES.md". */
	file: string;
}

/** Load all entries from both layers (category files only).
 *
 * MEMORY.md is deliberately NOT read: it is program-owned derived state
 * (a keyword table, no `mid` metadata), never a source of entries. Parsing it
 * here used to add nothing but confusion — it suggested the index file could
 * carry hand-written memories, which the extension never supported.
 */
export async function loadAllEntries(globalDir: string, projectRoot: string): Promise<LoadedEntry[]> {
	const out: LoadedEntry[] = [];
	for (const layer of ["project", "global"] as const) {
		const files = layer === "project" ? PROJECT_CATEGORY_FILES : GLOBAL_CATEGORY_FILES;
		for (const f of files) {
			const filePath = categoryFilePath({ layer, file: f }, globalDir, projectRoot);
			const raw = await readFileOrEmpty(filePath);
			// Location is authoritative for the layer: a project file stays project
			// even if an entry's metadata says otherwise.
			for (const entry of parseEntries(raw)) out.push({ entry: { ...entry, layer }, file: `${layer}/${f}.md` });
		}
	}
	return out;
}

/** Words ignored when tokenizing a query (English + common Chinese). */
const STOPWORDS = new Set([
	"the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "is", "are", "was", "were",
	"be", "with", "by", "from", "as", "how", "what", "when", "where", "why", "which", "who", "do",
	"does", "did", "i", "you", "it", "this", "that", "my", "me", "we", "us", "about", "any", "all",
	"请", "的", "了", "吗", "呢", "吧", "和", "与", "在", "是", "我", "你", "他", "它", "这", "那",
	"有", "就", "都", "也", "很", "帮我", "一下", "怎么", "如何",
]);

const HAN = /\p{Script=Han}/u;

/**
 * Split a query into searchable tokens.
 * Keeps identifiers with dots/slashes/hyphens whole (e.g. "src/store.ts",
 * "turn-counting"), strips leading '#', drops stopwords.
 */
export function tokenize(query: string): string[] {
	const parts = query.toLowerCase().split(/[^\p{L}\p{N}_]/u);
	const out: string[] = [];
	for (const part of parts) {
		const t = part.replace(/^#+/, "").trim();
		if (!t) continue;
		if (STOPWORDS.has(t)) continue;
		if (t.length === 1 && !HAN.test(t)) continue;
		out.push(t);
	}
	return [...new Set(out)];
}

/** Entry id shape: YYYYMMDD-xxxx. */
const ID_RE = /^\d{8}-[0-9a-f]{4}$/i;

/** Recency weight used by ranking (small: content match dominates). */
function recency(time: string, now: number): number {
	const t = parseTime(time);
	if (t <= 0) return 0;
	const ageDays = (now - t) / 86_400_000;
	return Math.max(0, 1.5 - ageDays / 60);
}

interface Scored {
	entry: MemoryEntry;
	file: string;
	score: number;
	matched: number;
}

/** Score one entry against the query tokens. */
function scoreEntry(loaded: LoadedEntry, tokens: string[]): Scored | null {
	const { entry, file } = loaded;
	// Repaired tags, so a legacy space-separated tag field is still matchable.
	const tags = coerceKeywords(entry.tags, entry.text).keywords.map((t) => t.trim().replace(/^#+/, "").toLowerCase()).filter(Boolean);
	const text = entry.text.toLowerCase();
	let matched = 0;
	let tagExact = 0;
	let tagPartial = 0;
	let textHits = 0;

	for (const token of tokens) {
		if (tags.includes(token)) {
			matched++;
			tagExact++;
		} else if (tags.some((t) => t.includes(token) || token.includes(t))) {
			matched++;
			tagPartial++;
		} else if (text.includes(token)) {
			matched++;
			textHits++;
		}
	}
	if (matched === 0) return null;

	const coverage = matched / tokens.length;
	const score = coverage * 10 + tagExact * 4 + tagPartial * 2 + textHits * 0.5;
	return { entry, file, score, matched };
}

/**
 * Search entries.
 * - keyword: token OR-match, ranked by coverage/tag hits/recency
 * - tag: tag match (exact or substring, either direction)
 * - recent: newest first
 * - all: same scorer as keyword with a stronger recency term
 * - id: exact entry id
 *
 * keyword/all fall back to the newest entries when nothing matched, instead of
 * returning an empty result — an index keyword that misses should still show
 * the agent what exists.
 *
 * `opts.reviewMonths` overrides the staleness interval (see staleness.ts);
 * `opts.now` makes the call deterministic in tests.
 */
export function searchEntries(
	all: LoadedEntry[],
	mode: SearchMode,
	query: string,
	page: number,
	pageSize: number,
	opts: { reviewMonths?: number; now?: number } = {},
): SearchResult {
	const now = opts.now ?? Date.now();
	const staleOpts = { now, reviewMonths: opts.reviewMonths ?? 0 };
	const q = query.trim();
	const tokens = tokenize(q);
	let hits: Scored[] = [];
	let fallback = false;

	switch (mode) {
		case "tag": {
			// Exact keyword lookup on the canonical key, so a keyword copied from
			// MEMORY.md always resolves, including across spelling variants.
			const rawQuery = q.split(/[,\s]+/).filter(Boolean);
			const wanted = [...new Set(rawQuery.map((t) => keywordKey(t)).filter(Boolean))];
			for (const loaded of all) {
				const keys = coerceKeywords(loaded.entry.tags, loaded.entry.text).keywords
					.slice(0, MAX_KEYWORDS)
					.map((t) => keywordKey(t))
					.filter(Boolean);
				let score = 0;
				for (const w of wanted) {
					if (keys.includes(w)) score += 10;
					else if (keys.some((k) => k.includes(w) || w.includes(k))) score += 4;
				}
				if (score > 0) hits.push({ entry: loaded.entry, file: loaded.file, score, matched: wanted.length });
			}
			hits.sort((a, b) => recency(b.entry.time, now) - recency(a.entry.time, now));
			break;
		}
		case "id": {
			const target = q.toLowerCase();
			hits = all
				.filter((l) => l.entry.id.toLowerCase() === target)
				.map((l) => ({ entry: l.entry, file: l.file, score: 100, matched: 1 }));
			break;
		}
		case "recent": {
			hits = all.map((l) => ({ entry: l.entry, file: l.file, score: parseTime(l.entry.time), matched: 0 }));
			hits.sort((a, b) => b.score - a.score);
			break;
		}
		case "keyword":
		case "all":
		default: {
			// An id-shaped query is treated as an id lookup even in keyword mode.
			if (ID_RE.test(q)) {
				const target = q.toLowerCase();
				const byId = all.filter((l) => l.entry.id.toLowerCase() === target);
				if (byId.length > 0) {
					hits = byId.map((l) => ({ entry: l.entry, file: l.file, score: 100, matched: 1 }));
					break;
				}
			}
			if (tokens.length === 0) {
				// Empty/stopword-only query: newest first, same as `recent`.
				hits = all.map((l) => ({ entry: l.entry, file: l.file, score: parseTime(l.entry.time), matched: 0 }));
				break;
			}
			const recencyBoost = mode === "all" ? 3 : 1;
			hits = [];
			for (const loaded of all) {
				const s = scoreEntry(loaded, tokens);
				if (s) hits.push({ ...s, score: s.score + recencyBoost * recency(s.entry.time, now) });
			}
			hits.sort((a, b) => b.score - a.score || parseTime(b.entry.time) - parseTime(a.entry.time));
			if (hits.length === 0) {
				fallback = true;
				hits = all.map((l) => ({ entry: l.entry, file: l.file, score: parseTime(l.entry.time), matched: 0 }));
				// Fallback order: the current project's memories first (they are far
				// more likely to be relevant than global ones), then newest.
				hits.sort((a, b) => {
					const la = a.file.startsWith("project/") ? 1 : 0;
					const lb = b.file.startsWith("project/") ? 1 : 0;
					return lb - la || b.score - a.score;
				});
			}
			break;
		}
	}

	const total = hits.length;
	// Superseded entries stay retrievable (the old wording often still carries a
	// detail the replacement dropped) but must never outrank a live memory. Stale
	// ones rank between the two: still true until proven otherwise, but worth
	// less than a memory someone confirmed recently. A stable sort keeps each
	// mode's own ordering intact inside the groups.
	// Ranks are computed once per entry: the comparator runs thousands of times
	// and `isStale` parses a timestamp.
	const ranks = new Map<string, number>();
	const rank = (hit: { entry: MemoryEntry; file: string }): number => {
		const cached = ranks.get(hit.entry.id);
		if (cached !== undefined) return cached;
		const value = hit.entry.supersededBy ? 2 : isStale(hit.entry, hit.file, staleOpts) ? 1 : 0;
		ranks.set(hit.entry.id, value);
		return value;
	};
	hits.sort((a, b) => rank(a) - rank(b));
	const start = Math.max(0, (page - 1) * pageSize);
	const pageHits: SearchHit[] = hits.slice(start, start + pageSize).map((h) => ({
		entry: h.entry,
		file: h.file,
		score: h.score,
		...(rank(h) === 1 ? { stale: true } : {}),
	}));
	return { hits: pageHits, total, page, pageSize, hasMore: start + pageSize < total, fallback, tokens };
}

/** Format search results as model-facing text (entries include metadata). */
export function formatSearchResult(result: SearchResult, mode: SearchMode, query: string): string {
	const header = `mode: ${mode}${query ? `, query: "${query}"` : ""}`;
	if (result.total === 0) {
		return `No memories stored yet, or none match (${header}). If you just wrote one, it may need mode:"recent".`;
	}
	const lines: string[] = [];
	if (result.fallback) {
		const tried = result.tokens?.length ? ` (tokens tried: ${result.tokens.join(", ")})` : "";
		lines.push(`No memory matched${tried}. Showing the ${result.hits.length} most recent entries instead — try a single distinctive keyword, a tag from the memory index, or a translation/synonym.`);
	} else {
		lines.push(
			`Found ${result.total} memor${result.total === 1 ? "y" : "ies"} (${header}) — showing page ${result.page} (${result.hits.length}), ${result.hasMore ? "more pages available (use page=N)" : "no more pages"}.`,
		);
	}
	lines.push("");
	for (const hit of result.hits) {
		const e = hit.entry;
		const tags = e.tags.length > 0 ? e.tags.join(",") : "-";
		const replaced = e.supersededBy ? ` | superseded by [${e.supersededBy}] — prefer that entry` : "";
		// The label is the whole point of staleness: the memory is still returned,
		// but the agent is told to verify it instead of trusting it.
		const stale = !e.supersededBy && hit.stale ? ` | stale (${daysSinceVerified(e)}d, interval ${reviewMonthsFor(hit.file)}mo) — verify before relying on it` : "";
		lines.push(`[${e.id}] ${hit.file} | ${e.time} | src: ${e.source} | tags: ${tags}${replaced}${stale}`);
		lines.push(e.text);
		lines.push("");
	}
	return lines.join("\n").trim();
}
