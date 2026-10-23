/**
 * Shared type definitions for pi-memory-auto.
 *
 * This module is the interface contract between all sub-modules.
 * Keep it dependency-free (no pi imports) so tests can run standalone.
 */

/** Which layer a memory belongs to. */
export type Layer = "global" | "project";

/** Category files per layer. The main file MEMORY.md is NOT writable via tools. */
export type GlobalFile = "USER" | "TOOLING" | "LESSONS";
export type ProjectFile = "CONVENTIONS" | "DECISIONS" | "FAILURES";
export type CategoryFile = GlobalFile | ProjectFile;

/** How a memory entered the system. */
export type MemorySource = "user" | "auto";

/** One stored memory entry (single source of truth: entry.ts). */
export interface MemoryEntry {
	/** Unique id, e.g. "20261011-a1b2". */
	id: string;
	/** Write time, "YYYY-MM-DD HH:mm:ss" local time. */
	time: string;
	/** Project name for project-layer entries; "-" for global. */
	project: string;
	/** Layer. */
	layer: Layer;
	/** Origin: explicit user request or automatic extraction. */
	source: MemorySource;
	/** Comma-separated tags (may be empty). */
	tags: string[];
	/** Entry body (the memory text itself, may be multi-line). */
	text: string;
	/**
	 * How many times this same body was written. Absent (or 1) means once; the
	 * counter grows when a duplicate write is collapsed into this entry instead
	 * of appending a second row.
	 */
	seen?: number;
	/** Timestamp of the last re-confirmation, same format as `time`. */
	last?: string;
	/**
	 * Ids of the entries this one replaces (the corrected wording). Recorded on
	 * the NEW entry; the replaced ones get `supersededBy`. Nothing is deleted.
	 */
	supersedes?: string[];
	/**
	 * When set, a newer entry replaced this one. A superseded entry stays on disk
	 * and stays searchable (the old wording can still be useful), but it no
	 * longer contributes keywords to the index and never outranks a live memory.
	 */
	supersededBy?: string;
}

/** Search modes for memory_search. */
export type SearchMode = "keyword" | "tag" | "recent" | "all" | "id";

/** A search hit: the entry plus its origin file for context. */
export interface SearchHit {
	entry: MemoryEntry;
	/** File the entry came from, e.g. "project/FAILURES.md". */
	file: string;
	/** Match score (higher = better). For `recent` this is the timestamp. */
	score: number;
	/** True when the memory is past its review interval (staleness.ts). */
	stale?: boolean;
}

/** Result returned to the model by memory_search. */
export interface SearchResult {
	hits: SearchHit[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
	/** True when keyword/all found no match and fell back to newest entries. */
	fallback: boolean;
	/** Query tokens used for matching (for diagnostics in the result text). */
	tokens: string[];
}

/** Layer × file write target for memory_write. */
export interface WriteTarget {
	layer: Layer;
	file: CategoryFile;
}

/** Configuration resolved from environment variables. */
export interface MemoryConfig {
	/** Turns between auto-extraction reviews. */
	reviewTurns: number;
	/** Global memory directory. */
	globalDir: string;
	/** Character budget for the injected memory index (per layer). */
	indexBudget: number;
	/** Memories added between automatic consolidation rounds. */
	consolidateEvery: number;
	/** Search page size. */
	pageSize: number;
	/** maxTokens for background LLM calls (extraction / handoff). */
	llmMaxTokens: number;
	/**
	 * Review interval override in months for staleness (staleness.ts).
	 * 0 = per-file defaults, negative = staleness disabled.
	 */
	reviewMonths: number;
}

/** Result details attached to tool results for UI rendering. */
export interface ToolResultDetails {
	/** Human-readable summary line. */
	summary: string;
	/** Optional structured extras. */
	[k: string]: unknown;
}
