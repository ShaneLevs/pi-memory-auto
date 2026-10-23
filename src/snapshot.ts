/**
 * Snapshot state machine for injection.
 *
 * Injection happens ONLY on session start and after compaction. Between those
 * boundaries the rendered bytes are reused verbatim (prefix-cache friendly).
 *
 * Note that the usage log (usage.ts) is deliberately NOT a re-render trigger:
 * a `memory_search` must not change the system prompt mid-session, or the KV
 * cache is thrown away on every search. Usage shapes the NEXT session's table.
 *
 * The rendered content is the memory index (index-map.ts), computed live from
 * the category files. Nothing here depends on a pre-existing MEMORY.md, so
 * injection cannot deadlock on a file that no one is allowed to create.
 */

import { buildMemoryIndex } from "./index-map.ts";
import { buildInjection } from "./render.ts";
import { loadAllEntries } from "./search.ts";
import { loadUsage } from "./usage.ts";

export class SnapshotManager {
	private snapshot: string | null = null;
	private compactionDirty = false;

	/** Called on session_start (the factory may run without a session). */
	reset(): void {
		this.snapshot = null;
		this.compactionDirty = false;
	}

	/** Called from session_before_compact: next before_agent_start re-renders. */
	markCompacted(): void {
		this.compactionDirty = true;
	}

	/**
	 * Returns the injected block for this run, or null when the existing
	 * snapshot should be reused (no system-prompt change → cache preserved).
	 * Returns "" when nothing is stored yet.
	 */
	async getInjection(opts: {
		globalDir: string;
		projectRoot: string;
		preamble: string;
		/** Character budget for one layer's index section. */
		indexBudget: number;
		projectName?: string;
	}): Promise<string | null> {
		if (this.snapshot !== null && !this.compactionDirty) return null;
		const entries = await loadAllEntries(opts.globalDir, opts.projectRoot);
		// Usage is the read/write loop from usage.ts: keywords that already found
		// something rank above keywords that never did.
		const usageByLayer = await loadUsage(opts.globalDir, opts.projectRoot).catch(() => ({ global: {}, project: {} }));
		const index = buildMemoryIndex(entries, {
			budget: opts.indexBudget,
			projectName: opts.projectName,
			usageByLayer,
		});
		this.snapshot = buildInjection(opts.preamble, index);
		this.compactionDirty = false;
		return this.snapshot;
	}
}
