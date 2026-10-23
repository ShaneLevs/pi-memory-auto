/**
 * Keyword rules — the contract for what a keyword is.
 *
 * Rules (product spec):
 * - Every memory has 1–3 keywords (never zero).
 * - A keyword is at most 8 characters (CJK) or 8 words (latin).
 * - Keywords are unique *per layer* in MEMORY.md, but many memories may share
 *   one keyword, and one memory may have several.
 * - A layer's keyword table holds at most 200 keywords.
 *
 * Two forms per keyword:
 * - `key`: the canonical matching form — lowercase, all separators removed, so
 *   `serializeConversation`, `serialize-conversation` and `Serialize Conversation`
 *   all collapse to `serializeconversation`. Lookup and uniqueness use this.
 * - `display`: what MEMORY.md shows — lowercase with internal whitespace turned
 *   into '-', separators otherwise preserved (camelCase stays readable).
 */

/** Minimum keywords per memory. */
export const MIN_KEYWORDS = 1;
/** Maximum keywords per memory. */
export const MAX_KEYWORDS = 3;
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
}

/**
 * Normalize, validate and cap a keyword list.
 * Never throws; the caller decides whether an empty result is fatal.
 */
export function sanitizeKeywords(raw: readonly string[]): SanitizeResult {
	const keywords: string[] = [];
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const candidate of raw) {
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
			issues.push(`"${candidate.trim()}": more than ${MAX_KEYWORDS} keywords`);
			continue;
		}
		seen.add(key);
		keywords.push(display);
	}
	return { keywords, issues };
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
