/**
 * Keyword rules — the contract for what a keyword is.
 *
 * Rules (product spec):
 * - Every memory has exactly ONE keyword (never zero, never more).
 * - A keyword is at most 8 characters (CJK) or 8 words (latin).
 * - Keywords are unique *per layer* in MEMORY.md; many memories may share one.
 * - A layer's keyword table holds at most 200 keywords.
 *
 * Why one: the index is a topic map, not a summary. A model asked for "1-3"
 * almost always spends the whole budget, which triples the index size for the
 * same number of memories and buries the strong hook in two weak ones. One
 * keyword per memory also makes the `(N)` count in MEMORY.md mean exactly
 * "N memories are about this", which is what makes the table readable.
 *
 * Two forms per keyword:
 * - `key`: the canonical matching form — lowercase, all separators removed, so
 *   `serializeConversation`, `serialize-conversation` and `Serialize Conversation`
 *   all collapse to `serializeconversation`. Lookup and uniqueness use this.
 * - `display`: what MEMORY.md shows — lowercase with internal whitespace turned
 *   into '-', separators otherwise preserved (camelCase stays readable).
 */

/** Min/max keywords per memory — exactly one. */
export const MIN_KEYWORDS = 1;
/** Maximum keywords per memory. */
export const MAX_KEYWORDS = 1;
/** Maximum characters for a CJK keyword. */
export const MAX_CJK_CHARS = 8;
/** Maximum words for a latin (whitespace-separated) keyword. */
export const MAX_LATIN_WORDS = 8;
/** Maximum characters for a single latin token (identifiers can be long). */
export const MAX_LATIN_TOKEN_CHARS = 24;
/** Maximum keywords in one layer's MEMORY.md. */
export const MAX_KEYWORDS_PER_LAYER = 200;

const HAN = /\p{Script=Han}/u;

