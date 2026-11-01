/**
 * Keyword re-extraction — the repair pass behind `/memory rebuild`.
 *
 * The index is the only memory content that enters the context window, so a bad
 * keyword costs a whole memory its reachability. Stored keywords can rot:
 * legacy tags were space-separated (`#a #b #c` as one tag), the pre-1.0 contract
 * allowed three keywords per memory, and nothing forces a keyword that a future
 * session would actually search for.
 *
 * `/memory rebuild` therefore re-derives ONE keyword per entry with the session
 * model and writes the results back into the entry metadata, keeping a `.bak` of
 * each rewritten file. Rebuild is also the migration path for the old 1-3
 * contract: an entry stored with three keywords is collapsed to the single best
 * one (reported as `collapsed`). It is model work, so it is explicit (a command)
 * and never runs in the background.
 *
 * Failure is safe: an entry the model skipped or answered badly keeps its
 * previously stored keywords; a derived keyword is the last resort, so an entry
 * is never left without one.
 */

import { CLASSIFICATION_RUBRIC, MAIN_FILE } from "./constants.ts";
import { MAX_KEYWORDS, coerceKeywords, deriveKeyword, keywordKey, sanitizeKeywords, splitTagCandidates } from "./keywords.ts";
import { completeWithSessionModel } from "./llm.ts";
import { applyTagUpdates, type ApplyDeps } from "./store.ts";
import type { MemoryEntry } from "./types.ts";

/** Entries per LLM call. Small enough to stay well inside the context window,
 *  large enough that ~30 memories cost 2-3 calls instead of 30. */
export const REKEY_BATCH_SIZE = 12;

/** Bodies longer than this are truncated in the prompt (keywords come from the
 *  gist, not from the tail). */
const MAX_BODY_CHARS = 1_200;

export const REKEY_SYSTEM_PROMPT = `You assign retrieval keywords to long-term memory entries.

${CLASSIFICATION_RUBRIC}

A keyword is the ONLY thing a future session sees in its memory index — the body is not in context. So a keyword must be what a future session would search for when this memory is relevant.

Rules:
- Give every entry EXACTLY ONE keyword. The index has one line per keyword, so a second keyword per memory doubles the list without making the memory easier to find — pick the single best hook.
- A keyword is at most 8 Chinese characters or 8 English words. No spaces inside a keyword: join words with '-' (e.g. "turn-counting").
- Prefer concrete, distinctive terms: file names, library/tool names, error strings, project names, the user's own wording. Add a Chinese keyword when the memory itself is about Chinese-language work or the user's phrase is more precise in Chinese.
- A keyword must be useful for FINDING the memory, not a summary of it: "deploy", "rsync", "serialize-conversation" — not "good-practice" or "important".
- Reuse the existing keyword when it is already good; replace it when it is vague, a whole sentence, or a legacy blob.
- Do not invent facts, and never store secrets.

Output format — one line per memory, in the order given, nothing else:
<id> | <keyword>`;

/** Build one batch prompt. */
export function buildRekeyPrompt(entries: { entry: MemoryEntry; file: string }[]): string {
	const blocks = entries.map(({ entry, file }) => {
		const body = entry.text.length > MAX_BODY_CHARS ? `${entry.text.slice(0, MAX_BODY_CHARS)}…` : entry.text;
		const current = entry.tags.length > 0 ? entry.tags.join(", ") : "(none)";
		return `[${entry.id}] ${entry.layer} · ${file}\ncurrent keyword${entry.tags.length > 1 ? "s" : ""}: ${current}\n${body}`;
	});
	return `<memories>\n${blocks.join("\n\n")}\n</memories>\n\nAssign one keyword to every memory above. One line per memory: <id> | <keyword>`;
}

export interface RekeyParsed {
	/** Validated keyword updates, in response order. */
	updates: { id: string; keywords: string[] }[];
	/** Ids that appeared in the response but whose keywords were unusable. */
	rejected: string[];
}

/**
 * Parse `<id> | kw1, kw2` lines.
 *
 * Unknown ids are ignored, a keyword list that sanitizes to nothing is reported
 * as rejected (the caller keeps the stored keywords), and only the FIRST valid
 * keyword survives — a model that still answers with three is answering an old
 * contract, and the first one is its own best guess.
 */
export function parseRekeyResponse(response: string, byId: Map<string, MemoryEntry>): RekeyParsed {
	const updates: RekeyParsed["updates"] = [];
	const rejected: string[] = [];
	const seen = new Set<string>();
	for (const rawLine of response.split("\n")) {
		const line = rawLine.trim().replace(/^[-*]\s*/, "");
		if (!line) continue;
		const sep = line.indexOf("|");
		if (sep < 0) continue;
		const id = line.slice(0, sep).trim().replace(/^\[|\]$/g, "");
		const entry = byId.get(id);
		if (!entry || seen.has(id)) continue;
		seen.add(id);
		const { keywords } = sanitizeKeywords(
			line
				.slice(sep + 1)
				.split(",")
				.map((k) => k.trim())
				.filter((k) => k && k !== "-" && k !== "(none)"),
		);
		if (keywords.length === 0) {
			rejected.push(id);
			continue;
		}
		updates.push({ id, keywords: keywords.slice(0, MAX_KEYWORDS) });
	}
	return { updates, rejected };
}

