/**
 * Compaction handoff: when the session is about to be compacted, append a
 * handoff entry capturing in-flight state so it survives the context loss.
 * Runs asynchronously and never blocks compaction.
 */

import { CLASSIFICATION_RUBRIC, HANDOFF_TRANSCRIPT_MAX_CHARS } from "./constants.ts";
import { sanitizeKeywords } from "./keywords.ts";
import { completeWithSessionModel } from "./llm.ts";
import { appendEntry, type FileMutex, type ProcessLock } from "./store.ts";
import type { MemoryEntry } from "./types.ts";

export const HANDOFF_SYSTEM_PROMPT = `The conversation is about to be compacted (context will be summarized and older turns dropped). Extract anything worth persisting to long-term memory before the context is lost.

${CLASSIFICATION_RUBRIC}

Prioritize: user preferences, corrections, decisions made, recurring patterns, and anything the compacted summary may lose.

Output format — at most 2 entries:

===ENTRY===
FILE: <USER.md | TOOLING.md | LESSONS.md | CONVENTIONS.md | DECISIONS.md | FAILURES.md>
LAYER: <global | project>
TAGS: <1-3 comma separated keywords>
TEXT: <the memory text, concise, self-contained>

Every entry needs 1-3 keywords: the terms a future session would search for (at most 8 Chinese characters or 8 english words each).

If nothing is worth saving, respond with exactly: NOTHING_TO_SAVE`;

export interface HandoffDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
	plock: ProcessLock;
	/** maxTokens for the handoff LLM call. */
	llmMaxTokens: number;
}

/** Run the handoff extraction. Never throws; returns written entries. */
export async function runHandoff(
	deps: HandoffDeps,
	transcript: string,
	model: unknown,
	registry: unknown,
): Promise<MemoryEntry[]> {
	const { parseReviewResponse } = await import("./extractor.ts");
	const written: MemoryEntry[] = [];
	if (transcript.trim().length === 0) return written;

	const result = await completeWithSessionModel(
		model as Parameters<typeof completeWithSessionModel>[0],
		registry as Parameters<typeof completeWithSessionModel>[1],
		{ systemPrompt: HANDOFF_SYSTEM_PROMPT, userPrompt: `<conversation>\n${transcript.slice(-HANDOFF_TRANSCRIPT_MAX_CHARS)}\n</conversation>`, maxTokens: deps.llmMaxTokens },
	);
	if (!result.ok) return written;

	for (const c of parseReviewResponse(result.text, deps.projectRoot)) {
		// Merge the handoff marker into the keyword budget instead of appending a
		// 4th keyword: the 1-3 contract is what the index depends on, and a
		// shared "handoff" keyword on every extracted entry is pure index noise.
		const { keywords } = sanitizeKeywords([...c.tags, "handoff"]);
		const entry = await appendEntry(c.target, c.text, {
			tags: keywords.length > 0 ? keywords : c.tags,
			source: "auto",
			globalDir: deps.globalDir,
			projectRoot: deps.projectRoot,
			mutex: deps.mutex,
			plock: deps.plock,
		});
		written.push(entry);
	}
	return written;
}
