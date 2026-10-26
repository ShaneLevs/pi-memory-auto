/**
 * Review cadence gate for the auto-extraction trigger.
 *
 * Turns are still counted statelessly from the session branch (turns.ts), but
 * the DECISION to run is now stateful per session. That distinction fixes the
 * first reported bug: on a long task, `turn_end` is delivered more than once
 * for the same turn index (multi-step tool loops, retries). The old guard was
 * only `reviewInFlight`, a concurrency flag, so as soon as the previous review
 * finished, the next `turn_end` of the SAME turn started another review —
 * repeatedly re-extracting the same conversation into "new" memories whose
 * wording differs just enough that the exact-body dedup in store.ts misses.
 *
 * Two pieces of state, advanced at DIFFERENT times on purpose:
 * - `lastTurn`: the newest turn a review was started for. Recorded before the
 *   async call, so a duplicate dispatch a moment later cannot slip past the
 *   in-flight flag. A repeated turn index can never fire twice.
 * - `cursor`: how many messages have actually been EXTRACTED. Recorded only
 *   after a review/handoff finishes, so a failed call (provider error, timeout)
 *   leaves the tail uncovered and the next round picks it up instead of
 *   dropping it. Extraction only sends what is new since the cursor, instead of
 *   re-summarizing the whole cap-sized transcript every round.
 *
 * Pure functions returning new state: no timers, no I/O, directly testable.
 */

export interface ReviewCursor {
	/** Turn index of the last review START, or -1 when none ran in this session. */
	lastTurn: number;
	/**
	 * Number of branch messages already covered by a previous review/handoff.
	 * Extraction sends the tail starting here.
	 */
	cursor: number;
}

/** Why a review did or did not fire. */
export type ReviewDecision =
	| { fire: false; reason: "not_due" | "duplicate_turn" }
	| { fire: true; turn: number };

export function emptyReviewCursor(): ReviewCursor {
	return { lastTurn: -1, cursor: 0 };
}

/**
 * Decide whether `turn` should start a review.
 *
 * A turn fires when it is a positive multiple of `reviewTurns` AND no review
 * has already been started for that same turn index. Turn 0 is never due (no
 * exchange has completed yet).
 */
export function decideReview(cursor: ReviewCursor, turn: number, reviewTurns: number): ReviewDecision {
	if (reviewTurns < 1) return { fire: false, reason: "not_due" };
	if (turn <= 0 || turn % reviewTurns !== 0) return { fire: false, reason: "not_due" };
	if (cursor.lastTurn === turn) return { fire: false, reason: "duplicate_turn" };
	return { fire: true, turn };
}

/**
 * Record that a review STARTED for `turn` — before the async call, never after.
 *
 * Only `lastTurn` moves: the messages are not covered until the extraction
 * actually succeeded (see recordReview).
 */
export function recordAttempt(cursor: ReviewCursor, turn: number): ReviewCursor {
	return { lastTurn: Math.max(cursor.lastTurn, turn), cursor: cursor.cursor };
}

/**
 * Record that a review/handoff COVERED the first `coveredMessages` messages.
 *
 * Called on success only. The cursor never moves backwards: a stale or smaller
 * `coveredMessages` (a shortened branch, a concurrent handoff) is ignored.
 */
export function recordReview(cursor: ReviewCursor, coveredMessages: number): ReviewCursor {
	return { lastTurn: cursor.lastTurn, cursor: Math.max(cursor.cursor, coveredMessages) };
}

/**
 * Messages that arrived after `cursor`.
 *
 * `messages` are the raw branch/message array, so the cursor is an absolute
 * index. `getBranch()` returns the whole leaf path, so compaction does NOT
 * shrink it and the cursor stays valid. A cursor past the end (the leaf was
 * moved to an earlier entry, or the session was forked) reads as "nothing new"
 * rather than replaying the whole history: replaying is what produced duplicate
 * writes in the first place. It recovers on its own once the branch grows past
 * the cursor again.
 */
export function newMessages<T>(messages: readonly T[], cursor: ReviewCursor): T[] {
	return cursor.cursor >= messages.length ? [] : messages.slice(cursor.cursor);
}
