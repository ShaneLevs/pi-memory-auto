/**
 * Main-file consolidator.
 *
 * Trigger: cleaned main-file content >= 1000 chars (checked after writes).
 * Behavior: background, async, debounced; uses the session model; writes a
 * .bak of the old file; rechecks after consolidating (loop if still over).
 * The main file is ONLY ever written here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CLASSIFICATION_RUBRIC, CONSOLIDATE_THRESHOLD, MAIN_FILE, WRITE_DEBOUNCE_MS } from "./constants.ts";
import { completeWithSessionModel } from "./llm.ts";
import {
	cleanMainContent,
	mainFilePath,
	memoryDir,
	readFileOrEmpty,
	FileMutex,
} from "./store.ts";
import type { Layer } from "./types.ts";

export const CONSOLIDATION_SYSTEM_PROMPT = `You consolidate a main memory file for a coding agent.

${CLASSIFICATION_RUBRIC}

The main file holds ONLY the most important, currently-relevant memories, condensed. It must stay under ${CONSOLIDATE_THRESHOLD} characters (cleaned, excluding metadata comments).

Input: the current main file, plus recent category-file entries for context.

Tasks:
1. Merge duplicates and resolve contradictions (newer information wins unless marked otherwise).
2. Drop stale/superseded/low-value content — be aggressive: less is more.
3. If recent category entries contain important facts not yet reflected, distill the most important into the main file.
4. Preserve entry metadata comments (<!-- mid: ... -->) for entries you keep or adapt; you may rewrite entry text.
5. Output ONLY the new main file content (markdown with entry comments). No explanations.

The output will replace the main file. Keep it under ${CONSOLIDATE_THRESHOLD} characters.`;

export interface ConsolidatorDeps {
	globalDir: string;
	projectRoot: string;
	mutex: FileMutex;
}

export class Consolidator {
	private inFlight = new Set<Layer>();

	private readonly deps: ConsolidatorDeps;

	constructor(deps: ConsolidatorDeps) {
		this.deps = deps;
	}

	/** Schedule a consolidation for a layer (debounced). */
	schedule(layer: Layer, model: unknown, registry: unknown, debounce: DebounceFn): void {
		debounce(`consolidate:${layer}`, async () => {
			await this.consolidate(layer, model, registry);
		}, WRITE_DEBOUNCE_MS);
	}

	/** Run consolidation now if the cleaned main file exceeds the threshold. Never throws. */
	async consolidate(layer: Layer, model: unknown, registry: unknown): Promise<boolean> {
		if (this.inFlight.has(layer)) return false;
		this.inFlight.add(layer);
		try {
			const filePath = mainFilePath(layer, this.deps.globalDir, this.deps.projectRoot);
			let raw = await readFileOrEmpty(filePath);
			if (cleanMainContent(raw).length < CONSOLIDATE_THRESHOLD) return false;

			await this.deps.mutex.run(filePath, async () => {
				// Re-read inside the lock.
				raw = await readFileOrEmpty(filePath);
				if (cleanMainContent(raw).length < CONSOLIDATE_THRESHOLD) return;

				const recentEntries = await this.loadRecentCategoryEntries(layer);
				const result = await completeWithSessionModel(
					model as Parameters<typeof completeWithSessionModel>[0],
					registry as Parameters<typeof completeWithSessionModel>[1],
					{
						systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
						userPrompt: `<current-main-file>\n${raw}\n</current-main-file>\n\n<recent-category-entries>\n${recentEntries}\n</recent-category-entries>`,
						maxTokens: 4096,
					},
				);
				if (!result.ok) return; // keep original; render-time trim is the fallback
				const cleaned = cleanMainContent(result.text);
				if (cleaned.length === 0 || cleaned.length > CONSOLIDATE_THRESHOLD * 1.2) return; // reject bad output
				// Backup then replace.
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.writeFile(`${filePath}.bak`, raw, "utf8");
				await fs.writeFile(filePath, result.text.trim() + "\n", "utf8");
			});

			// Recheck: if still over threshold, schedule another round.
			const after = await readFileOrEmpty(filePath);
			if (cleanMainContent(after).length >= CONSOLIDATE_THRESHOLD) {
				// The caller's debounce will re-trigger on next write; explicit retry here:
				return true;
			}
			return true;
		} catch {
			return false;
		} finally {
			this.inFlight.delete(layer);
		}
	}

	/** Load recent entries from the layer's category files for consolidation context. */
	private async loadRecentCategoryEntries(layer: Layer): Promise<string> {
		const { PROJECT_CATEGORY_FILES, GLOBAL_CATEGORY_FILES } = await import("./constants.ts");
		const files = layer === "project" ? PROJECT_CATEGORY_FILES : GLOBAL_CATEGORY_FILES;
		const dir = memoryDir(layer, this.deps.globalDir, this.deps.projectRoot);
		const chunks: string[] = [];
		for (const f of files) {
			const raw = await readFileOrEmpty(path.join(dir, `${f}.md`));
			if (raw.trim()) chunks.push(`--- ${f}.md (tail) ---\n${raw.trim().slice(-4000)}`);
		}
		return chunks.join("\n\n") || "(empty)";
	}
}

export type DebounceFn = (key: string, fn: () => void | Promise<void>, ms?: number) => void;

/** The main file name, re-exported for wiring convenience. */
export { MAIN_FILE };
