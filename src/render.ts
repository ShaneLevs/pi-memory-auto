/**
 * Injection renderer.
 *
 * The injected block is the memory *index* (see index-map.ts): a topic map of
 * what is stored. No entry bodies, no LLM, no size-dependent trigger — if there
 * are entries, there is something to inject.
 *
 * Output must be byte-stable for identical input: the snapshot reuses it for
 * the whole session so the provider's prompt prefix cache stays warm.
 */

/**
 * Build the full injected block. Returns "" when nothing is stored, so the
 * caller can skip injection entirely instead of emitting an empty preamble.
 */
export function buildInjection(preamble: string, indexText: string): string {
	const body = indexText.trim();
	if (!body) return "";
	return `${preamble}\n\n${body}`;
}
