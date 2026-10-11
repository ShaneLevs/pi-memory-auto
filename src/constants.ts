/**
 * Constants for pi-memory-auto.
 *
 * All runtime text that reaches prompts/tool descriptions is English
 * (project rule). Chinese appears only in design docs.
 */

import type { CategoryFile, GlobalFile, Layer, ProjectFile } from "./types.ts";

// ── File names ──────────────────────────────────────────────────────────────

/** Main memory file per layer — the only injection candidate. */
export const MAIN_FILE = "MEMORY.md";

/** Category files per layer. Never injected; no size limit. */
export const GLOBAL_CATEGORY_FILES: readonly GlobalFile[] = ["USER", "TOOLING", "LESSONS"];
export const PROJECT_CATEGORY_FILES: readonly ProjectFile[] = ["CONVENTIONS", "DECISIONS", "FAILURES"];

/** Default global memory directory. */
export const DEFAULT_GLOBAL_DIR = "~/.pi/agent/memory-auto";

/** Project memory directory (relative to project root). */
export const PROJECT_DIR = ".pi/agent/memory-auto";

// ── Budgets ─────────────────────────────────────────────────────────────────

/** Rendered per-main-file character budget (injection). */
export const RENDER_BUDGET = 1000;

/** Cleaned main-file length (chars) that triggers background consolidation. */
export const CONSOLIDATE_THRESHOLD = 1000;

/** Search results page size. */
export const PAGE_SIZE = 10;

/** Debounce window (ms) for background writes (consolidation scheduling). */
export const WRITE_DEBOUNCE_MS = 5000;

/** Self-timeout (ms) for background LLM calls (review/consolidation). */
export const LLM_TIMEOUT_MS = 120_000;

/** Sessions with fewer valid messages than this are skipped by auto-extraction. */
export const MIN_MESSAGES_FOR_REVIEW = 4;

// ── Entry format ────────────────────────────────────────────────────────────

/**
 * Entry metadata comment format:
 * <!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: myproject | src: user | tags: auth,db -->
 * Global entries use p: - .
 */
export const ENTRY_META_PREFIX = "<!-- mid:";

// ── Writable targets ────────────────────────────────────────────────────────

/** All writable (category) targets, keyed by layer. */
export const WRITABLE_FILES: Record<Layer, readonly CategoryFile[]> = {
	global: GLOBAL_CATEGORY_FILES,
	project: PROJECT_CATEGORY_FILES,
};

// ── English rubric (single source of truth, used by memory_write description
//    and the extractor review prompt). Do not translate. ────────────────────

export const CLASSIFICATION_RUBRIC = `# Memory Classification Guide

## Step 1 — Admission: should this be remembered at all?

The test: would a future session, without this memory, do the job wrong or slower?
If not, do not save it.

DO save:
- User profile & preferences: identity, communication style, work habits
- Decisions & rationale: tech/plan choices with the WHY (e.g. "Chose PostgreSQL for JSON support")
- Conventions: team or repo rules (naming, branching, commit style)
- Failures & corrections: what was tried and failed, user corrections, lessons (include what worked instead)
- Insights: reusable knowledge earned from experience
- Tool quirks: non-obvious tool/package/CI behavior

DO NOT save:
- Task progress, session outcomes, temporary state ("currently fixing bug X")
- Anything directly derivable from the repo (what README/code already says)
- One-off details (a specific stack trace, unless the conclusion is reusable)
- General knowledge the model already has
- Secrets, API keys, tokens (never store)

Admission guardrails:
- When in doubt, do not save. "Nothing to save" is a valid outcome.
- Before adding, check for duplicates; skip if an equivalent entry exists.
- Trivial exchanges (no real decisions or corrections) yield no memories.

## Step 2 — Layer: global or project?

The test: would this statement still hold true in a different repo?

| Signal | Layer |
|---|---|
| Mentions repo paths, commands, architecture, team rules | project |
| User facts true regardless of repo (identity, style, habits) | global |
| General environment (OS, shell, editor) | global |
| Project environment (pinned versions, local ports) | project |
| Undecided | project (misrouting here pollutes one repo; misrouting to global pollutes every project) |

Example: "use pnpm, not npm" — a cross-project user habit goes to global TOOLING;
"this repo requires pnpm" goes to project CONVENTIONS. Judge by the wording itself.

## Step 3 — File: which file within the layer?

| File | Accepts | Rejects |
|---|---|---|
| USER.md | identity, profile, communication style | tool preferences (go to TOOLING) |
| TOOLING.md | cross-project tool habits (package manager, editor, shell) | repo-specific commands (go to project layer) |
| LESSONS.md | general lessons & insights (default for global auto-extraction) | project-related lessons (go to project layer) |
| CONVENTIONS.md | repo rules (naming, branches, commit style) | architecture choices (go to DECISIONS) |
| DECISIONS.md | architecture/tech choices with rationale | undecided alternatives |
| FAILURES.md | project-specific pitfalls, failures, corrections (default for project auto-extraction) | general lessons (go to LESSONS) |`;

/** Short usage preamble injected before the rendered main memories. */
export const INJECTION_PREAMBLE = `<memory-auto>
Below are your condensed memories (global, then project for the current repo). Treat them as background context; the user's current request, repository files, and tool outputs override them.

Use memory_search to retrieve details (keyword/tag/recent/all modes, paginated). Use memory_write to save new durable memories — it can only write category files, never these main files; the main files are consolidated automatically in the background.
</memory-auto>`;
