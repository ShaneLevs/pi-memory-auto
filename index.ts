/**
 * pi-memory-auto — extension entry.
 *
 * Wires:
 * - memory_search / memory_write tools (search-only access; no memory_read)
 * - keyword-table injection on session start + after compaction
 * - turn-based auto-extraction (default every 10 turns)
 * - consolidation every N new memories (merge duplicates, reconcile keywords)
 * - compaction handoff, shutdown flush
 *
 * Injection model: the system prompt receives the layer's MEMORY.md keyword
 * table — unique keywords only, no bodies. The agent matches a keyword against
 * the current task (including synonyms/translations), calls memory_search with
 * it, and gets the entry text from the category files.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./src/config.ts";
import { CONSOLIDATION_TIMEOUT_MS, runConsolidation } from "./src/consolidate.ts";
import { CLASSIFICATION_RUBRIC, EXISTING_MEMORIES_MAX_CHARS, INJECTION_PREAMBLE, LLM_TIMEOUT_MS, MAIN_FILE, WRITABLE_FILES } from "./src/constants.ts";
import { isTrivialSession, runReview, serializeTranscript } from "./src/extractor.ts";
import { runHandoff } from "./src/handoff.ts";
import { materializeAll, type LayerStats } from "./src/indexer.ts";
import { findTruncationSignal } from "./src/integrity.ts";
import { MAX_KEYWORDS, sanitizeKeywords } from "./src/keywords.ts";
import { buildMemoryReport } from "./src/report.ts";
import { runKeywordRekey } from "./src/rekey.ts";
import { formatSearchResult, loadAllEntries, searchEntries } from "./src/search.ts";
import { SnapshotManager } from "./src/snapshot.ts";
import { FileMutex, ProcessLock, appendEntry, isWritableTarget } from "./src/store.ts";
import { countTurnsFromBranch } from "./src/turns.ts";
import type { Layer, SearchMode } from "./src/types.ts";

export default function piMemoryAuto(pi: ExtensionAPI) {
	const config = loadConfig();
	const mutex = new FileMutex();
	const snapshots = new SnapshotManager();

	let projectRoot = process.cwd();
	let projectName = path.basename(projectRoot);
	let reviewInFlight = false;
	let consolidationInFlight = false;
	/** Highest `sinceLast` already sent to consolidation, per layer (avoids
	 *  re-running on every rebuild when the LLM finds nothing to merge). */
	const attemptedAt: Record<Layer, number> = { global: -1, project: -1 };
	let ctxRef: ExtensionContext | undefined;

	const indexDeps = () => ({ globalDir: config.globalDir, projectRoot, mutex, indexBudget: config.indexBudget, projectName });
	const writeDeps = () => ({ globalDir: config.globalDir, projectRoot, mutex, plock: new ProcessLock(config.globalDir), llmMaxTokens: config.llmMaxTokens });

	/** Count conversation turns from the session branch (stateless). */
	function countTurns(ctx: ExtensionContext): number {
		return countTurnsFromBranch(ctx.sessionManager.getBranch() as never);
	}

	function modelInfo(ctx: ExtensionContext) {
		return { model: ctx.model, registry: ctx.modelRegistry };
	}

	/**
	 * Rebuild MEMORY.md keyword tables, then run a consolidation round when a
	 * layer has accumulated `consolidateEvery` new memories.
	 */
	async function refreshIndexes(ctx: ExtensionContext, opts: { resetCounter?: boolean } = {}): Promise<void> {
		const stats = await materializeAll(indexDeps(), opts);
		maybeConsolidate(ctx, stats);
	}

	function maybeConsolidate(ctx: ExtensionContext, stats: { global: LayerStats; project: LayerStats }): void {
		if (consolidationInFlight) return;
		const due = (["global", "project"] as const).filter(
			(layer) => stats[layer].sinceLast >= config.consolidateEvery && stats[layer].sinceLast > attemptedAt[layer],
		);
		if (due.length === 0) return;
		const { model, registry } = modelInfo(ctx);
		if (!model || !registry) return;
		for (const layer of due) attemptedAt[layer] = stats[layer].sinceLast;

		consolidationInFlight = true;
		void loadAllEntries(config.globalDir, projectRoot)
			.then((entries) => runConsolidation(writeDeps(), entries, model, registry, CONSOLIDATION_TIMEOUT_MS))
			.then(async (result) => {
				if (result.noop) return;
				// Merges shrink the entry count, so reset the watermark explicitly.
				await refreshIndexes(ctx, { resetCounter: true });
				if (ctx.hasUI) {
					ctx.ui.notify(`memory-auto: consolidated ${result.removed} merged memories`, "info");
				}
			})
			.catch(() => undefined)
			.finally(() => {
				consolidationInFlight = false;
			});
	}

	/** Build the existing-memories digest (recent entries, for review dedup). */
	async function existingMemoriesDigest(): Promise<string> {
		const all = await loadAllEntries(config.globalDir, projectRoot);
		const lines: string[] = [];
		let total = 0;
		const sorted = all.sort((a, b) => (a.entry.time < b.entry.time ? 1 : -1));
		for (const { entry, file } of sorted) {
			const text = entry.text.trim();
			if (!text) continue;
			const tags = entry.tags.length > 0 ? ` #${entry.tags.join(" #")}` : "";
			const line = `- [${file}]${tags} ${text}`;
			if (total + line.length > EXISTING_MEMORIES_MAX_CHARS) break;
			lines.push(line);
			total += line.length;
		}
		return lines.join("\n");
	}

	/** Run one background extraction review. Fire-and-forget unless awaited. */
	function scheduleReview(ctx: ExtensionContext, timeoutMs?: number): Promise<void> {
		if (reviewInFlight) return Promise.resolve();
		const { model, registry } = modelInfo(ctx);
		if (!model || !registry) return Promise.resolve();
		const branch = ctx.sessionManager.getBranch().filter((e) => (e as { type?: string }).type === "message").map((e) => (e as { message?: unknown }).message);
		if (isTrivialSession(branch.length)) return Promise.resolve();
		const transcript = serializeTranscript(branch);
		if (transcript.trim().length === 0) return Promise.resolve();

		reviewInFlight = true;
		return existingMemoriesDigest()
			.then((existingMemories) => runReview(writeDeps(), transcript, model, registry, timeoutMs, existingMemories))
			.then(async (written) => {
				if (written.length === 0) return;
				await refreshIndexes(ctx);
				if (ctx.hasUI) ctx.ui.notify(`memory-auto: saved ${written.length} memory entries`, "info");
			})
			.catch(() => undefined)
			.finally(() => {
				reviewInFlight = false;
			});
	}

	// ── Tools ────────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"The injected memory index is a table of unique KEYWORDS — the memory bodies are NOT in context. Call this tool when the current task touches any keyword (including a synonym, translation, or the user's own wording for it), then read the returned entries.",
			"Query tips: pass the index keyword plus related terms you know — synonyms, Chinese/English equivalents, file names, library or tool names. Multi-word queries match on ANY word and rank by how many words matched, so extra terms help.",
			"Modes:",
			"- keyword (default): token match on entry text and keywords, ranked by coverage then recency. Falls back to newest entries when nothing matches.",
			"- tag: exact keyword lookup on the canonical keyword (ignores case and separators, so serializeConversation == serialize-conversation). This is the mode for a keyword copied from the index.",
			"- recent: newest entries first. Use when the keyword may be stored under different wording.",
			"- all (fused): keyword + tag + a stronger recency term. Good first try for exploratory questions.",
			"- id: exact entry id, for \"show me that entry again\".",
			"Results are paginated (page size 10) — follow page=N when hasMore. Never guess memory contents — search instead.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query: keywords, tags, or an entry id depending on mode." })),
			mode: Type.Optional(StringEnum(["keyword", "tag", "recent", "all", "id"] as const, { description: "Search mode. Default: keyword." })),
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
				details: { summary: `${result.hits.length}/${result.total} memories`, mode, page, total: result.total, fallback: result.fallback },
				structuredContent: { total: result.total, page, hasMore: result.hasMore, fallback: result.fallback, hits: result.hits.map((h) => ({ ...h.entry, file: h.file })) },
			};
		},
	});

	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Save a durable memory for future sessions. Appends one entry to a category file and adds its keywords to the layer's MEMORY.md index.",
			"Keywords (1-3, required): they are the ONLY thing a future session sees in its memory index, and they are how it finds this entry again. Pick the terms that session would search for — include the user's language AND the English equivalent when they differ (e.g. \"部署\", \"deploy\"), plus file names, library names, or error strings. Reuse an existing keyword when it fits. Each keyword: at most 8 Chinese characters or 8 english words.",
			"Classification guide (follow strictly):",
			CLASSIFICATION_RUBRIC,
			"Notes:",
			"- You cannot write the index file (MEMORY.md); it is generated from the entries.",
			"- Before writing, use memory_search to check for duplicates; do not re-store equivalent entries.",
			"- Never store secrets, API keys, or tokens.",
		].join("\n"),
		parameters: Type.Object({
			layer: StringEnum(["global", "project"] as const, { description: "global: true across repos. project: specific to this repo. Undecided → project." }),
			file: StringEnum([...WRITABLE_FILES.global, ...WRITABLE_FILES.project] as [string, ...string[]], { description: "Category file: USER, TOOLING, LESSONS (global); CONVENTIONS, DECISIONS, FAILURES (project)." }),
			text: Type.String({ description: "The memory text. Concise, self-contained, durable. One entry." }),
			tags: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: MAX_KEYWORDS,
				description: "1-3 retrieval keywords: what a future session would search for. Bilingual when the languages differ.",
			}),
		}),
		execute: async (_id, params) => {
			const layer = params.layer as Layer;
			if (!isWritableTarget(layer, params.file)) {
				return {
					content: [{ type: "text" as const, text: `Invalid target: ${layer}/${params.file}.md is not writable. Category files only — the index file (${MAIN_FILE}) is generated automatically.` }],
					details: { summary: "write rejected" },
					isError: true,
				};
			}
			const { keywords, issues } = sanitizeKeywords(params.tags);
			if (issues.length > 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Keyword rejected:\n${issues.map((i) => `- ${i}`).join("\n")}\n\nRules: 1-${MAX_KEYWORDS} keywords per memory; each at most 8 Chinese characters or 8 english words; no duplicates. Send the call again with corrected keywords.`,
						},
					],
					details: { summary: "keywords rejected" },
					isError: true,
				};
			}
			const truncation = findTruncationSignal(params.text);
			if (truncation) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Write rejected: the memory text looks truncated (${truncation}). Send the complete, self-contained text — a stored half sentence cannot be understood by a future session.`,
						},
					],
					details: { summary: "text rejected (truncated)" },
					isError: true,
				};
			}
			const entry = await appendEntry({ layer, file: params.file as never }, params.text, {
				tags: keywords,
				source: "user",
				globalDir: config.globalDir,
				projectRoot,
				mutex,
				plock: new ProcessLock(config.globalDir),
			});
			if (ctxRef) void refreshIndexes(ctxRef);
			else void materializeAll(indexDeps());
			return {
				content: [{ type: "text" as const, text: `Saved to ${layer}/${params.file}.md [${entry.id}] ${entry.time} keywords: ${entry.tags.join(",")}` }],
				details: { summary: `saved ${layer}/${params.file}.md`, entryId: entry.id } as { summary: string; entryId?: string },
			};
		},
	});

	// ── Commands ─────────────────────────────────────────────────────────────

	/** Re-read the project root: a command can run after the session moved. */
	function syncProject(ctx: ExtensionContext): void {
		projectRoot = ctx.cwd;
		projectName = path.basename(projectRoot);
	}

	const MEMORY_SUBS = [
		{ value: "show", label: "show", description: "Print the keyword index and consolidation watermark" },
		{ value: "compact", label: "compact", description: "Merge duplicate memories now, regardless of the threshold" },
		{ value: "rebuild", label: "rebuild", description: "Re-derive every memory's keywords with the model, then regenerate MEMORY.md" },
	];

	pi.registerCommand("memory", {
		description: "Show the memory keyword index; 'compact' merges duplicates now; 'rebuild' re-derives keywords and regenerates MEMORY.md",
		getArgumentCompletions: (prefix) => MEMORY_SUBS.filter((s) => s.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			syncProject(ctx);
			const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();

			if (sub === "rebuild") {
				// The index is the only memory content in context, so a rebuild
				// re-derives every entry's keywords with the session model rather
				// than just re-rendering the stored ones. Without a session model the
				// same pass still repairs malformed tags deterministically and
				// persists that repair, so the store heals either way.
				const entries = await loadAllEntries(config.globalDir, projectRoot);
				const { model, registry } = modelInfo(ctx);
				const withModel = Boolean(model && registry);
				let summary = "";
				if (entries.length > 0) {
					if (withModel) ctx.ui.notify(`memory: re-extracting keywords for ${entries.length} ${entries.length === 1 ? "memory" : "memories"}…`, "info");
					try {
						const rekeyed = await runKeywordRekey(writeDeps(), entries, model, registry, {
							onProgress: (done, all) => {
								if (ctx.hasUI && done < all) ctx.ui.notify(`memory: keywords ${done}/${all}…`, "info");
							},
						});
						summary = withModel
							? ` · keywords re-derived: ${rekeyed.updated} changed, ${rekeyed.agreed} already good, ${rekeyed.unchanged} kept`
							: ` · no session model: repaired ${rekeyed.updated} malformed keyword list${rekeyed.updated === 1 ? "" : "s"} only`;
					} catch (error) {
						ctx.ui.notify(`memory: keyword re-extraction failed — ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
				const stats = await materializeAll(indexDeps());
				const ok = [stats.global, stats.project].some((s) => s.written);
				ctx.ui.notify(
					`memory: index ${ok ? "rebuilt" : "already current"} — global ${stats.global.entries}/${stats.global.keywords}, project ${stats.project.entries}/${stats.project.keywords}${summary}`,
					"info",
				);
				return;
			}

			if (sub === "compact") {
				const { model, registry } = modelInfo(ctx);
				if (!model || !registry) {
					ctx.ui.notify("memory: no session model available, cannot consolidate", "error");
					return;
				}
				if (consolidationInFlight) {
					ctx.ui.notify("memory: a consolidation round is already running", "warning");
					return;
				}
				ctx.ui.notify("memory: consolidating…", "info");
				consolidationInFlight = true;
				try {
					const entries = await loadAllEntries(config.globalDir, projectRoot);
					const result = await runConsolidation(writeDeps(), entries, model, registry, CONSOLIDATION_TIMEOUT_MS);
					if (result.noop) {
						// Nothing merged: keep the watermark, but don't re-run on the next write.
						const stats = await materializeAll(indexDeps());
						attemptedAt.global = stats.global.sinceLast;
						attemptedAt.project = stats.project.sinceLast;
						ctx.ui.notify(`memory: nothing to merge (${entries.length} memories)`, "info");
						return;
					}
					const stats = await materializeAll(indexDeps(), { resetCounter: true });
					attemptedAt.global = 0;
					attemptedAt.project = 0;
					ctx.ui.notify(
						`memory: merged ${result.removed} ${result.removed === 1 ? "memory" : "memories"} across ${result.changedFiles} ${result.changedFiles === 1 ? "file" : "files"} — now global ${stats.global.entries}/${stats.global.keywords}, project ${stats.project.entries}/${stats.project.keywords}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`memory: consolidation failed — ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					consolidationInFlight = false;
				}
				return;
			}

			if (sub !== "" && sub !== "show") {
				ctx.ui.notify(`memory: unknown argument "${sub}" — use show, compact or rebuild`, "warning");
				return;
			}

			const stats = await materializeAll(indexDeps());
			const entries = await loadAllEntries(config.globalDir, projectRoot);
			const report = buildMemoryReport(entries, {
				globalDir: config.globalDir,
				projectRoot,
				projectName,
				threshold: config.consolidateEvery,
				global: stats.global,
				project: stats.project,
			});
			pi.sendMessage({ customType: "memory-auto.report", content: report, display: true });
		},
	});

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		projectRoot = ctx.cwd;
		projectName = path.basename(projectRoot);
		snapshots.reset();
		// Keep the derived MEMORY.md keyword tables in sync (creates them the
		// first time) and catch up on a consolidation that was due before exit.
		void refreshIndexes(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		ctxRef = ctx;
		try {
			const injected = await snapshots.getInjection({
				globalDir: config.globalDir,
				projectRoot,
				preamble: INJECTION_PREAMBLE,
				indexBudget: config.indexBudget,
				projectName,
			});
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
		if (countTurns(ctx) % config.reviewTurns !== 0 || reviewInFlight) return;
		scheduleReview(ctx);
		return undefined;
	});

	pi.on("session_before_compact", async (event, ctx) => {
		ctxRef = ctx;
		snapshots.markCompacted(); // re-inject after compaction (free cache boundary)
		const { model, registry } = modelInfo(ctx);
		if (model && registry) {
			// Pass the messages as-is: serializeTranscript caps the serialized text by
			// CHARACTERS (HANDOFF_TRANSCRIPT_MAX_CHARS, keeping the tail). Slicing the
			// message array by that number instead would keep N messages, which has
			// nothing to do with the budget.
			const transcript = serializeTranscript([...event.preparation.messagesToSummarize]);
			void runHandoff(writeDeps(), transcript, model, registry)
				.then((written) => {
					if (written.length > 0) void refreshIndexes(ctx);
				})
				.catch(() => undefined);
		}
		return undefined; // don't customize compaction itself
	});

	// Exit flush: one final extraction so the tail of the conversation is not
	// lost. reload/new/resume/fork do not flush (runtime teardown, not the end
	// of a conversation).
	//
	// pi AWAITS this handler and then tears the runtime down with process.exit(),
	// so the review must be awaited here — a fire-and-forget promise would be
	// killed mid-request. The hard timeout keeps quitting snappy.
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;
		try {
			await Promise.race([
				scheduleReview(ctx, SHUTDOWN_FLUSH_TIMEOUT_MS),
				new Promise<void>((resolve) => {
					// Deliberately NOT unref'd: this timer is the guarantee that the
					// await above terminates even if the provider never answers.
					setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS + 2_000);
				}),
			]);
		} catch {
			// Never block shutdown.
		}
	});
}

// Local import kept at bottom to avoid a top-level name clash in the factory.
import path from "node:path";

/** Max time the quit-flush review may take; keeps session exit snappy. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = Math.min(30_000, LLM_TIMEOUT_MS);
