/**
 * Existing-memories digest for the review / handoff prompts.
 *
 * The digest exists for exactly two purposes: dedup ("this is already stored")
 * and correction ("this memory is now wrong"). Both fail silently if the entry
 * the model needs to see is not in the prompt.
 *
 * The previous implementation (inline in index.ts) sorted strictly by time and
 * cut at a character cap, so a large store showed only the newest rows. The
 * consequences were exactly the two reported bugs:
 * - the same fact re-recorded months later could not be deduped (its old row
 *   was not in the prompt), so the store grew near-duplicates;
 * - a requirement corrected months later could not be superseded (the old row
 *   was not in the prompt), so search kept returning the stale answer.
 *
 * This module selects by RELEVANCE to the current conversation instead:
 * 1. every entry is tokenized once (duplicates.ts textTokens, Han bigrams);
 * 2. a cheap candidate reduction drops entries sharing no token with the
 *    conversation, so the quadratic part stays small on a large store;
 * 3. the best-scoring entries are admitted first, then the newest entries fill
 *    the remaining budget (a fresh fact must always be available for dedup).
 *
 * Ranking only decides WHO gets in; rendering is always newest-first, matching
 * how a correction is read: the latest statement is the one to keep.
 *
 * Deterministic and side-effect free: same input, same output.
 */

import { EXISTING_MEMORIES_MAX_CHARS } from "./constants.ts";
import { jaccard, textTokens } from "./duplicates.ts";
import type { MemoryEntry } from "./types.ts";

export interface DigestEntry {
	entry: MemoryEntry;
	/** Source label as returned by loadAllEntries, e.g. "project/FAILURES.md". */
	file: string;
}

export interface DigestOptions {
	/** Character budget for the whole digest. Default EXISTING_MEMORIES_MAX_CHARS. */
	maxChars?: number;
	/** Minimum relevance score for an entry to be ranked as relevant. */
	minScore?: number;
}

/** Tokens shorter than this contribute noise, not signal. */
const MIN_TOKEN_LEN = 2;
/** Weight of keyword overlap relative to body-token overlap. */
const KEYWORD_WEIGHT = 0.35;
/** Longest per-entry body in the digest; keeps one huge entry from eating the budget. */
const MAX_LINE_TEXT = 400;
/** Longest body shown for an already-superseded entry (id + gist is enough). */
const MAX_DEAD_LINE_TEXT = 160;
/** Room reserved for the "N more memories not shown" footer. */
const NOTE_RESERVE = 48;

/**
 * Render the digest of `entries` for `transcript`.
 *
 * An empty transcript means "no conversation signal": the result is then just
 * the newest entries that fit the budget.
 */
export function buildExistingMemoriesDigest(entries: DigestEntry[], transcript: string, opts: DigestOptions = {}): string {
	const maxChars = opts.maxChars ?? EXISTING_MEMORIES_MAX_CHARS;
	const minScore = opts.minScore ?? 0.05;
	if (entries.length === 0 || maxChars <= 0) return "";

	// Newest first: this is the render order AND the tie-break order.
	const sorted = [...entries].sort((a, b) => (a.entry.time < b.entry.time ? 1 : a.entry.time > b.entry.time ? -1 : 0));
	const lines = sorted.map(renderLine);

	const order = admitOrder(sorted, lines, transcript, minScore);
	const kept = fitToBudget(order, lines, Math.max(1, maxChars - NOTE_RESERVE));
	const keptSorted = [...kept].sort((a, b) => a - b);

	const body = keptSorted.map((i) => lines[i]!).join("\n");
	const omitted = lines.length - keptSorted.length;
	if (omitted <= 0) return body.length <= maxChars ? body : body.slice(0, maxChars);
	// Drop trailing lines until the footer fits.
	let out = body;
	while (out.length + 1 + omittedNote(omitted).length > maxChars && keptSorted.length > 0) {
		keptSorted.pop();
		out = keptSorted.map((i) => lines[i]!).join("\n");
	}
	const dropped = lines.length - keptSorted.length;
	const finalBody = keptSorted.map((i) => lines[i]!).join("\n");
	return dropped > 0 ? `${finalBody}\n${omittedNote(dropped)}` : finalBody;
}

