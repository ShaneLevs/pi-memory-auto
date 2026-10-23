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

/** Default character budget for the injected keyword table (per layer).
 *  Keyword lines are short (~14 chars), so this fits the 200-keyword cap. */
export const INDEX_BUDGET = 3000;

/** Search results page size. */
export const PAGE_SIZE = 10;

/** Self-timeout (ms) for background LLM calls (review / handoff). */
export const LLM_TIMEOUT_MS = 120_000;
/** Sessions with fewer valid messages than this are skipped by auto-extraction. */
export const MIN_MESSAGES_FOR_REVIEW = 4;

/** Cap (chars) for the serialized review/handoff transcript. */
export const TRANSCRIPT_MAX_CHARS = 60_000;

/** Cap (chars) for the existing-memories section in the review prompt. */
export const EXISTING_MEMORIES_MAX_CHARS = 4_000;

/** Cap (chars) for the serialized handoff transcript. */
export const HANDOFF_TRANSCRIPT_MAX_CHARS = 60_000;

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

/**
 * Injected index preamble: what the block is and when to search.
 * Written as a trigger list, not a passive description — retrieval only happens
 * if the model recognizes the moment it should search.
 */
export const INJECTION_PREAMBLE = `<memory-auto>
This is the memory index: one line per KEYWORD from a past session. The memory bodies are NOT in context.

When the current task touches any keyword below — including a synonym, a translation, or the user's own wording for it — call memory_search with mode:"tag" and that keyword BEFORE acting, answering, or asking the user. Add related terms you know (other languages, file names, tool names) to widen the search.

The number in parentheses is how many memories share that keyword. "(+N more keywords)" means the table was truncated — use mode:"recent" for the newest memories.

Never guess stored content. If nothing matches, say so instead of inventing it. memory_write requires 1-3 keywords: they are what future sessions will see.
</memory-auto>`;
