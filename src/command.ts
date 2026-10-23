/**
 * `/memory` argument parsing.
 *
 * `compact` and `rebuild` are layer-scoped on purpose: a project command must
 * not rewrite the user's shared global store, otherwise every project would
 * re-process the same global memories (and rewrite MEMORY.md) on every run.
 *
 * Pure and dependency-free so the argument rules can be tested without a session.
 */

import type { Layer } from "./types.ts";

/** A parsed `/memory` invocation. */
export type MemoryCommand =
	| { kind: "show" }
	| { kind: "help" }
	/** `layer` absent means the bare form: show usage instead of guessing. */
	| { kind: "rebuild"; layer?: Layer }
	| { kind: "compact"; layer?: Layer }
	| { kind: "unknown"; arg: string };

/** Layer aliases accepted on the command line. */
const LAYER_ALIASES: Record<string, Layer> = {
	user: "global",
	global: "global",
	g: "global",
	project: "project",
	proj: "project",
	p: "project",
};

/** Resolve a single argument to a layer, or null when it is not a layer name. */
export function parseLayer(arg: string): Layer | null {
	return LAYER_ALIASES[arg.trim().toLowerCase()] ?? null;
}

/** Human label for a layer, as shown in command output. */
export function layerLabel(layer: Layer): string {
	return layer === "global" ? "user" : "project";
}

/** Parse the raw argument string of `/memory`. */
export function parseMemoryArgs(raw: string): MemoryCommand {
	const parts = raw.trim().split(/\s+/).filter(Boolean);
	const sub = (parts[0] ?? "").toLowerCase();
	if (sub === "" || sub === "show") return { kind: "show" };
	if (sub === "help" || sub === "?") return { kind: "help" };
	if (sub !== "rebuild" && sub !== "compact") return { kind: "unknown", arg: sub };

	// A second, unknown token is a typo, not something to silently ignore —
	// silently defaulting would re-introduce the cross-layer work this scoping
	// exists to prevent.
	if (parts.length === 1) return { kind: sub };
	if (parts.length > 2) return { kind: "unknown", arg: parts.slice(1).join(" ") };
	const layer = parseLayer(parts[1]!);
	return layer ? { kind: sub, layer } : { kind: "unknown", arg: parts[1]! };
}

/** Usage text shared by the error paths and `help`. */
export const MEMORY_USAGE = [
	"/memory show              — keyword index, health counters + consolidation watermark (both layers)",
	"/memory compact project   — merge duplicate memories in this project's layer",
	"/memory compact user      — merge duplicate memories in the user (global) layer",
	"/memory rebuild project   — re-derive this project's keywords, then its index",
	"/memory rebuild user      — re-derive the user (global) keywords, then its index",
].join("\n");
