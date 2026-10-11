/**
 * memory_search implementation: keyword / tag / recent / all modes,
 * fused scoring for `all`, pagination. Searches project + global layers.
 * No whole-file read: only entries matching the query are returned.
 */

import { MAIN_FILE, PROJECT_CATEGORY_FILES, GLOBAL_CATEGORY_FILES } from "./constants.ts";
import { parseEntries } from "./entry.ts";
import { categoryFilePath, memoryDir, readFileOrEmpty } from "./store.ts";
import { parseTime } from "./entry.ts";
import type { SearchHit, SearchMode, SearchResult } from "./types.ts";

/** Load all entries from both layers. Returns hits' source file labels. */
export async function loadAllEntries(globalDir: string, projectRoot: string): Promise<{ entry: import("./types.ts").MemoryEntry; file: string }[]> {
	const out: { entry: import("./types.ts").MemoryEntry; file: string }[] = [];
	for (const layer of ["project", "global"] as const) {
		const dir = memoryDir(layer, globalDir, projectRoot);
		const files = layer === "project" ? PROJECT_CATEGORY_FILES : GLOBAL_CATEGORY_FILES;
		for (const f of files) {
			const filePath = categoryFilePath({ layer, file: f }, globalDir, projectRoot);
			const raw = await readFileOrEmpty(filePath);
			for (const entry of parseEntries(raw)) out.push({ entry, file: `${layer}/${f}.md` });
		}
		// Main file entries are searchable too (read-only).
		const mainRaw = await readFileOrEmpty(path7(dir, MAIN_FILE));
		for (const entry of parseEntries(mainRaw)) out.push({ entry, file: `${layer}/${MAIN_FILE}` });
	}
	return out;
}

// Local path.join wrapper to keep imports tidy.
import path from "node:path";
function path7(dir: string, file: string): string {
	return path.join(dir, file);
}

function keywordMatch(text: string, query: string): boolean {
	// Try regex first; fall back to plain substring (case-insensitive).
	try {
		return new RegExp(query, "i").test(text);
	} catch {
		return text.toLowerCase().includes(query.toLowerCase());
	}
}

function baseScore(entry: import("./types.ts").MemoryEntry, file: string, query: string): number {
	let score = 0;
	const haystack = `${entry.text}\n${entry.tags.join(",")}`;
	if (query && keywordMatch(haystack, query)) score += 2;
	if (entry.id === query) score += 10;
	// Main-file entries are curated: slight boost.
	if (file.endsWith(MAIN_FILE)) score += 0.5;
	return score;
}

/**
 * Search entries.
 * - keyword: regex/substring match on text+tags
 * - tag: entries whose tags include any query tag (case-insensitive)
 * - recent: newest entries regardless of query
 * - all: fused = keyword match + tag match + recency
 */
export function searchEntries(
	all: { entry: import("./types.ts").MemoryEntry; file: string }[],
	mode: SearchMode,
	query: string,
	page: number,
	pageSize: number,
): SearchResult {
	const now = Date.now();
	let hits: SearchHit[];

	const q = query.trim();
	switch (mode) {
		case "keyword": {
			hits = all
				.filter(({ entry }) => keywordMatch(`${entry.text}\n${entry.tags.join(",")}`, q))
				.map(({ entry, file }) => ({ entry, file, score: baseScore(entry, file, q) }));
			hits.sort((a, b) => b.score - a.score || parseTime(b.entry.time) - parseTime(a.entry.time));
			break;
		}
		case "tag": {
			const wanted = q
				.split(/[,\s]+/)
				.map((t) => t.replace(/^#/, "").toLowerCase())
				.filter(Boolean);
			hits = all
				.filter(({ entry }) => entry.tags.some((t) => wanted.includes(t.toLowerCase())))
				.map(({ entry, file }) => ({ entry, file, score: baseScore(entry, file, q) }));
			hits.sort((a, b) => b.score - a.score || parseTime(b.entry.time) - parseTime(a.entry.time));
			break;
		}
		case "recent": {
			hits = all.map(({ entry, file }) => ({ entry, file, score: parseTime(entry.time) }));
			hits.sort((a, b) => b.score - a.score);
			break;
		}
		case "all":
		default: {
			hits = all
				.map(({ entry, file }) => {
					let score = baseScore(entry, file, q);
					const ageDays = (now - parseTime(entry.time)) / 86_400_000;
					score += Math.max(0, 1 - ageDays / 90); // recency bonus, fades over ~90 days
					const wanted = q
						.split(/[,\s]+/)
						.map((t) => t.replace(/^#/, "").toLowerCase())
						.filter(Boolean);
					if (entry.tags.some((t) => wanted.includes(t.toLowerCase()))) score += 1.5;
					return { entry, file, score };
				})
				.filter((h) => h.score > 0.5 || q === "");
			hits.sort((a, b) => b.score - a.score || parseTime(b.entry.time) - parseTime(a.entry.time));
			break;
		}
	}

	const total = hits.length;
	const start = Math.max(0, (page - 1) * pageSize);
	const pageHits = hits.slice(start, start + pageSize);
	return { hits: pageHits, total, page, pageSize, hasMore: start + pageSize < total };
}

/** Format search results as model-facing text (entries include metadata). */
export function formatSearchResult(result: SearchResult, mode: SearchMode, query: string): string {
	if (result.hits.length === 0) {
		return `No memories found (mode: ${mode}${query ? `, query: ${query}` : ""}).`;
	}
	const lines: string[] = [];
	lines.push(
		`Found ${result.total} memor${result.total === 1 ? "y" : "ies"} (mode: ${mode}${query ? `, query: "${query}"` : ""}) — showing page ${result.page} (${result.hits.length}), ${result.hasMore ? "more pages available (use page=N)" : "no more pages"}.`,
	);
	lines.push("");
	for (const hit of result.hits) {
		const e = hit.entry;
		const tags = e.tags.length > 0 ? e.tags.join(",") : "-";
		lines.push(`[${e.id}] ${hit.file} | ${e.time} | src: ${e.source} | tags: ${tags}`);
		lines.push(e.text);
		lines.push("");
	}
	return lines.join("\n").trim();
}