/** Admission order (indices into `lines`): relevant first, then newest-first. */
function admitOrder(sorted: DigestEntry[], lines: string[], transcript: string, minScore: number): number[] {
	const query = queryTokens(transcript);
	const newestFirst = lines.map((_, i) => i);
	if (query.size === 0) return newestFirst;

	const prepared = sorted.map((d) => ({ tokens: textTokens(d.entry.text), keywords: new Set(d.entry.tags.map((t) => t.toLowerCase())) }));

	// Cheap reduction: a shared token is a necessary condition for any score.
	const scored: { index: number; score: number }[] = [];
	for (let i = 0; i < prepared.length; i++) {
		const p = prepared[i]!;
		let shares = false;
		for (const t of query) {
			if (t.length < MIN_TOKEN_LEN) continue;
			if (p.tokens.has(t) || p.keywords.has(t)) {
				shares = true;
				break;
			}
		}
		if (!shares) continue;
		const score = jaccard(p.tokens, query) + KEYWORD_WEIGHT * keywordOverlap(p.keywords, query);
		if (score >= minScore) scored.push({ index: i, score });
	}
	scored.sort((a, b) => b.score - a.score || a.index - b.index);

	const admitted = new Set(scored.map((s) => s.index));
	return [...scored.map((s) => s.index), ...newestFirst.filter((i) => !admitted.has(i))];
}

/** Greedy admission by rank within the budget; returns admitted line indices. */
function fitToBudget(order: number[], lines: string[], maxChars: number): Set<number> {
	const kept = new Set<number>();
	let total = 0;
	for (const index of order) {
		const cost = lines[index]!.length + 1; // + newline
		if (total + cost > maxChars) continue;
		kept.add(index);
		total += cost;
	}
	return kept;
}

function omittedNote(count: number): string {
	return `(${count} more stored ${count === 1 ? "memory" : "memories"} not shown here.)`;
}

/** Relevance tokens of the transcript, capped so one huge transcript cannot dominate. */
function queryTokens(transcript: string): Set<string> {
	const tail = transcript.length > 20_000 ? transcript.slice(-20_000) : transcript;
	const tokens = textTokens(tail);
	if (tokens.size > 400) {
		// Sorted slice, not insertion order: keeps the result deterministic.
		return new Set([...tokens].sort().slice(0, 400));
	}
	return tokens;
}

function keywordOverlap(keywords: Set<string>, query: Set<string>): number {
	if (keywords.size === 0 || query.size === 0) return 0;
	let hit = 0;
	for (const k of keywords) {
		if (query.has(k)) {
			hit++;
			continue;
		}
		for (const t of query) {
			if (t.length >= MIN_TOKEN_LEN && (k.includes(t) || t.includes(k))) {
				hit++;
				break;
			}
		}
	}
	return hit / keywords.size;
}

/**
 * One digest line. Superseded entries are listed too — otherwise the model
 * re-writes a fact that was already corrected — and flagged with the id that
 * replaced them. Their bodies are shortened harder than a live memory's: they
 * cost prompt space but are only worth naming, not reading.
 */
export function renderLine({ entry, file }: DigestEntry): string {
	const text = entry.text.trim().replace(/\s+/g, " ");
	const cap = entry.supersededBy ? MAX_DEAD_LINE_TEXT : MAX_LINE_TEXT;
	const safeText = text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
	const tags = entry.tags.length > 0 ? ` #${entry.tags.join(" #")}` : "";
	const dead = entry.supersededBy ? ` (superseded by ${entry.supersededBy})` : "";
	return `- [${entry.id}] [${file}]${tags}${dead} ${safeText}`;
}
