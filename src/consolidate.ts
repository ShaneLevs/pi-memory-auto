/**
 * Memory consolidation: merges duplicate memories and reconciles keywords.
 *
 * Trigger: `sinceLast >= PI_MEMORY_AUTO_CONSOLIDATE_EVERY` memories added since
 * the last consolidation (see indexer.ts for the watermark). This is a *count*
 * of new input, never the size of an output file — the old design only ran once
 * MEMORY.md had already exceeded 1000 characters, which could not be reached.
 *
 * Division of labour:
 * - the LLM only proposes changes (merge groups + keyword renames), it never
 *   writes files;
 * - this module validates every proposal against the entries that actually
 *   exist (unknown ids ignored, merges never span layers, every survivor keeps
 *   1–3 valid keywords) and applies it deterministically via store.ts, keeping
 *   a `.bak` of every rewritten file.
 *
 * Failure is safe: if the proposal is unusable nothing is changed, and the
 * keyword table is still rebuilt deterministically from the entries.
 */

import { GLOBAL_CATEGORY_FILES, PROJECT_CATEGORY_FILES, LLM_TIMEOUT_MS } from "./constants.ts";
import { describeCandidate, findDuplicateCandidates, type DuplicateCandidate } from "./duplicates.ts";
import { sanitizeKeywords } from "./keywords.ts";
import { completeWithSessionModel } from "./llm.ts";
import { applyConsolidation, type ApplyDeps, type ConsolidationPlan, type KeywordRename, type MergeOp } from "./store.ts";
import { loadAllEntries } from "./search.ts";
import type { Layer, MemoryEntry, WriteTarget } from "./types.ts";

/** Max memories sent in ONE LLM call. Larger stores are covered over several
 *  rounds — see runConsolidation. */
const MAX_ENTRIES_IN_PROMPT = 120;
/** Safety cap on rounds per invocation (120 × 12 = 1440 memories in one run). */
const MAX_ROUNDS = 12;
/** Max merged groups accepted from one response. */
const MAX_MERGES = 40;
/** Max keyword renames accepted from one response. */
const MAX_RENAMES = 40;
/** Max near-duplicate pairs attached to one prompt as a hint. */
const MAX_HINTS = 6;

export const CONSOLIDATION_SYSTEM_PROMPT = `You consolidate a coding agent's long-term memory store.

You are given the stored memories (id, keywords, text). Find ONLY:
1. genuine duplicates or near-duplicates that say the same thing and should become ONE memory — same fact stated twice, one entry superseded by another, or two entries about the same decision/lesson;
2. keywords that are the same concept spelled differently and should be merged.

Do NOT merge memories that are merely related. Different facts, different files, different subsystems, or a general rule plus a specific instance stay separate. When in doubt, do not merge.

Output format. Nothing else, no explanations:

===MERGE===
KEEP: <id of the memory to keep>
DROP: <id>, <id>
TEXT: <optional merged body — omit to keep the KEEP body unchanged>
TAGS: <optional 1-3 keywords — omit to keep the existing keywords>

===RENAME===
FROM: <existing keyword>
TO: <new keyword>

Rules:
- Use ids exactly as given; never invent one.
- Only merge memories from the same layer (global with global, project with project).
- A <likely-duplicates> section may be attached: those pairs were flagged by a deterministic similarity check and may reference ids that are NOT in the page above. They are hints, not verdicts — judge them like any other pair.
- A kept memory must end up with 1-3 keywords. A keyword is at most 8 Chinese characters or 8 english words.
- Prefer the more complete version of the text when you merge; keep concrete details (paths, commands, versions) and drop repetition.
- If there is nothing to merge, respond with exactly: NOTHING_TO_MERGE`;

export interface ConsolidationDeps extends ApplyDeps {
	llmMaxTokens: number;
}

export interface ConsolidationResult {
	changedFiles: number;
	removed: number;
	updated: number;
	/** True when the LLM proposed nothing usable (store untouched). */
	noop: boolean;
	/** LLM calls made (one per page of entries). */
	rounds: number;
}

/**
 * Build the user prompt for one page of entries.
 *
 * `limit` is a guard: a caller that forgot to page cannot send a huge prompt.
 * Covering the rest of the store is the caller's job — see runConsolidation,
 * which pages through everything.
 *
 * `hints` are near-duplicate pairs computed over the WHOLE store. Pages are
 * time-ordered, so two duplicates recorded months apart rarely share a page;
 * naming the pairs closes that blind spot (the ids may sit outside the page).
 */
