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

import { CLASSIFICATION_RUBRIC, MIN_MESSAGES_FOR_REVIEW, TRANSCRIPT_MAX_CHARS } from "./constants.ts";
import { ENTRY_ID_RE } from "./entry.ts";
import { deriveKeyword, sanitizeKeywords } from "./keywords.ts";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { completeWithSessionModel } from "./llm.ts";
import { findTruncationSignal } from "./integrity.ts";
import { appendEntry, isWritableTarget, type FileMutex, type ProcessLock } from "./store.ts";
import type { Layer, MemoryEntry, WriteTarget } from "./types.ts";

export const REVIEW_SYSTEM_PROMPT = `You review coding conversations and extract durable memories worth saving for future sessions.

${CLASSIFICATION_RUBRIC}

The transcript below is a serialized conversation, not a live chat. Lines starting with
"[Assistant tool calls]:" and "[Tool result]:" record what the agent actually did and what
its tools returned. Use them as evidence for failures, corrections, and tool quirks —
but never invent process details that are not recorded, and never save a "lesson" unless
the transcript itself supports it.

The "Existing memories" section lists what is already stored, with each entry's id. Its two purposes are
dedup and correction: skip a candidate when an equivalent entry exists, and when a candidate CONTRADICTS or
CORRECTS an existing memory, name that memory's id in SUPERSEDES instead of writing a second, conflicting entry.

The store is append-only: an entry nobody supersedes stays live forever, is injected into every future session,
and is returned by search. Two live memories that disagree is the worst state this system can be in — a future
session will read whichever one ranks first and act on an obsolete requirement.

So when the conversation REPLACES something an existing memory claims (a different command, port, path, version,
library, convention, or preference for the same subject), that is a correction even if the admission guide would
otherwise call it "no new information": emit an entry for the current statement and put the obsolete memory's id
in SUPERSEDES. "The requirement changed" is exactly what SUPERSEDES is for.

A <possible-conflicts> section may be attached: those pairs were flagged by a deterministic similarity check as
looking like two versions of one fact. Judge each one. If the newer statement is the current truth, supersede the
older one; if they are genuinely different facts, ignore the pair.

Output format — respond with entries, one block per memory, nothing else:

===ENTRY===
FILE: <USER.md | TOOLING.md | LESSONS.md | CONVENTIONS.md | DECISIONS.md | FAILURES.md>
LAYER: <global | project>
TAGS: <1-3 comma separated keywords>
SUPERSEDES: <ids of existing memories this entry replaces, comma separated, or ->
TEXT: <the memory text, concise, self-contained, one sentence to one short paragraph>

Rules:
- Follow the classification guide above strictly.
- At most 3 entries per review; quality over quantity.
- Every entry needs 1-3 keywords: the terms a future session would search for. Reuse an existing keyword when it fits instead of inventing a synonym. Each keyword is at most 8 Chinese characters or 8 english words.
- SUPERSEDES takes at most 2 ids, copied literally from the "Existing memories" list, and only when the
  new entry says the same thing differently or replaces what they claimed. The old entries are kept on
  disk, stop being injected, and rank below the new one — nothing is deleted, so prefer superseding over
  writing a parallel entry that disagrees with the old one.
- If nothing is worth saving, respond with exactly: NOTHING_TO_SAVE
- Do not store secrets, API keys, or tokens.`;

/** Serialized recent conversation. */
export function buildReviewUserPrompt(transcript: string, existingMemories: string, conflictHints = ""): string {
	const sections = [
		"--- Existing memories (for dedup and correction) ---",
		existingMemories.trim() || "(empty — nothing stored yet)",
		"",
		...(conflictHints.trim() ? [conflictHints.trim(), ""] : []),
		"--- Conversation to review ---",
		`<conversation>\n${transcript}\n</conversation>`,
		"",
		"Remember: at most 3 entries, follow the classification guide, or respond NOTHING_TO_SAVE.",
	];
	return sections.join("\n");
}

/** Max ids one candidate may supersede. */
export const MAX_SUPERSEDES = 2;

