/**
 * Staleness ("review_after") — engram's idea, minus the deadlines.
 *
 * Memories do not expire, but they do go unverified: "this library has no X",
 * "we deploy with rsync", "the API lives at /v1" become confidently wrong
 * statements as the world moves. The cheap, safe response is to ask for a
 * re-check instead of deleting anything:
 *
 * - a stale entry stays on disk, stays searchable, stays in the index;
 * - it ranks BELOW every fresh memory and is labelled in the result, so the
 *   agent verifies instead of trusting;
 * - `/memory` counts it, which is the prompt to re-confirm it (any write with
 *   the same body bumps `last`) or replace it (`supersedes`).
 *
 * Nothing is written to disk for this: the clock is derived from the entry's own
 * timestamp, so re-confirming or superseding refreshes it automatically, and a
 * legacy store needs no migration. Deliberately no TTL, no decay, no eviction —
 * every automatic deletion scheme reviewed in the survey (agentmemory,
 * mcp-memory-service) hangs the life of a memory on an LLM-assigned importance
 * score, and a drift in that score silently loses data.
 */

import { parseTime } from "./entry.ts";
import type { CategoryFile, Layer, MemoryEntry } from "./types.ts";

/** Days per "month" — fixed so the threshold cannot drift with the calendar. */
const DAY_MS = 86_400_000;
const MONTH_DAYS = 30;

/**
 * Review interval per category file, in months.
 *
 * Chosen by how fast the content actually moves, not by symmetry:
 * - TOOLING (3): toolchains and package-manager habits churn fastest.
 * - USER / CONVENTIONS (6): identity, style, repo rules — stable, but people and
 *   teams change practice within a year.
 * - LESSONS / FAILURES / DECISIONS (12): a lesson or a decision stays true until
 *   the surrounding architecture is replaced, which is a yearly event at most.
 */
export const REVIEW_MONTHS: Record<CategoryFile, number> = {
	TOOLING: 3,
	USER: 6,
	CONVENTIONS: 6,
	LESSONS: 12,
	FAILURES: 12,
	DECISIONS: 12,
};

/** Review interval when no override is configured. */
export const REVIEW_MONTHS_DEFAULT = 0;

/** Category file of a loadAllEntries label ("project/FAILURES.md" → "FAILURES"). */
export function fileOf(label: string): string {
	const base = label.split("/").pop() ?? label;
	return base.replace(/\.md$/i, "");
}

/**
 * Review interval (months) for a file label, or 0 when staleness is disabled.
 *
 * `override` > 0 replaces every per-file interval (a single knob for users who
 * want one number), `override` === 0 keeps the defaults.
 */
export function reviewMonthsFor(label: string, override = REVIEW_MONTHS_DEFAULT): number {
	if (override < 0) return 0;
	if (override > 0) return override;
	const file = fileOf(label).toUpperCase() as CategoryFile;
	return REVIEW_MONTHS[file] ?? 12;
}

/** Timestamp a memory was last confirmed (write or re-confirmation). */
export function verifiedAt(entry: MemoryEntry): number {
	return parseTime(entry.last ?? entry.time);
}

/**
 * Is this memory due for a re-check?
 *
 * A superseded entry is never "stale" — it is already dead, and saying both
 * would double-report it in `/memory`.
 */
export function isStale(
	entry: MemoryEntry,
	label: string,
	opts: { now?: number; reviewMonths?: number } = {},
): boolean {
	if (entry.supersededBy) return false;
	const months = reviewMonthsFor(label, opts.reviewMonths ?? REVIEW_MONTHS_DEFAULT);
	if (months <= 0) return false;
	const verified = verifiedAt(entry);
	if (verified <= 0) return false;
	const ageMs = (opts.now ?? Date.now()) - verified;
	return ageMs > months * MONTH_DAYS * DAY_MS;
}

/** Whole days since the memory was last confirmed (0 when unparsable). */
export function daysSinceVerified(entry: MemoryEntry, now = Date.now()): number {
	const verified = verifiedAt(entry);
	if (verified <= 0) return 0;
	return Math.max(0, Math.floor((now - verified) / DAY_MS));
}

export interface StalenessSummary {
	/** Entries due for review. */
	total: number;
	/** Per category file ("FAILURES.md" → count), busiest first. */
	byFile: { file: string; count: number }[];
}

/** Count stale entries for one layer (used by `/memory`). */
export function summarizeStaleness(
	entries: { entry: MemoryEntry; file: string }[],
	layer: Layer,
	opts: { now?: number; reviewMonths?: number } = {},
): StalenessSummary {
	const counts = new Map<string, number>();
	let total = 0;
	for (const { entry, file } of entries) {
		if (entry.layer !== layer) continue;
		if (!isStale(entry, file, opts)) continue;
		const name = `${fileOf(file)}.md`;
		counts.set(name, (counts.get(name) ?? 0) + 1);
		total++;
	}
	const byFile = [...counts.entries()]
		.map(([file, count]) => ({ file, count }))
		.sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : 1));
	return { total, byFile };
}