/** Canonical matching form: lowercase, separators removed. */
export function keywordKey(raw: string): string {
	return raw
		.trim()
		.replace(/^#+/, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Display form for MEMORY.md: lowercase, internal whitespace -> '-'. */
export function keywordDisplay(raw: string): string {
	return raw
		.trim()
		.replace(/^#+/, "")
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/-{2,}/g, "-");
}

/**
 * Validate one keyword. Returns an actionable message, or null when valid.
 */
export function keywordIssue(raw: string): string | null {
	const text = raw.trim().replace(/^#+/, "");
	if (!text) return "keyword is empty";
	// A '#' is a list separator, never part of a keyword. Letting one through
	// creates a blob like "memory-write-#tool-quirk" that no lookup can match.
	if (text.includes("#")) return "contains '#' inside the keyword (use one keyword per value)";
	if (/\s/.test(text)) {
		const words = text.split(/\s+/).filter(Boolean).length;
		if (words > MAX_LATIN_WORDS) return `${words} words (max ${MAX_LATIN_WORDS})`;
		return null;
	}
	if (HAN.test(text)) {
		const chars = [...text].length;
		return chars > MAX_CJK_CHARS ? `${chars} characters (max ${MAX_CJK_CHARS})` : null;
	}
	return text.length > MAX_LATIN_TOKEN_CHARS ? `${text.length} characters (max ${MAX_LATIN_TOKEN_CHARS})` : null;
}

export interface SanitizeResult {
	/** Accepted keywords, in input order, unique by key, at most MAX_KEYWORDS. */
	keywords: string[];
	/** Rejected candidates with the reason (for tool errors / logs). */
	issues: string[];
	/** Valid keywords dropped because the budget was already full. */
	dropped: number;
}

/**
 * Normalize, validate and cap a keyword list.
 *
 * Each candidate is split first (see splitTagCandidates), so a model answering
 * `TAGS: memory-write #tool-quirk` or `a, b` never stores one glued blob. Each
 * surviving keyword is validated, deduped by canonical key and the list is
 * capped at MAX_KEYWORDS.
 *
 * Going over the cap is NOT an error: a model that answers with three keywords
 * keeps the first and the rest are counted in `dropped`. Rejecting the call
 * instead would cost a full round-trip to learn what the cap already knows.
 *
 * Never throws; the caller decides whether an empty result is fatal.
 */
export function sanitizeKeywords(raw: readonly string[]): SanitizeResult {
	const keywords: string[] = [];
	const issues: string[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	for (const candidate of raw.flatMap((t) => splitTagCandidates(t))) {
		const display = keywordDisplay(candidate);
		const key = keywordKey(candidate);
		if (!key) {
			issues.push(`"${candidate.trim()}": empty keyword`);
			continue;
		}
		if (seen.has(key)) continue; // silently dedupe: same keyword twice
		const issue = keywordIssue(display);
		if (issue) {
			issues.push(`"${candidate.trim()}": ${issue}`);
			continue;
		}
		if (keywords.length >= MAX_KEYWORDS) {
			dropped++;
			continue;
		}
		seen.add(key);
		keywords.push(display);
	}
	return { keywords, issues, dropped };
}

/**
 * Split a raw tag field into candidate keywords.
 *
 * A `#` anywhere is a list separator, never part of a keyword — that is how the
 * pre-0.5 extractor stored `#ui-taste #design-feedback #screenshots` as ONE tag
 * (which reached the index as the unsearchable blob
 * `#ui-taste-#design-feedback-#screenshots`), and how a model answering
 * `TAGS: memory-write #tool-quirk` used to store one glued keyword. Commas are
 * separators too.
 *
 * A genuine multi-word keyword (`Serialize Conversation`, allowed up to 8 words)
 * contains no `#` and is kept whole.
 */
export function splitTagCandidates(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.includes("#")) {
		return trimmed
			.split(/[#,\s]+/)
			.map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
			.filter(Boolean);
	}
	return trimmed
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

export interface CoerceResult {
	/** Keywords that satisfy the contract (exactly one, valid). */
	keywords: string[];
	/** The stored tag field violated the contract and should be rewritten. */
	changed: boolean;
	/** No usable keyword was stored, so one was derived from the text. */
	derived: boolean;
}

/**
 * Repair a stored tag list: split dirty separators, validate each keyword, keep
 * the first, and derive one from the body when nothing survives.
 *
 * Read-path only — it never writes. An entry stored with three keywords (the
 * old contract) therefore reaches the index as one keyword; `changed` is true
 * for it, which is what `/memory rebuild` reports as "collapsed".
 */
export function coerceKeywords(tags: readonly string[], text = ""): CoerceResult {
	const candidates = tags.flatMap((t) => splitTagCandidates(t));
	const { keywords } = sanitizeKeywords(candidates);
	if (keywords.length > 0) {
		const changed = keywords.length !== tags.length || keywords.some((k, i) => k !== tags[i]);
		return { keywords, changed, derived: false };
	}
	return { keywords: [deriveKeyword(text)], changed: true, derived: true };
}

/**
 * Derive a keyword from an entry's text when none was supplied.
 * Prefers backticked identifiers, then latin identifiers, then CJK runs.
 */
export function deriveKeyword(text: string): string {
	const ticked = /`([^`\n]{2,40})`/.exec(text)?.[1];
	if (ticked) {
		const candidate = keywordDisplay(ticked.split(/[()\s]/)[0] ?? ticked);
		if (candidate && !keywordIssue(candidate)) return candidate;
	}
	const latin = /\b([A-Za-z][A-Za-z0-9_.-]{2,23})\b/.exec(text)?.[1];
	if (latin) {
		const candidate = keywordDisplay(latin);
		if (!keywordIssue(candidate)) return candidate;
	}
	const han = /\p{Script=Han}{2,8}/u.exec(text)?.[0];
	if (han) return han;
	return "misc";
}
