/**
 * Configuration resolved from environment variables.
 */

import os from "node:os";
import path from "node:path";
import { DEFAULT_GLOBAL_DIR, INDEX_BUDGET } from "./constants.ts";
import { CONSOLIDATE_EVERY_DEFAULT } from "./consolidate.ts";
import { REVIEW_MONTHS_DEFAULT } from "./staleness.ts";
import type { MemoryConfig } from "./types.ts";

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Resolve configuration from environment with defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
	const globalDir = expandHome(env.PI_MEMORY_AUTO_DIR?.trim() || DEFAULT_GLOBAL_DIR);
	return {
		reviewTurns: envInt(env, "PI_MEMORY_AUTO_REVIEW_TURNS", 10, 1, 1000),
		globalDir,
		indexBudget: envInt(env, "PI_MEMORY_AUTO_INDEX_BUDGET", INDEX_BUDGET, 200, 6000),
		consolidateEvery: envInt(env, "PI_MEMORY_AUTO_CONSOLIDATE_EVERY", CONSOLIDATE_EVERY_DEFAULT, 2, 500),
		pageSize: 10,
		/** maxTokens for background LLM calls; large enough that extraction
		 *  responses are never truncated (stopReason "length" is rejected). */
		llmMaxTokens: envInt(env, "PI_MEMORY_AUTO_LLM_MAX_TOKENS", 10_000, 1024, 200_000),
		/** Staleness override (months). Unset/0 = per-file defaults (staleness.ts);
	 *  never negative from the environment, so a typo cannot silently disable it. */
		reviewMonths: envInt(env, "PI_MEMORY_AUTO_REVIEW_MONTHS", REVIEW_MONTHS_DEFAULT, 0, 120),
	};
}
