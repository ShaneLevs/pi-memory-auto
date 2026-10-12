/**
 * pi-memory-auto — extension entry.
 *
 * Wires:
 * - memory_search / memory_write tools (search-only access; no memory_read)
 * - snapshot injection on session_start + after compaction (before_agent_start)
 * - turn-based auto-extraction (default every 10 turns)
 * - main-file consolidation trigger (cleaned >= 1000 chars, debounced)
 * - compaction handoff
 * - shutdown flush
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./src/config.ts";
import { INJECTION_PREAMBLE, MAIN_FILE, PROJECT_CATEGORY_FILES, GLOBAL_CATEGORY_FILES, WRITABLE_FILES, CLASSIFICATION_RUBRIC, LLM_TIMEOUT_MS } from "./src/constants.ts";
import { Consolidator } from "./src/consolidator.ts";
import { isTrivialSession, runReview, transcriptFromMessages } from "./src/extractor.ts";
import { runHandoff } from "./src/handoff.ts";
import { formatSearchResult, loadAllEntries, searchEntries } from "./src/search.ts";
import { SnapshotManager } from "./src/snapshot.ts";
import { countTurnsFromBranch } from "./src/turns.ts";
import { Debouncer, FileMutex, ProcessLock, appendEntry, isWritableTarget, mainCleanLength } from "./src/store.ts";
import type { Layer, SearchMode } from "./src/types.ts";

export default function piMemoryAuto(pi: ExtensionAPI) {
	const config = loadConfig();
	const mutex = new FileMutex();
	const debouncer = new Debouncer();
	const snapshots = new SnapshotManager();

	let projectRoot = process.cwd();
	let projectName = path.basename(projectRoot);
	let reviewInFlight = false;
	const consolidator = new Consolidator({ globalDir: config.globalDir, projectRoot, mutex, llmMaxTokens: config.llmMaxTokens });

	/** Count conversation turns from the session branch (stateless).
	 *  Turn = one user + one assistant message exchange. Compaction entries are
	 *  not messages, but the history before them stays in the branch, so all
	 *  prior turns are included. Survives reload/resume naturally. */
	function countTurns(ctx: ExtensionContext): number {
		return countTurnsFromBranch(ctx.sessionManager.getBranch() as never);
	}

	/** Extract user/assistant text messages from a branch tail. */
	function transcriptFromBranch(ctx: ExtensionContext, tail: number): { role: string; text: string }[] {
		const messages: { role: string; text: string }[] = [];
		for (const e of ctx.sessionManager.getBranch().slice(-tail)) {
			if (e.type !== "message") continue;
			const m = e.message as { role?: string; content?: unknown };
			if (!m?.role || (m.role !== "user" && m.role !== "assistant")) continue;
			const content = m.content;
			const text = Array.isArray(content)
				? content.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text").map((c) => c.text).join("\n")
				: typeof content === "string" ? content : "";
			messages.push({ role: m.role, text });
		}
		return messages;
	}

	/** Run one background extraction review. Fire-and-forget, never blocks. */
	function scheduleReview(ctx: ExtensionContext, timeoutMs?: number): void {
		if (reviewInFlight) return;
		const { model, registry } = modelInfo(ctx);
		if (!model || !registry) return;
		const messages = transcriptFromBranch(ctx, 40);
		if (isTrivialSession(messages.length)) return;
		const transcript = transcriptFromMessages(messages);
		if (transcript.trim().length === 0) return;

		reviewInFlight = true;
		void runReview({ globalDir: config.globalDir, projectRoot, mutex, plock: new ProcessLock(config.globalDir), llmMaxTokens: config.llmMaxTokens }, transcript, model, registry, timeoutMs)
			.then((written) => {
				if (written.length > 0 && ctx.hasUI) ctx.ui.notify(`memory-auto: saved ${written.length} memory entries`, "info");
			})
			.catch(() => undefined)
			.finally(() => {
				reviewInFlight = false;
			});
	}

	/** Schedule a consolidation for a layer if not already pending/in-flight. */
	function scheduleConsolidation(ctx: ExtensionContext, layer: Layer): void {
		const { model, registry } = modelInfo(ctx);
		if (model && registry) consolidator.schedule(layer, model, registry, (k, fn, ms) => debouncer.schedule(k, fn, ms));
	}

	// Session model access helper (model may be undefined early).
	function modelInfo(ctx: ExtensionContext) {
		return { model: ctx.model, registry: ctx.modelRegistry };
	}

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search long-term memories (global + current project). Entries are returned with metadata (id, time, file, source, tags).",
			"Modes:",
			"- keyword (default): regex/substring match on entry text and tags. Best for concrete terms, symbols, paths, error strings.",
			"- tag: match entries by tag (comma-separated, e.g. \"auth,db\"). Best when a #tag exists for the topic.",
			"- recent: newest entries first. Best for recalling what happened lately without a concrete query.",
			"- all (fused): combines keyword + tag + recency. Best for broad exploratory queries.",
			"Results are paginated (page size 10). Use page=N for more. Never guess memory contents — search instead.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query: keywords, regex, or tags depending on mode." })),
			mode: Type.Optional(StringEnum(["keyword", "tag", "recent", "all"] as const, { description: "Search mode. Default: keyword." })),
			page: Type.Optional(Type.Number({ description: "1-based page number. Default: 1." })),
		}),
		annotations: { readOnlyHint: true },
		execute: async (_id, params) => {
			const mode: SearchMode = params.mode ?? "keyword";
			const page = Math.max(1, Math.floor(params.page ?? 1));
			const all = await loadAllEntries(config.globalDir, projectRoot);
			const result = searchEntries(all, mode, params.query ?? "", page, config.pageSize);
			const text = formatSearchResult(result, mode, params.query ?? "");
			return {
				content: [{ type: "text" as const, text }],
				details: { summary: `${result.hits.length}/${result.total} memories`, mode, page, total: result.total },
				structuredContent: { total: result.total, page, hasMore: result.hasMore, hits: result.hits.map((h) => ({ ...h.entry, file: h.file })) },
			};
		},
	});

	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Save a durable memory for future sessions. Appends one entry with metadata (time, project, source, tags) to a category file.",
			"Classification guide (follow strictly):",
			CLASSIFICATION_RUBRIC,
			"Notes:",
			"- You CANNOT write the main memory files (MEMORY.md); they are consolidated automatically in the background.",
			"- Before writing, use memory_search to check for duplicates; do not re-store equivalent entries.",
			"- Never store secrets, API keys, or tokens.",
		].join("\n"),
		parameters: Type.Object({
			layer: StringEnum(["global", "project"] as const, { description: "global: true across repos. project: specific to this repo. Undecided → project." }),
			file: StringEnum([...WRITABLE_FILES.global, ...WRITABLE_FILES.project] as [string, ...string[]], { description: "Category file: USER, TOOLING, LESSONS (global); CONVENTIONS, DECISIONS, FAILURES (project)." }),
			text: Type.String({ description: "The memory text. Concise, self-contained, durable. One entry." }),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for later retrieval." })),
		}),
		execute: async (_id, params) => {
			const layer = params.layer as Layer;
			if (!isWritableTarget(layer, params.file)) {
				return {
					content: [{ type: "text" as const, text: `Invalid target: ${layer}/${params.file}.md is not writable. Category files only — main files (${MAIN_FILE}) are maintained automatically.` }],
					details: { summary: "write rejected" },
					isError: true,
				};
			}
			const entry = await appendEntry({ layer, file: params.file as never }, params.text, {
				tags: params.tags ?? [],
				source: "user",
				globalDir: config.globalDir,
				projectRoot,
				mutex,
				plock: new ProcessLock(config.globalDir),
			});
			// Main-file growth check triggers consolidation (project layer only
			// when the write went to the project layer; global likewise).
			const cleanedLen = await mainCleanLength(layer, config.globalDir, projectRoot);
			if (cleanedLen >= config.consolidateThreshold) {
				const { model, registry } = modelInfo(ctxRef!);
				if (model && registry) scheduleConsolidation(ctxRef!, layer);
			}
			return {
				content: [{ type: "text" as const, text: `Saved to ${layer}/${params.file}.md [${entry.id}] ${entry.time} tags: ${entry.tags.join(",") || "-"}` }],
				details: { summary: `saved ${layer}/${params.file}.md`, entryId: entry.id } as { summary: string; entryId?: string },
			};
		},
	});

	// ── Lifecycle ────────────────────────────────────────────────────────────

	let ctxRef: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		projectRoot = ctx.cwd;
		projectName = path.basename(projectRoot);
		snapshots.reset();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ctxRef = ctx;
		try {
			const { text: injected, overflowedLayers } = await snapshots.getInjection({
				globalDir: config.globalDir,
				projectRoot,
				preamble: INJECTION_PREAMBLE,
				budget: config.renderBudget,
			});
			// Render overflow means tail entries were dropped at injection time;
			// schedule a consolidation so stale content is pruned at the source.
			for (const layer of overflowedLayers) scheduleConsolidation(ctx, layer);
			if (injected && injected.length > 0) {
				return { systemPrompt: event.systemPrompt + "\n\n" + injected };
			}
		} catch {
			// Never break the run over injection problems.
		}
		return undefined;
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctxRef = ctx;
		// Stateless trigger: count total turns from the branch each turn;
		// extract at every multiple of reviewTurns (e.g. 8 → turns 8, 16, 24...).
		// Includes turns before compaction; survives reload/resume (no counter to lose).
		if (countTurns(ctx) % config.reviewTurns !== 0 || reviewInFlight) return;
		scheduleReview(ctx);
		return undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		ctxRef = ctx;
		snapshots.markCompacted(); // re-inject after compaction (free cache boundary)
		// Fire-and-forget handoff so important state survives compaction.
		const { model, registry } = modelInfo(ctx);
		if (model && registry) {
			const messages: { role: string; text: string }[] = [];
			for (const e of [...event.preparation.messagesToSummarize].slice(-30)) {
				const m = e as unknown as { role?: string; content?: unknown };
				if (!m?.role || (m.role !== "user" && m.role !== "assistant")) continue;
				const content = m.content;
				const text = Array.isArray(content)
					? content.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text").map((c) => c.text).join("\n")
					: typeof content === "string" ? content : "";
				messages.push({ role: m.role, text });
			}
			const transcript = transcriptFromMessages(messages);
			void runHandoff({ globalDir: config.globalDir, projectRoot, mutex, plock: new ProcessLock(config.globalDir), llmMaxTokens: config.llmMaxTokens }, transcript, model, registry).catch(
				() => undefined,
			);
		}
		return undefined; // don't customize compaction itself
	});

	// Exit flush: when the user quits the session, run one final extraction so
	// the tail of the conversation (turns since the last multiple trigger) is
	// not lost. pi awaits session_shutdown handlers before exiting. reload/new/
	// resume/fork do not flush (runtime teardown, not end of conversation).
	// Short self-timeout so quitting never hangs.
	pi.on("session_shutdown", async (event, ctx) => {
		debouncer.clearAll();
		if (event.reason !== "quit") return;
		try {
			scheduleReview(ctx, SHUTDOWN_FLUSH_TIMEOUT_MS);
		} catch {
			// Never block shutdown.
		}
	});

	// Silence unused warnings for names kept for clarity.
	void projectName;
	void PROJECT_CATEGORY_FILES;
	void GLOBAL_CATEGORY_FILES;
}

// Local import kept at bottom to avoid top-level name clash in the factory.
import path from "node:path";

/** Max time the quit-flush review may take; keeps session exit snappy. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = Math.min(30_000, LLM_TIMEOUT_MS);
