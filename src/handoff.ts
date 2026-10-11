/**
 * Compaction handoff: when the session is about to be compacted, append a
 * handoff entry capturing in-flight state so it survives the context loss.
 * Runs asynchronously and never blocks compaction.
 */

import { CLASSIFICATION_RUBRIC } from "./constants.ts";
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
TAGS: <comma,separated,tags or ->
TEXT: <the memory text, concise, self-contained>

If nothing is worth saving, respond with exactly: NOTHING_TO_SAVE`;

export interface HandoffDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
	plock: ProcessLock;
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
		{ systemPrompt: HANDOFF_SYSTEM_PROMPT, userPrompt: `<conversation>\n${transcript.slice(-30_000)}\n</conversation>`, maxTokens: 2048 },
	);
	if (!result.ok) return written;

	for (const c of parseReviewResponse(result.text, deps.projectRoot)) {
		const entry = await appendEntry(c.target, c.text, {
			tags: [...c.tags, "handoff"],
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
