/**
 * Background auto-extraction: every N turns, review the recent conversation
 * and extract durable memories into category files.
 *
 * Rules:
 * - Trigger: turn count only (no tool-call counting).
 * - Conservative by default: "nothing to save" is valid; empty results write nothing.
 * - Writes only category files (never the main file).
 * - Uses the session model; runs asynchronously; never blocks the conversation.
 */

import { CLASSIFICATION_RUBRIC, MIN_MESSAGES_FOR_REVIEW } from "./constants.ts";
import { completeWithSessionModel } from "./llm.ts";
import { appendEntry, isWritableTarget, type FileMutex, type ProcessLock } from "./store.ts";
import type { Layer, MemoryEntry, WriteTarget } from "./types.ts";

export const REVIEW_SYSTEM_PROMPT = `You review coding conversations and extract durable memories worth saving for future sessions.

${CLASSIFICATION_RUBRIC}

Output format — respond with entries, one block per memory, nothing else:

===ENTRY===
FILE: <USER.md | TOOLING.md | LESSONS.md | CONVENTIONS.md | DECISIONS.md | FAILURES.md>
LAYER: <global | project>
TAGS: <comma,separated,tags or ->
TEXT: <the memory text, concise, self-contained, one sentence to one short paragraph>

Rules:
- Follow the classification guide above strictly.
- At most 3 entries per review; quality over quantity.
- If nothing is worth saving, respond with exactly: NOTHING_TO_SAVE
- Do not store secrets, API keys, or tokens.`;

/** Serialized recent conversation (simple text transcript). */
export function buildReviewUserPrompt(transcript: string): string {
	return `Review the following recent conversation and extract durable memories (if any).

<conversation>
${transcript}
</conversation>

Remember: at most 3 entries, follow the classification guide, or respond NOTHING_TO_SAVE.`;

}

/** Parse the ===ENTRY=== blocks from a review response. */
export function parseReviewResponse(
	response: string,
	projectName: string,
): { target: WriteTarget; tags: string[]; text: string }[] {
	const out: { target: WriteTarget; tags: string[]; text: string }[] = [];
	// "NOTHING_TO_SAVE" only means empty when it appears outside of entry blocks.
	const hasEntries = response.includes("===ENTRY===");
	if (!hasEntries && response.includes("NOTHING_TO_SAVE")) return out;
	const blocks = response.split("===ENTRY===").slice(1);
	for (const block of blocks) {
		const fileMatch = /^FILE:\s*(\S+)\s*$/m.exec(block);
		const layerMatch = /^LAYER:\s*(\S+)\s*$/m.exec(block);
		const tagsMatch = /^TAGS:\s*(.*)$/m.exec(block);
		const textMatch = /^TEXT:\s*([\s\S]*?)(?=\n===ENTRY===|$)/m.exec(block);
		if (!fileMatch?.[1] || !textMatch?.[1]) continue;
		const file = fileMatch[1].replace(/\.md$/i, "").toUpperCase();
		const layer: Layer = layerMatch?.[1]?.toLowerCase() === "global" ? "global" : "project";
		if (!isWritableTarget(layer, file)) continue;
		const text = textMatch[1].trim();
		if (!text) continue;
		const tags = (tagsMatch?.[1] ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t && t !== "-");
		out.push({ target: { layer, file: file as WriteTarget["file"] }, tags, text });
	}
	return out;
}

/** Convert session messages to a compact transcript for review. */
export function transcriptFromMessages(messages: { role: string; text: string }[]): string {
	return messages
		.filter((m) => m.text.trim().length > 0)
		.map((m) => `${m.role}: ${m.text.trim()}`)
		.join("\n\n")
		.slice(-30_000); // cap transcript size
}

export interface ExtractorDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
	plock: ProcessLock;
	/** maxTokens for the review LLM call. */
	llmMaxTokens: number;
}

/**
 * Run one review. Returns the entries that were written (empty when nothing to save).
 * Never throws; background-safe.
 */
export async function runReview(
	deps: ExtractorDeps,
	transcript: string,
	model: unknown,
	registry: unknown,
	timeoutMs?: number,
): Promise<MemoryEntry[]> {
	const written: MemoryEntry[] = [];
	if (transcript.trim().length === 0) return written;

	const result = await completeWithSessionModel(
		model as Parameters<typeof completeWithSessionModel>[0],
		registry as Parameters<typeof completeWithSessionModel>[1],
		{
			systemPrompt: REVIEW_SYSTEM_PROMPT,
			userPrompt: buildReviewUserPrompt(transcript),
			maxTokens: deps.llmMaxTokens,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		},
	);
	if (!result.ok) return written;

	const candidates = parseReviewResponse(result.text, deps.projectRoot);
	for (const c of candidates) {
		// Category-file-only writes enforced by parse (isWritableTarget) + appendEntry.
		const entry = await appendEntry(c.target, c.text, {
			tags: c.tags,
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

/** Skip trivial sessions: fewer valid messages than MIN_MESSAGES_FOR_REVIEW. */
export function isTrivialSession(messageCount: number): boolean {
	return messageCount < MIN_MESSAGES_FOR_REVIEW;
}