export interface RekeyResult {
	/** Entries whose stored keywords were rewritten. */
	updated: number;
	/** Of `updated`, entries that stored MORE than one keyword before the pass
	 *  and now hold one — the 1-3 → 1 migration, reported separately because it
	 *  is the reason `/memory rebuild` is run after upgrading. */
	collapsed: number;
	/** Files rewritten (each keeps a .bak). */
	changedFiles: number;
	/** Entries left as they were (model skipped them / answer unusable). */
	unchanged: number;
	/** Entries that needed no change because the model agreed with the store. */
	agreed: number;
}

export async function runKeywordRekey(
	deps: ApplyDeps & { llmMaxTokens: number; timeoutMs?: number },
	entries: { entry: MemoryEntry; file: string }[],
	model: unknown,
	registry: unknown,
	opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<RekeyResult> {
	const result: RekeyResult = { updated: 0, collapsed: 0, changedFiles: 0, unchanged: 0, agreed: 0 };
	if (entries.length === 0) return result;

	// Proposed keywords per entry id, applied only after the full pass so a
	// failed batch cannot half-rewrite the store in a surprising order.
	const proposed = new Map<string, string[]>();
	const ordered = [...entries].sort((a, b) => (a.entry.time < b.entry.time ? -1 : 1));

	for (let i = 0; i < ordered.length; i += REKEY_BATCH_SIZE) {
		const batch = ordered.slice(i, i + REKEY_BATCH_SIZE);
		const byId = new Map(batch.map(({ entry }) => [entry.id, entry]));
		const completion = await completeWithSessionModel(
			model as Parameters<typeof completeWithSessionModel>[0],
			registry as Parameters<typeof completeWithSessionModel>[1],
			{
				systemPrompt: REKEY_SYSTEM_PROMPT,
				userPrompt: buildRekeyPrompt(batch),
				maxTokens: deps.llmMaxTokens,
				...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
			},
		);
		if (completion.ok) {
			for (const { id, keywords } of parseRekeyResponse(completion.text, byId).updates) proposed.set(id, keywords);
		}
		opts.onProgress?.(Math.min(i + REKEY_BATCH_SIZE, ordered.length), ordered.length);
	}

	// Group the rewrites per file so each file is read-modify-written once.
	const byFile = new Map<string, { layer: MemoryEntry["layer"]; file: string; updates: Map<string, string[]>; collapsed: number }>();
	for (const { entry, file } of ordered) {
		if (file.endsWith(`/${MAIN_FILE}`)) continue; // derived state, never rewritten
		const keywords = proposed.get(entry.id) ?? repairLocally(entry);
		if (sameKeywords(entry.tags, keywords)) {
			result.agreed++;
			continue;
		}
		const parsed = file.split("/");
		const layer = (parsed[0] === "global" ? "global" : "project") as MemoryEntry["layer"];
		const name = (parsed[1] ?? file).replace(/\.md$/i, "");
		const key = `${layer}/${name}`;
		// A stored entry carrying more than one keyword is the old 1-3 contract
		// (including a legacy `#a #b #c` blob, which is one tag but three
		// keywords): this rewrite collapses it to one, which the caller reports.
		const bucket = byFile.get(key) ?? { layer, file: name, updates: new Map<string, string[]>(), collapsed: 0 };
		bucket.updates.set(entry.id, keywords);
		if (storedKeywordCount(entry) > 1) bucket.collapsed++;
		byFile.set(key, bucket);
	}

	for (const bucket of byFile.values()) {
		const applied = await applyTagUpdates(
			{ layer: bucket.layer, file: bucket.file as never },
			deps,
			bucket.updates,
		);
		if (!applied.changed) continue;
		result.changedFiles++;
		result.updated += applied.updated;
		// applyTagUpdates may legitimately write fewer rows than it was handed
		// (an id that vanished, an identical rewrite), so the bucket count is a
		// ceiling; clamp it to what the file actually reports.
		result.collapsed += Math.min(bucket.collapsed, applied.updated);
	}
	result.unchanged = ordered.length - result.agreed - result.updated;
	if (result.unchanged < 0) result.unchanged = 0;
	return result;
}

/** How many keywords the stored tag field really carries (a legacy
 *  `#a #b #c` blob counts as three, not one). */
function storedKeywordCount(entry: MemoryEntry): number {
	return entry.tags.reduce((n, tag) => n + Math.max(1, splitTagCandidates(tag).length), 0);
}

/** Deterministic repair when the model gave nothing usable for an entry. */
function repairLocally(entry: MemoryEntry): string[] {
	const { keywords } = coerceKeywords(entry.tags, entry.text);
	return keywords.length > 0 ? keywords : [deriveKeyword(entry.text)];
}

/** Same keyword set in the canonical sense (order- and case-insensitive).
 *  Comparing canonical keys keeps a rebuild from rewriting entries whose only
 *  difference is cosmetic (capitalisation, `-` vs `_`), so a rebuild only writes
 *  when it actually improves the retrieval surface. */
function sameKeywords(a: readonly string[], b: readonly string[]): boolean {
	const norm = (list: readonly string[]) => list.map((k) => keywordKey(k)).filter(Boolean).sort();
	const left = norm(a);
	const right = norm(b);
	if (left.length !== right.length) return false;
	return left.every((k, i) => k === right[i]);
}
