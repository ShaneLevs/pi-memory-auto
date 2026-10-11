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
}

/** Search modes for memory_search. */
export type SearchMode = "keyword" | "tag" | "recent" | "all";

/** A search hit: the entry plus its origin file for context. */
export interface SearchHit {
	entry: MemoryEntry;
	/** File the entry came from, e.g. "project/FAILURES.md". */
	file: string;
	/** Match score (higher = better). For `recent` this is the timestamp. */
	score: number;
}

/** Result returned to the model by memory_search. */
export interface SearchResult {
	hits: SearchHit[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
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
	/** Rendered per-main-file character budget. */
	renderBudget: number;
	/** Cleaned main-file length that triggers consolidation. */
	consolidateThreshold: number;
	/** Search page size. */
	pageSize: number;
}

/** Result details attached to tool results for UI rendering. */
export interface ToolResultDetails {
	/** Human-readable summary line. */
	summary: string;
	/** Optional structured extras. */
	[k: string]: unknown;
}