export function buildConsolidationPrompt(
	entries: { entry: MemoryEntry; file: string }[],
	limit = MAX_ENTRIES_IN_PROMPT,
	hints: DuplicateCandidate[] = [],
): string {
	const sorted = [...entries].sort((a, b) => (a.entry.time < b.entry.time ? 1 : -1));
	const shown = sorted.slice(0, limit);
	const lines = shown.map(({ entry, file }) => {
		const kw = entry.tags.length > 0 ? entry.tags.join(", ") : "(none)";
		return `[${entry.id}] ${entry.layer} ${file} | keywords: ${kw}\n${entry.text}`;
	});
	const note = sorted.length > shown.length ? `\n\n(${sorted.length - shown.length} older memories omitted from this prompt.)` : "";
	const hintBlock =
		hints.length > 0
			? `\n\n<likely-duplicates>\n${hints.slice(0, MAX_HINTS).map((h) => `- ${describeCandidate(h, 50)}`).join("\n")}\n</likely-duplicates>`
			: "";
	return `<memories>\n${lines.join("\n\n")}\n</memories>${note}${hintBlock}\n\nRespond with merge/rename blocks, or NOTHING_TO_MERGE.`;
}

/**
 * Parse a consolidation response into a validated plan.
 * Unknown ids, cross-layer merges, self-merges and invalid keywords are dropped.
 */
export function parseConsolidationPlan(
	response: string,
	byId: Map<string, MemoryEntry>,
): ConsolidationPlan {
	const merges: MergeOp[] = [];
	const renames: KeywordRename[] = [];
	const used = new Set<string>();

	const mergeBlocks = response.split("===MERGE===").slice(1);
	for (const block of mergeBlocks) {
		if (merges.length >= MAX_MERGES) break;
		const keepId = /^KEEP:\s*(\S+)\s*$/m.exec(block)?.[1];
		const dropRaw = /^DROP:\s*(.*)$/m.exec(block)?.[1] ?? "";
		const keep = keepId ? byId.get(keepId) : undefined;
		if (!keep) continue;
		const drops = dropRaw
			.split(/[,\s]+/)
			.map((s) => s.trim())
			.filter((id) => id && id !== keepId && byId.get(id)?.layer === keep.layer && !used.has(id));
		if (drops.length === 0) continue;

		const textMatch = /^TEXT:\s*([\s\S]*?)(?=\n(?:TAGS|===MERGE===|===RENAME===)|$)/m.exec(block);
		const tagsMatch = /^TAGS:\s*(.*)$/m.exec(block);
		const { keywords } = sanitizeKeywords(
			(tagsMatch?.[1] ?? "")
				.split(",")
				.map((t) => t.trim())
				.filter((t) => t && t !== "-"),
		);

		const op: MergeOp = { keepId: keep.id, dropIds: drops };
		const text = textMatch?.[1]?.trim();
		if (text && text.length > 0) op.text = text;
		if (keywords.length > 0) op.tags = keywords;
		merges.push(op);
		for (const id of drops) used.add(id);
	}

	const renameBlocks = response.split("===RENAME===").slice(1);
	for (const block of renameBlocks) {
		if (renames.length >= MAX_RENAMES) break;
		const from = /^FROM:\s*(.*)$/m.exec(block)?.[1]?.trim();
		const to = /^TO:\s*(.*)$/m.exec(block)?.[1]?.trim();
		if (!from || !to) continue;
		const { keywords, issues } = sanitizeKeywords([to]);
		if (issues.length > 0 || keywords.length === 0) continue;
		renames.push({ from, to: keywords[0]! });
	}

	return { merges, keywordRenames: renames };
}

function filesForLayer(layer: Layer): readonly string[] {
	return layer === "project" ? PROJECT_CATEGORY_FILES : GLOBAL_CATEGORY_FILES;
}

/** Both layers, in the order the UI lists them. */
export const ALL_LAYERS: readonly Layer[] = ["global", "project"];

