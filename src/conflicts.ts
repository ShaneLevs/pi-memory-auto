/**
 * Conflict candidates — "the requirement changed", not "the same fact twice".
 *
 * duplicates.ts deliberately REFUSES these pairs: when the bodies carry numbers
 * and the number sets differ, it calls them different facts ("port 80" vs
 * "port 81") and drops them. That guard is right for consolidation, which must
 * never merge two genuinely different facts.
 *
 * But that is exactly the shape of a requirement being changed. "部署用 rsync"
 * → "部署改成 GitHub Actions"; "npm 发布" → "npm 发布必须带 tag"; "端口 3000"
 * → "端口 8080". The newer statement is not a duplicate of the older one, it
 * REPLACES it — and because nothing linked the two, both stayed live, both were
 * returned by search, and the agent read whichever ranked first.
 *
 * This module finds those pairs deterministically (no LLM, no embeddings) and
 * hands them to the review prompt as hints, so the extraction call — which is
 * already being paid for — has to decide "which one is current" and emit a
 * SUPERSEDES for the loser.
 *
 * It never supersedes anything itself:
 * - a false positive here costs one line in a prompt;
 * - a wrong automatic supersede silently kills the correct memory.
 *
 * Detection is similarity + divergence:
 *   shared keyword(s)            → same topic (required)
 *   token Jaccard >= MIN_SIMILAR → same area of discourse
 *   differing specifics          → the thing that changed (numbers, or a
 *                                  substantial rewrite of the same sentence)
 */

import { jaccard, textTokens } from "./duplicates.ts";
import { normalizeMemoryText } from "./entry.ts";
import { keywordKey } from "./keywords.ts";
import type { Layer, MemoryEntry } from "./types.ts";

/**
 * Minimum body similarity for a pair to be considered the same topic.
 *
 * A pure rewording that keeps NO number in common scores lower than a changed
 * value does ("deploy via rsync script" → "deploy via GitHub Actions workflow"
 * is ~0.35), and those are the exact pairs this layer exists for. The shared
 * keyword is the primary gate, so a modest body threshold still keeps unrelated
 * facts out.
 */
const MIN_SIMILAR = 0.32;
/** Similarity required when the pair also disagrees on numbers. */
const MIN_SIMILAR_NUMBER_DIVERGENCE = 0.3;
/** Pairs below this are too weak to spend prompt space on. */
const MIN_SCORE = 0.35;
/** Cap on hints per layer, best first. */
const MAX_PER_LAYER = 4;

export interface ConflictSide {
	id: string;
	file: string;
	layer: Layer;
	tags: string[];
	text: string;
	/** Write time as stored (sortable string, YYYY-MM-DD HH:MM:SS). */
	time: string;
}

export interface ConflictCandidate {
	layer: Layer;
	/** The older statement — the one that may be obsolete. */
	older: ConflictSide;
	/** The newer statement — the likely current truth. */
	newer: ConflictSide;
	/** 0..1 confidence that these are two versions of one fact. */
	score: number;
	/** Keyword display forms both entries carry. */
	shared: string[];
	/** Numbers present on one side only, e.g. ["80"] vs ["8080"]. */
	divergingNumbers: string[];
}

interface Prepared {
	side: ConflictSide;
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
		side: { id: entry.id, file, layer: entry.layer, tags: entry.tags, text: entry.text, time: entry.time },
		body: normalizeMemoryText(entry.text),
		tokens,
		numbers: new Set([...tokens].filter((t) => /^[0-9]+$/.test(t))),
		keywords,
	};
}

/** Numbers present in exactly one of the two sets, sorted for determinism. */
function divergingNumbers(a: Set<string>, b: Set<string>): string[] {
	const out: string[] = [];
	for (const n of a) if (!b.has(n)) out.push(n);
	for (const n of b) if (!a.has(n)) out.push(n);
	return out.sort();
}

/**
 * Find pairs that look like two versions of one fact, newest statement last.
 *
 * Only LIVE entries are considered: once a memory is superseded, the decision
 * about it has already been made, and re-reporting it would ask the agent to
 * re-litigate a settled correction.
 *
 * Output order is INPUT order, not score order: this is a hint block, and the
 * caller (consolidation) copies candidates by id into a page-local lookup, so a
 * stable order keeps prompts reproducible for the same store. Ranking only
 * decides WHICH pairs survive `limitPerLayer`.
 */
