/**
 * Near-duplicate detection — deterministic, no embeddings, no LLM.
 *
 * Exact duplicates are already folded at write time (store.ts bumps `seen`
 * instead of appending a second row). What is left are near-duplicates: the
 * same fact recorded twice with slightly different wording, usually months
 * apart. Those can only be resolved by a judgement call, so this module never
 * merges anything — it produces CANDIDATES that the user (or a consolidation
 * round) can act on.
 *
 * The scoring is deliberately crude and explainable:
 *
 *   tokenJaccard = |A ∩ B| / |A ∪ B|   on lowercased word tokens
 *                                      (Han runs are compared as 2-grams, since
 *                                       Chinese text has no word delimiters)
 *   kwJaccard    = same, on canonical keyword keys
 *   score        = 0.6 * tokenJaccard + 0.4 * kwJaccard   (1 for an identical body)
 *
 * Two guards keep templated sentences out of the report:
 * - when the bodies carry numbers and the number sets differ, the pair is not a
 *   candidate ("port 80" and "port 81" are different facts, not a rewording);
 * - a pair must be mostly the same text, or overlap plus share two keywords.
 *
 * Both are conservative: a false candidate costs one line in a report, a false
 * merge loses a memory, so the bias is "do not report".
 */

import type { Layer, MemoryEntry } from "./types.ts";
import { normalizeMemoryText } from "./entry.ts";
import { keywordKey } from "./keywords.ts";

const HAN = /\p{Script=Han}/u;

export interface DuplicateSide {
	id: string;
	file: string;
	layer: Layer;
	tags: string[];
	text: string;
}

export interface DuplicateCandidate {
	layer: Layer;
	/** The older entry (by write time). */
	a: DuplicateSide;
	/** The newer entry. */
	b: DuplicateSide;
	/** Combined similarity, 0..1. */
	score: number;
	/** Keyword display forms both entries carry. */
	shared: string[];
}

/** Lowercased comparison tokens; Han runs become overlapping 2-grams. */
export function textTokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const part of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
		if (!part) continue;
		if (HAN.test(part)) {
			if (part.length === 1) out.add(part);
			for (let i = 0; i < part.length - 1; i++) out.add(part.slice(i, i + 2));
			continue;
		}
		// Single letters carry no signal, single digits do: "port 80" vs "port 81"
		// are different memories, and dropping the number would call them equal.
		if (part.length === 1 && !/[0-9]/.test(part)) continue;
		out.add(part);
	}
	return out;
}

/** Jaccard similarity of two sets; 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	return shared / (a.size + b.size - shared);
}

/** Token/keyword sets and normalized body, computed once per entry. */
interface Prepared {
	side: DuplicateSide;
	body: string;
	tokens: Set<string>;
	numbers: Set<string>;
	keywords: Map<string, string>;
}

function prepare({ entry, file }: { entry: MemoryEntry; file: string }): Prepared {
	const keywords = new Map<string, string>();
	for (const tag of entry.tags) {
		const key = keywordKey(tag);
		if (key && !keywords.has(key)) keywords.set(key, tag.trim());
	}
	const tokens = textTokens(entry.text);
	return {
		side: { id: entry.id, file, layer: entry.layer, tags: entry.tags, text: entry.text },
		body: normalizeMemoryText(entry.text),
		tokens,
		numbers: new Set([...tokens].filter((t) => /^[0-9]+$/.test(t))),
		keywords,
	};
}

/** True when the two number sets are equal (both empty counts as equal). */
function sameNumbers(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const n of a) if (!b.has(n)) return false;
	return true;
}

/**
 * Find near-duplicate pairs among `entries`, one layer at a time.
 *
 * `minScore` drops weak pairs; `limit` caps the total returned (best first).
 * Deterministic for a given input, including the output order.
 */
export function findDuplicateCandidates(
	entries: { entry: MemoryEntry; file: string }[],
	opts: { minScore?: number; limit?: number } = {},
): DuplicateCandidate[] {
	const minScore = opts.minScore ?? 0.5;
	const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;
	const out: DuplicateCandidate[] = [];

	for (const layer of ["global", "project"] as const) {
		// A superseded memory has already been replaced: reporting it as a merge
		// candidate would ask the user to re-do a decision they already made.
		const pool = entries.filter(({ entry }) => entry.layer === layer && !entry.supersededBy).map(prepare);
		if (pool.length < 2) continue;

		for (let i = 0; i < pool.length; i++) {
			for (let j = i + 1; j < pool.length; j++) {
				const x = pool[i]!;
				const y = pool[j]!;
				// Same body in both rows should not exist (write-time idempotency),
				// but a legacy store can still carry it: report it, don't hide it.
				const sameBody = x.body.length > 0 && x.body === y.body;
				// A differing number is a differing fact, not a rewording.
				if (!sameBody && !sameNumbers(x.numbers, y.numbers)) continue;

				const tokenScore = sameBody ? 1 : jaccard(x.tokens, y.tokens);
				const kwScore = jaccard(new Set(x.keywords.keys()), new Set(y.keywords.keys()));
				const shared: string[] = [];
				for (const [key, display] of x.keywords) if (y.keywords.has(key)) shared.push(display);
				shared.sort();

				const sharedEnough = shared.length >= 2 && tokenScore >= 0.25;
				if (!sameBody && tokenScore < 0.45 && !sharedEnough) continue;

				const score = sameBody ? 1 : 0.6 * tokenScore + 0.4 * kwScore;
				if (!sameBody && score < minScore) continue;

				// Older first, so the report reads as "this was said before that".
				const [a, b] = x.side.id <= y.side.id ? [x.side, y.side] : [y.side, x.side];
				out.push({ layer, a, b, score: Math.round(score * 100) / 100, shared });
			}
		}
	}

	out.sort((p, q) => q.score - p.score || (p.a.id < q.a.id ? -1 : p.a.id > q.a.id ? 1 : 0));
	return out.slice(0, limit);
}

/** One-line-per-pair rendering shared by the report and the LLM hint. */
export function describeCandidate(candidate: DuplicateCandidate, textChars = 60): string {
	const brief = (text: string) => {
		const one = text.replace(/\s+/g, " ").trim();
		return one.length > textChars ? `${one.slice(0, textChars - 1)}…` : one;
	};
	const shared = candidate.shared.length > 0 ? ` shared: ${candidate.shared.join(", ")}` : "";
	return `[${candidate.a.id}] ↔ [${candidate.b.id}] ${Math.round(candidate.score * 100)}%${shared}\n  "${brief(candidate.a.text)}" / "${brief(candidate.b.text)}"`;
}