/**
 * Run a consolidation pass over the WHOLE store, paging through it.
 *
 * Earlier versions sent only the newest 120 memories in a single call and
 * silently left the rest unexamined forever — so a duplicate between a fresh
 * memory and an old one (the common case: the same fact re-recorded months
 * later) could never be found. Now:
 *
 * - each round sends at most MAX_ENTRIES_IN_PROMPT memories (newest first) to
 *   the LLM, and a page with nothing to merge just moves on to the next page;
 * - every examined id is remembered, so each round takes the next page of
 *   memories that have not been looked at yet;
 * - after a round that changed the store the entries are re-read, because
 *   merges removed ids and renames changed keywords for the next page.
 *
 * A failed call ends the pass (the store keeps whatever was already applied),
 * and MAX_ROUNDS bounds one invocation.
 *
 * Scoping: `layers` restricts the pass to those layers. Consolidating the global
 * layer from inside a project command would rewrite the user's shared store every
 * time any project runs `/memory compact`, so callers scope explicitly.
 *
 * Known limitation: pages are time-ordered, so two duplicates that land in
 * DIFFERENT pages are never shown to the model together. `dry-run` candidates
 * computed over the whole pool are therefore attached to every prompt as a
 * <likely-duplicates> hint, which covers the common case (the same fact
 * re-recorded months later); it does not make paging exhaustive.
 *
 * Never throws; returns counts of what actually changed.
 */
export async function runConsolidation(
	deps: ConsolidationDeps,
	entries: { entry: MemoryEntry; file: string }[],
	model: unknown,
	registry: unknown,
	timeoutMs?: number,
	layers: readonly Layer[] = ALL_LAYERS,
): Promise<ConsolidationResult> {
	const scoped = entries.filter(({ entry }) => layers.includes(entry.layer));
	let pool = scoped;
	const examined = new Set<string>();
	let rounds = 0;
	let changedFiles = 0;
	let removed = 0;
	let updated = 0;

	while (rounds < MAX_ROUNDS) {
		const remaining = [...pool]
			.filter(({ entry }) => !examined.has(entry.id))
			.sort((a, b) => (a.entry.time < b.entry.time ? 1 : -1));
		// A single memory has nothing to be merged with.
		if (remaining.length < 2) break;
		const page = remaining.slice(0, MAX_ENTRIES_IN_PROMPT);
		rounds++;
		for (const { entry } of page) examined.add(entry.id);

		// Hints span the whole pool (not just this page): the pairs most worth
		// merging are exactly the ones that time-ordered paging would separate.
		const hints = findDuplicateCandidates(pool, { limit: MAX_HINTS });

		const response = await completeWithSessionModel(
			model as Parameters<typeof completeWithSessionModel>[0],
			registry as Parameters<typeof completeWithSessionModel>[1],
			{
				systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
				userPrompt: buildConsolidationPrompt(page, MAX_ENTRIES_IN_PROMPT, hints),
				maxTokens: deps.llmMaxTokens,
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			},
		);
		// A failed call means the provider is unhappy; stop instead of hammering it.
		if (!response.ok) break;

		const nothingToDo =
			/NOTHING_TO_MERGE/.test(response.text) && !response.text.includes("===MERGE===") && !response.text.includes("===RENAME===");
		if (nothingToDo) continue; // next page

		const byId = new Map(page.map(({ entry }) => [entry.id, entry]));
		// Let a hinted pair name an id that is not on this page, otherwise the hint
		// could never be acted on (parse drops unknown ids).
		for (const hint of hints) {
			for (const side of [hint.a, hint.b]) {
				if (byId.has(side.id)) continue;
				const source = pool.find(({ entry }) => entry.id === side.id);
				if (source) byId.set(side.id, source.entry);
			}
		}
		const plan = parseConsolidationPlan(response.text, byId);
		if (plan.merges.length === 0 && plan.keywordRenames.length === 0) continue;

		let roundChanged = 0;
		for (const layer of layers) {
			for (const file of filesForLayer(layer)) {
				const target: WriteTarget = { layer, file: file as WriteTarget["file"] };
				const applied = await applyConsolidation(target, deps, plan);
				if (!applied.changed) continue;
				changedFiles++;
				roundChanged++;
				removed += applied.removed;
				updated += applied.updated;
			}
		}
		// Nothing was written: no need to re-read, but the page is spent so the
		// loop still advances. Only reload when ids/keywords actually moved.
		if (roundChanged === 0) continue;
		pool = await loadAllEntries(deps.globalDir, deps.projectRoot);
	}

	return { changedFiles, removed, updated, noop: changedFiles === 0, rounds };
}

/** Default consolidation cadence (memories added between rounds). */
export const CONSOLIDATE_EVERY_DEFAULT = 20;
/** Self-timeout for one consolidation round. */
export const CONSOLIDATION_TIMEOUT_MS = Math.min(90_000, LLM_TIMEOUT_MS);
