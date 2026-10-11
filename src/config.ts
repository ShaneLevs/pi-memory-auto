/**
 * Configuration resolved from environment variables.
 */

import os from "node:os";
import path from "node:path";
import { DEFAULT_GLOBAL_DIR } from "./constants.ts";
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
		renderBudget: 1000,
		consolidateThreshold: 1000,
		pageSize: 10,
	};
}