/** Parse the ===ENTRY=== blocks from a review response. */
export function parseReviewResponse(
	response: string,
	projectName: string,
): { target: WriteTarget; tags: string[]; text: string; supersedes: string[] }[] {
	const out: { target: WriteTarget; tags: string[]; text: string; supersedes: string[] }[] = [];
	// "NOTHING_TO_SAVE" only means empty when it appears outside of entry blocks.
	const hasEntries = response.includes("===ENTRY===");
	if (!hasEntries && response.includes("NOTHING_TO_SAVE")) return out;
	const blocks = response.split("===ENTRY===").slice(1);
	for (const block of blocks) {
		const fileMatch = /^FILE:\s*(\S+)\s*$/m.exec(block);
		const layerMatch = /^LAYER:\s*(\S+)\s*$/m.exec(block);
		const tagsMatch = /^TAGS:\s*(.*)$/m.exec(block);
		const textMatch = /^TEXT:\s*([\s\S]*?)(?=\n===ENTRY===|$)/m.exec(block);
		const supersedesMatch = /^SUPERSEDES:\s*(.*)$/m.exec(block);
		if (!fileMatch?.[1] || !textMatch?.[1]) continue;
		const file = fileMatch[1].replace(/\.md$/i, "").toUpperCase();
		const layer: Layer = layerMatch?.[1]?.toLowerCase() === "global" ? "global" : "project";
		if (!isWritableTarget(layer, file)) continue;
		const text = textMatch[1].trim();
		if (!text) continue;
		// A truncated response can still parse into a syntactically valid block.
		// Storing half a sentence would persist a memory that cannot be understood
		// later, so drop it instead — the next review round retries.
		if (findTruncationSignal(text)) continue;
		const candidates = (tagsMatch?.[1] ?? "")
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t && t !== "-");
		const { keywords } = sanitizeKeywords(candidates);
		// At least one keyword per memory: derive one when the model gave none.
		const tags = keywords.length > 0 ? keywords : [deriveKeyword(text)];
		// Ids from the model are untrusted: shape-checked here, layer-checked and
		// de-duplicated by markSuperseded. An unknown id simply changes nothing.
		const supersedes = (supersedesMatch?.[1] ?? "")
			.split(/[,\s]+/)
			.map((id) => id.trim())
			.filter((id) => ENTRY_ID_RE.test(id))
			.slice(0, MAX_SUPERSEDES);
		out.push({ target: { layer, file: file as WriteTarget["file"] }, tags, text, supersedes });
	}
	return out;
}

/**
 * Serialize agent messages into the review transcript.
 *
 * Uses pi's own serializeConversation (the compaction path), which keeps
 * [Assistant tool calls] and [Tool result] lines (tool results truncated to
 * 2000 chars by pi) so the extraction LLM can see the agent's working process,
 * not just its final prose. Thinking blocks are omitted (same rationale as
 * compaction: replayed thinking is unreliable and bloats the request).
 *
 * Accepts AgentMessage[] (role-bearing objects) or session entries
 * ({ type: "message", message }) — entries are unwrapped first.
 */
export function serializeTranscript(messages: unknown[]): string {
	const agentMessages = messages.map((m) => {
		const e = m as { type?: string; message?: unknown };
		return e?.type === "message" && e.message && typeof e.message === "object" ? e.message : m;
	}).filter((m) => m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string");
	const text = serializeConversation(convertToLlm(agentMessages as never[]));
	return text.length > TRANSCRIPT_MAX_CHARS ? text.slice(-TRANSCRIPT_MAX_CHARS) : text;
}

export interface ExtractorDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
	plock: ProcessLock;
	/** maxTokens for the review LLM call. */
	llmMaxTokens: number;
}

/** Outcome of one review: what was written, and whether the provider answered.
 *  `ok: false` means the call failed, so the transcript was NOT examined — the
 *  caller must keep it for the next round instead of advancing its cursor. */
export interface ReviewOutcome {
	written: MemoryEntry[];
	ok: boolean;
}

/**
 * Run one review. Never throws; background-safe.
 *
 * `written` empty with `ok: true` means "the conversation held nothing worth
 * storing" — a real result. Empty with `ok: false` means the model never
 * answered, which is not a result at all.
 */
export async function runReview(
	deps: ExtractorDeps,
	transcript: string,
	model: unknown,
	registry: unknown,
	timeoutMs?: number,
	existingMemories = "",
	conflictHints = "",
): Promise<ReviewOutcome> {
	const written: MemoryEntry[] = [];
	if (transcript.trim().length === 0) return { written, ok: true };

	const result = await completeWithSessionModel(
		model as Parameters<typeof completeWithSessionModel>[0],
		registry as Parameters<typeof completeWithSessionModel>[1],
		{
			systemPrompt: REVIEW_SYSTEM_PROMPT,
			userPrompt: buildReviewUserPrompt(transcript, existingMemories, conflictHints),
			maxTokens: deps.llmMaxTokens,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		},
	);
	if (!result.ok) return { written, ok: false };

	const candidates = parseReviewResponse(result.text, deps.projectRoot);
	for (const c of candidates) {
		// Category-file-only writes enforced by parse (isWritableTarget) + appendEntry.
		const outcome = await appendEntry(c.target, c.text, {
			tags: c.tags,
			source: "auto",
			globalDir: deps.globalDir,
			projectRoot: deps.projectRoot,
			mutex: deps.mutex,
			plock: deps.plock,
			...(c.supersedes.length > 0 ? { supersedes: c.supersedes } : {}),
		});
		// A re-confirmation is not new information: nothing was appended, so it must
		// not count as "saved N memories". It still has to reach the caller when it
		// superseded entries, because that changes the index.
		if (!outcome.deduped || outcome.superseded > 0) written.push(outcome.entry);
	}
	return { written, ok: true };
}

/** Skip trivial sessions: fewer valid messages than MIN_MESSAGES_FOR_REVIEW. */
export function isTrivialSession(messageCount: number): boolean {
	return messageCount < MIN_MESSAGES_FOR_REVIEW;
}