export function findConflictCandidates(
	entries: { entry: MemoryEntry; file: string }[],
	opts: { minScore?: number; limitPerLayer?: number } = {},
): ConflictCandidate[] {
	const minScore = opts.minScore ?? MIN_SCORE;
	const limitPerLayer = opts.limitPerLayer ?? MAX_PER_LAYER;
	const out: ConflictCandidate[] = [];

	for (const layer of ["global", "project"] as const) {
		const pool = entries.filter(({ entry }) => entry.layer === layer && !entry.supersededBy).map(prepare);
		if (pool.length < 2) continue;

		const found: ConflictCandidate[] = [];
		for (let i = 0; i < pool.length; i++) {
			for (let j = i + 1; j < pool.length; j++) {
				const x = pool[i]!;
				const y = pool[j]!;
				// Identical bodies are a duplicate, not a conflict: write-time
				// idempotency and consolidation already own that case.
				if (x.body.length > 0 && x.body === y.body) continue;

				const shared: string[] = [];
				for (const [key, display] of x.keywords) if (y.keywords.has(key)) shared.push(display);
				// Same topic is the precondition: without a shared keyword the two
				// entries are probably just written in the same style.
				if (shared.length === 0) continue;
				shared.sort();

				const similarity = jaccard(x.tokens, y.tokens);
				const numbers = divergingNumbers(x.numbers, y.numbers);
				const diverges = numbers.length > 0;
				const threshold = diverges ? MIN_SIMILAR_NUMBER_DIVERGENCE : MIN_SIMILAR;
				if (similarity < threshold) continue;

				// A differing number is the strongest "this changed" signal, so it
				// carries most of the score; a pure rewording still qualifies but
				// ranks lower.
				const score = diverges ? 0.55 * similarity + 0.45 : similarity;
				if (score < minScore) continue;

				const [older, newer] = x.side.time <= y.side.time ? [x.side, y.side] : [y.side, x.side];
				found.push({ layer, older, newer, score: Math.round(score * 100) / 100, shared, divergingNumbers: numbers });
			}
		}

		found.sort((p, q) => q.score - p.score || (p.older.id < q.older.id ? -1 : p.older.id > q.older.id ? 1 : 0));
		const best = new Set(found.slice(0, limitPerLayer));
		// Keep input order among the selected pairs.
		out.push(...found.filter((c) => best.has(c)));
	}

	return out;
}

/** One line per pair, for the review prompt's hint block. */
export function describeConflict(candidate: ConflictCandidate, textChars = 70): string {
	const brief = (text: string) => {
		const one = text.replace(/\s+/g, " ").trim();
		return one.length > textChars ? `${one.slice(0, textChars - 1)}…` : one;
	};
	const changed = candidate.divergingNumbers.length > 0 ? ` | differing values: ${candidate.divergingNumbers.join(", ")}` : "";
	return [
		`- shared: ${candidate.shared.join(", ")}${changed} | confidence ${Math.round(candidate.score * 100)}%`,
		`  older [${candidate.older.id}] (${candidate.older.time}, ${candidate.older.file}): "${brief(candidate.older.text)}"`,
		`  newer [${candidate.newer.id}] (${candidate.newer.time}, ${candidate.newer.file}): "${brief(candidate.newer.text)}"`,
	].join("\n");
}

/**
 * Render the hint block for a review prompt; empty string when there is nothing
 * to report (so the block never appears with no content).
 */
export function buildConflictHintBlock(candidates: readonly ConflictCandidate[]): string {
	if (candidates.length === 0) return "";
	return [
		"<possible-conflicts>",
		"These pairs share a keyword and look like TWO VERSIONS OF ONE FACT rather than two separate memories.",
		"They are hints, not verdicts. If the conversation confirms the newer statement is the current truth,",
		"you MUST emit an entry for it with SUPERSEDES: <id of the older one> — leaving both live means a future",
		"session reads the obsolete version. If the conversation shows they are genuinely different facts, ignore the pair.",
		...candidates.map((c) => describeConflict(c)),
		"</possible-conflicts>",
	].join("\n");
}
