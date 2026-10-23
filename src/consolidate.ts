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
import { sanitizeKeywords } from "./keywords.ts";
import { completeWithSessionModel } from "./llm.ts";
import { applyConsolidation, type ApplyDeps, type ConsolidationPlan, type KeywordRename, type MergeOp } from "./store.ts";
import type { Layer, MemoryEntry, WriteTarget } from "./types.ts";

/** Max memories given to the LLM in one consolidation round. */
const MAX_ENTRIES_IN_PROMPT = 120;
/** Max merged groups accepted from one response. */
const MAX_MERGES = 40;
/** Max keyword renames accepted from one response. */
const MAX_RENAMES = 40;

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
}

/** Build the user prompt for one consolidation round. */
export function buildConsolidationPrompt(entries: { entry: MemoryEntry; file: string }[], limit = MAX_ENTRIES_IN_PROMPT): string {
	const sorted = [...entries].sort((a, b) => (a.entry.time < b.entry.time ? 1 : -1));
	const shown = sorted.slice(0, limit);
	const lines = shown.map(({ entry, file }) => {
		const kw = entry.tags.length > 0 ? entry.tags.join(", ") : "(none)";
		return `[${entry.id}] ${entry.layer} ${file} | keywords: ${kw}\n${entry.text}`;
	});
	const note = sorted.length > shown.length ? `\n\n(${sorted.length - shown.length} older memories omitted from this round.)` : "";
	return `<memories>\n${lines.join("\n\n")}\n</memories>${note}\n\nRespond with merge/rename blocks, or NOTHING_TO_MERGE.`;
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

/**
 * Run one consolidation round over all entries.
 * Never throws; returns counts of what actually changed.
 */
export async function runConsolidation(
	deps: ConsolidationDeps,
	entries: { entry: MemoryEntry; file: string }[],
	model: unknown,
	registry: unknown,
	timeoutMs?: number,
): Promise<ConsolidationResult> {
	const noop: ConsolidationResult = { changedFiles: 0, removed: 0, updated: 0, noop: true };
	if (entries.length < 2) return noop;

	const result = await completeWithSessionModel(
		model as Parameters<typeof completeWithSessionModel>[0],
		registry as Parameters<typeof completeWithSessionModel>[1],
		{
			systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
			userPrompt: buildConsolidationPrompt(entries),
			maxTokens: deps.llmMaxTokens,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		},
	);
	if (!result.ok) return noop;
	if (/NOTHING_TO_MERGE/.test(result.text) && !result.text.includes("===MERGE===") && !result.text.includes("===RENAME===")) {
		return noop;
	}

	const byId = new Map(entries.map(({ entry }) => [entry.id, entry]));
	const plan = parseConsolidationPlan(result.text, byId);
	if (plan.merges.length === 0 && plan.keywordRenames.length === 0) return noop;

	let changedFiles = 0;
	let removed = 0;
	let updated = 0;
	for (const layer of ["global", "project"] as const) {
		for (const file of filesForLayer(layer)) {
			const target: WriteTarget = { layer, file: file as WriteTarget["file"] };
			const applied = await applyConsolidation(target, deps, plan);
			if (!applied.changed) continue;
			changedFiles++;
			removed += applied.removed;
			updated += applied.updated;
		}
	}
	return { changedFiles, removed, updated, noop: changedFiles === 0 };
}

/** Default consolidation cadence (memories added between rounds). */
export const CONSOLIDATE_EVERY_DEFAULT = 20;
/** Self-timeout for one consolidation round. */
export const CONSOLIDATION_TIMEOUT_MS = Math.min(90_000, LLM_TIMEOUT_MS);
