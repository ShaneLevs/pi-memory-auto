/**
 * Stateless turn counting for the auto-extraction trigger.
 *
 * Instead of persisting a counter, the total conversation turn count is
 * computed from the session branch on every turn_end:
 * - a turn = one user + one assistant message exchange (min of both counts)
 * - compaction entries are skipped, but the history before them stays in the
 *   branch, so pre-compaction turns are included
 * - reload/resume rebuild the runtime but the branch is intact, so counting
 *   naturally survives them (no counter to lose)
 */

/** Count completed turns (user+assistant exchanges) in a session branch. */
export function countTurnsFromBranch(branch: { type: string; message?: { role?: string } }[]): number {
	let user = 0;
	let assistant = 0;
	for (const e of branch) {
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role === "user") user++;
		else if (role === "assistant") assistant++;
	}
	// A turn is a complete exchange; an unmatched tail user message waits.
	return Math.min(user, assistant);
}

/** Convenience wrapper for session managers with getBranch(). */
export function countTurns(sessionManager: { getBranch(): unknown[] }): number {
	return countTurnsFromBranch(sessionManager.getBranch() as { type: string; message?: { role?: string } }[]);
}
