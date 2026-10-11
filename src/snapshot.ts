/**
 * Snapshot state machine for injection.
 *
 * Injection happens ONLY on session start and after compaction. Between those
 * boundaries the snapshot bytes are reused verbatim (prefix-cache friendly).
 */

import { readFileOrEmpty, mainFilePath } from "./store.ts";
import { buildInjection } from "./render.ts";

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
	 */
	async getInjection(opts: {
		globalDir: string;
		projectRoot: string;
		preamble: string;
		budget: number;
	}): Promise<string | null> {
		if (this.snapshot !== null && !this.compactionDirty) return null;
		const globalRaw = await readFileOrEmpty(mainFilePath("global", opts.globalDir, opts.projectRoot));
		const projectRaw = await readFileOrEmpty(mainFilePath("project", opts.globalDir, opts.projectRoot));
		this.snapshot = buildInjection(opts.preamble, globalRaw, projectRaw, opts.budget);
		this.compactionDirty = false;
		// First injection of a session (snapshot was null) must return the block;
		// afterwards reuse bytes. Return the freshly rendered block here.
		return this.snapshot;
	}

	/** True when a snapshot exists (i.e. at least one injection happened). */
	get hasSnapshot(): boolean {
		return this.snapshot !== null;
	}
}
