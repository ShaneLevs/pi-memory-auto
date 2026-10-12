/**
 * Snapshot state machine for injection.
 *
 * Injection happens ONLY on session start and after compaction. Between those
 * boundaries the snapshot bytes are reused verbatim (prefix-cache friendly).
 */

import { cleanMainContent, readFileOrEmpty, mainFilePath } from "./store.ts";
import { buildInjection } from "./render.ts";
import type { Layer } from "./types.ts";

export class SnapshotManager {
	private snapshot: string | null = null;
	private compactionDirty = false;

	/** Called on session_start (and once at extension factory time is NOT allowed — factory may run without a session). */
	reset(): void {
		this.snapshot = null;
		this.compactionDirty = false;
	}

	/** Called from session_before_compact: next before_agent_start re-renders. */
	markCompacted(): void {
		this.compactionDirty = true;
	}

	/**
	 * Returns the injected block for this turn, or null when the existing
	 * snapshot should be reused (no system-prompt change → cache preserved).
	 *
	 * Also reports which layers overflowed the render budget (content was
	 * trimmed at injection time), so the caller can schedule a consolidation
	 * to shrink the main file instead of silently dropping tail entries.
	 */
	async getInjection(opts: {
		globalDir: string;
		projectRoot: string;
		preamble: string;
		budget: number;
	}): Promise<{ text: string | null; overflowedLayers: Layer[] }> {
		if (this.snapshot !== null && !this.compactionDirty) return { text: null, overflowedLayers: [] };
		const globalRaw = await readFileOrEmpty(mainFilePath("global", opts.globalDir, opts.projectRoot));
		const projectRaw = await readFileOrEmpty(mainFilePath("project", opts.globalDir, opts.projectRoot));
		this.snapshot = buildInjection(opts.preamble, globalRaw, projectRaw, opts.budget);
		this.compactionDirty = false;
		// A layer overflows when its cleaned + compacted content exceeds the
		// budget (i.e. renderMainMemory had to trim). Note the rendered text is
		// hard-sliced to exactly the budget, so it can never exceed it — the
		// pre-trim length is the overflow signal.
		const overflowedLayers: Layer[] = [];
		const compacted = (raw: string) => cleanMainContent(raw).replace(/[ \t]+/g, " ").trim().length;
		if (compacted(globalRaw) > opts.budget) overflowedLayers.push("global");
		if (compacted(projectRaw) > opts.budget) overflowedLayers.push("project");
		// First injection of a session (snapshot was null) must return the block;
		// afterwards reuse bytes. Return the freshly rendered block here.
		return { text: this.snapshot, overflowedLayers };
	}

	/** True when a snapshot exists (i.e. at least one injection happened). */
	get hasSnapshot(): boolean {
		return this.snapshot !== null;
	}
}
