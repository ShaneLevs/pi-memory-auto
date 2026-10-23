/**
 * Entry-text integrity: detect a memory whose text was cut off mid-sentence.
 *
 * Why this exists: the 0.2.0 fix rejects LLM responses with `stopReason:
 * "length"`, but that only covers providers that report truncation that way. A
 * response can still arrive looking complete while one entry inside it is cut —
 * the real global store carried `` `pi` CLI extension management: local-path installs (` ``
 * for months: a half sentence with a dangling code span.
 *
 * Delimiter counting runs on the prose OUTSIDE code spans, because shell
 * snippets, regexes and function signatures legitimately contain unbalanced
 * brackets. A code span that never closes is its own signal (an odd number of
 * backticks), so the dangerous case is still caught.
 *
 * The checks are asymmetric: truncation REMOVES a closing token, so only an
 * excess of openers is suspicious. That keeps `:)` or a stray `)` from being
 * mistaken for damage.
 */

/** Replace the contents of inline/fenced code spans with spaces (keeping length stable is unnecessary). */
function maskCodeSpans(text: string): string {
	return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function surplus(text: string, open: string, close: string): number {
	return text.split(open).length - text.split(close).length;
}

/**
 * Return a human-readable reason when `text` looks truncated, or null when it
 * looks complete. Pure and cheap — safe to call on every write.
 */
export function findTruncationSignal(text: string): string | null {
	const body = text.trim();
	if (body.length === 0) return "empty";

	// An odd backtick count means a code span was cut open and never closed.
	if ((body.match(/`/g)?.length ?? 0) % 2 === 1) return "unclosed code span";

	const prose = maskCodeSpans(body);
	const pairs: [string, string, string][] = [
		["(", ")", "unclosed parenthesis"],
		["[", "]", "unclosed bracket"],
		["{", "}", "unclosed brace"],
	];
	for (const [open, close, reason] of pairs) {
		if (surplus(prose, open, close) > 0) return reason;
	}
	if (/[(\[{,]\s*$/.test(prose)) return "ends with an opening delimiter";
	return null;
}
