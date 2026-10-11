/**
 * Deterministic renderer: strip entry metadata comments, compact whitespace,
 * and trim to the per-file character budget. No LLM involved.
 *
 * Output must be byte-stable for identical input (snapshot mode relies on it).
 */

import { cleanMainContent } from "./store.ts";

/**
 * Render a main memory file for injection.
 * - strips metadata comments (via cleanMainContent)
 * - compacts whitespace
 * - if over budget, trims by paragraphs (whole paragraphs dropped from the end
 *   until it fits), never mid-word; a final hard slice guarantees the budget.
 */
export function renderMainMemory(raw: string, budget: number): string {
	const cleaned = cleanMainContent(raw);
	if (cleaned.length === 0) return "";
	const compact = cleaned.replace(/[ \t]+/g, " ").trim();
	if (compact.length <= budget) return compact;

	// Paragraph-aware trim: drop whole paragraphs from the end.
	const paragraphs = compact.split(/\n\n+/);
	let kept = paragraphs;
	for (let i = paragraphs.length - 1; i >= 0; i--) {
		kept = paragraphs.slice(0, i);
		const joined = kept.join("\n\n");
		if (joined.length <= budget) return joined;
	}

	// Single huge paragraph: hard slice at a whitespace boundary.
	const slice = compact.slice(0, budget);
	const cut = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
	return cut > budget * 0.6 ? slice.slice(0, cut) : slice;
}

/**
 * Build the full injected block: preamble + global main + project main.
 * Empty sections are omitted entirely.
 */
export function buildInjection(
	preamble: string,
	globalRaw: string,
	projectRaw: string,
	budget: number,
): string {
	const sections: string[] = [];
	const globalRendered = renderMainMemory(globalRaw, budget);
	if (globalRendered) sections.push(`## Global memory\n\n${globalRendered}`);
	const projectRendered = renderMainMemory(projectRaw, budget);
	if (projectRendered) sections.push(`## Project memory\n\n${projectRendered}`);
	if (sections.length === 0) return "";
	return `${preamble}\n\n${sections.join("\n\n")}`;
}
