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
import { CLASSIFICATION_RUBRIC, INJECTION_PREAMBLE, LLM_TIMEOUT_MS, MAIN_FILE, WRITABLE_FILES } from "./src/constants.ts";
import { buildExistingMemoriesDigest } from "./src/digest.ts";
import { buildConflictHintBlock, findConflictCandidates } from "./src/conflicts.ts";
import { isTrivialSession, MAX_SUPERSEDES, runReview, serializeTranscript } from "./src/extractor.ts";
import { decideReview, emptyReviewCursor, newMessages, recordAttempt, recordReview, type ReviewCursor } from "./src/review-gate.ts";
import { runHandoff } from "./src/handoff.ts";
import { materializeAll, type LayerStats } from "./src/indexer.ts";
import { findTruncationSignal } from "./src/integrity.ts";
import { MAX_KEYWORDS, sanitizeKeywords } from "./src/keywords.ts";
import { buildMemoryReport } from "./src/report.ts";
import { MEMORY_USAGE, layerLabel, parseMemoryArgs } from "./src/command.ts";
import { runKeywordRekey } from "./src/rekey.ts";
import { formatSearchResult, loadAllEntries, searchEntries } from "./src/search.ts";
import { SnapshotManager } from "./src/snapshot.ts";
import { FileMutex, ProcessLock, appendEntry, isWritableTarget } from "./src/store.ts";
import { countTurnsFromBranch } from "./src/turns.ts";
import { loadUsage, recalledByLayer, recordRecalls } from "./src/usage.ts";
import type { Layer, SearchMode } from "./src/types.ts";

export default function piMemoryAuto(pi: ExtensionAPI) {
	const config = loadConfig();
	const mutex = new FileMutex();
	const snapshots = new SnapshotManager();

	let projectRoot = process.cwd();
	let projectName = path.basename(projectRoot);
	let reviewInFlight = false;
	let consolidationInFlight = false;
	/** Per-session review state: last turn fired for, and how much of the branch
	 *  a previous review already covered (see review-gate.ts). */
	let reviewCursor: ReviewCursor = emptyReviewCursor();
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

	/**
	 * Write the keyword tables and wait for them, WITHOUT waiting for the
	 * (background, LLM-based) consolidation.
	 *
	 * Called on every write path so that "the memory was saved" always implies
	 * "its keyword is on disk in MEMORY.md" by the time the caller continues —
	 * MEMORY.md is program-owned state that is never read back at injection time,
	 * so a stale file is only cosmetic, but it should never exist.
	 */
	async function syncIndexesNow(ctx?: ExtensionContext): Promise<void> {
		const stats = await materializeAll(indexDeps());
		if (ctx) maybeConsolidate(ctx, stats);
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
		// Only the layers that are actually due are sent, and only their files are
		// rewritten: a project accumulating memories must not drag the user's
		// global store through another merge round.
		void loadAllEntries(config.globalDir, projectRoot)
			.then((entries) => runConsolidation(writeDeps(), entries, model, registry, CONSOLIDATION_TIMEOUT_MS, due))
			.then(async (result) => {
				if (result.noop) return;
				// Merges shrink the entry count, so reset the watermark explicitly.
				await materializeAll(indexDeps(), { resetCounter: true, layers: due });
				for (const layer of due) attemptedAt[layer] = 0;
				if (ctx.hasUI) {
					ctx.ui.notify(`memory-auto: consolidated ${result.removed} merged memories (${due.map(layerLabel).join(", ")})`, "info");
				}
			})
			.catch(() => undefined)
			.finally(() => {
				consolidationInFlight = false;
			});
	}

	/** Message payloads currently in the branch, in order (cursor indices refer to this array). */
	function branchMessages(ctx: ExtensionContext): unknown[] {
		return branchEntries(ctx)
			.filter((e) => (e as { type?: string }).type === "message")
			.map((e) => (e as { message?: unknown }).message);
	}

	/** Raw session entries on the leaf path (messages, compaction, custom). */
	function branchEntries(ctx: ExtensionContext): unknown[] {
		return ctx.sessionManager.getBranch();
	}

	/**
	 * How many branch MESSAGES come before `entryId`.
	 *
	 * A compaction handoff only sees `messagesToSummarize` — the span before
	 * `firstKeptEntryId`. Marking the whole branch as covered would skip the kept
	 * tail, which the handoff never looked at.
	 */
	function messagesBefore(ctx: ExtensionContext, entryId: string | null | undefined): number {
		if (!entryId) return branchMessages(ctx).length;
		const entries = branchEntries(ctx);
		const index = entries.findIndex((e) => (e as { id?: string }).id === entryId);
		if (index < 0) return branchMessages(ctx).length;
		let count = 0;
		for (const entry of entries.slice(0, index)) if ((entry as { type?: string }).type === "message") count++;
		return count;
	}

	/**
	 * Build the existing-memories digest for a transcript.
	 *
	 * Relevance-ranked over the WHOLE store rather than newest-40-entries: the row
	 * that needs superseding is often the oldest one, and a time-ordered cut hid
	 * exactly that row. See digest.ts.
	 *
	 * The same loaded store also yields the deterministic conflict hints, so the
	 * review prompt gets both the entries and the "these look like two versions of
	 * one fact" pairs from a single disk pass.
	 */
	async function reviewContext(transcript: string): Promise<{ existingMemories: string; conflictHints: string }> {
		const all = await loadAllEntries(config.globalDir, projectRoot);
		return {
			existingMemories: buildExistingMemoriesDigest(all, transcript),
			conflictHints: buildConflictHintBlock(findConflictCandidates(all)),
		};
	}

	/**
	 * Run one background extraction review. Fire-and-forget unless awaited.
	 *
	 * `messages` is normally only the tail that arrived since the previous review.
	 * The caller has already recorded the turn as attempted; this function advances
	 * the message cursor only when the extraction actually succeeded, so a failed
	 * call (provider error, timeout) leaves that tail uncovered for the next round
	 * instead of silently dropping it.
	 */
	function scheduleReview(
		ctx: ExtensionContext,
		opts: { timeoutMs?: number; messages?: unknown[]; covered?: number } = {},
	): Promise<void> {
		if (reviewInFlight) return Promise.resolve();
		const { model, registry } = modelInfo(ctx);
		if (!model || !registry) return Promise.resolve();
		const branch = branchMessages(ctx);
		const fresh = opts.messages ?? branch;
		// How many messages this call would cover. Recorded on success only.
		const covered = opts.covered ?? branch.length;
		// Triviality is a property of the SESSION, not of the slice: an incremental
		// review covers only the turns since the previous one, which is a handful of
		// messages even in a long session. Testing the slice here would silently
		// drop that tail (the cursor has already moved past it).
		if (isTrivialSession(branch.length)) return Promise.resolve();
		const transcript = serializeTranscript(fresh);
		if (transcript.trim().length === 0) return Promise.resolve();

		reviewInFlight = true;
		return reviewContext(transcript)
			.then(async ({ existingMemories, conflictHints }) => {
				const outcome = await runReview(writeDeps(), transcript, model, registry, opts.timeoutMs, existingMemories, conflictHints);
				// Only a call that actually reached the provider covers the messages. A
				// failed call (error, timeout, empty response) leaves the tail for the next
				// round: dropping it here is how a provider hiccup silently lost a whole
				// conversation, and re-offering it costs one extra call.
				if (!outcome.ok) return;
				reviewCursor = recordReview(reviewCursor, covered);
				const { written } = outcome;
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
			"Reading results:",
			"- An entry marked `superseded by [id]` was replaced: read that entry instead.",
			"- An entry marked `stale (Nd, interval Nmo)` is past its review interval. It is still returned, but verify it against the current repo/code before relying on it — if it is wrong, write the corrected memory with supersedes:[that id].",
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
			const result = searchEntries(all, mode, params.query ?? "", page, config.pageSize, { reviewMonths: config.reviewMonths });
			const text = formatSearchResult(result, mode, params.query ?? "");
			// Read/write loop (usage.ts): credit the keywords that actually found
			// something, so the next session's index ranks by usefulness, not only by
			// how many memories happen to share a keyword. Only page 1 is credited —
			// deeper pages re-read a hit that was already credited.
			if (page === 1) {
				try {
					const credited = recalledByLayer(result, mode);
					const deps = { globalDir: config.globalDir, projectRoot, mutex };
					await recordRecalls("global", credited.global, deps);
					await recordRecalls("project", credited.project, deps);
				} catch {
					// A broken usage log must never break a search.
				}
			}
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
			"- Before writing, use memory_search to check for duplicates; do not re-store equivalent entries. Writing a body that already exists is a no-op: it increments the stored entry's confirmation count instead of adding a duplicate row.",
			"- Use `supersedes` for a CORRECTION, not an addition: pass the id of the memory that is now wrong and write the corrected text. The old entry is kept on disk but stops being injected and ranks below the new one — nothing is deleted, so this is always safe.",
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
			supersedes: Type.Optional(
				Type.Array(Type.String(), {
					maxItems: MAX_SUPERSEDES,
					description:
						"Ids of stored memories this entry replaces (a correction, not a duplicate). The replaced entries are kept on disk but leave the injected index and rank below this one.",
				}),
			),
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
			const outcome = await appendEntry({ layer, file: params.file as never }, params.text, {
				tags: keywords,
				source: "user",
				globalDir: config.globalDir,
				projectRoot,
				mutex,
				plock: new ProcessLock(config.globalDir),
				...(params.supersedes && params.supersedes.length > 0 ? { supersedes: params.supersedes } : {}),
			});
			const entry = outcome.entry;
			const replacedCount = outcome.superseded;
			const replaced = replacedCount > 0 ? `replaced ${replacedCount} ${replacedCount === 1 ? "memory" : "memories"}` : "";
			if (outcome.deduped) {
				// Nothing was appended, so the keyword table only changed if this write
				// ALSO superseded entries (they drop out of the index).
				if (replacedCount > 0) {
					if (ctxRef) await syncIndexesNow(ctxRef);
					else await syncIndexesNow();
				}
				const also = replaced ? ` It also ${replaced}.` : "";
				return {
					content: [
						{
							type: "text" as const,
							text: `Already stored in ${outcome.file} [${entry.id}] — this write was folded into it (seen ×${entry.seen ?? 1}, last ${entry.last ?? entry.time}); no duplicate row was added.${also} If the stored wording is wrong, write the corrected memory and pass supersedes:["${entry.id}"].`,
						},
					],
					details: { summary: `already stored in ${outcome.file}`, entryId: entry.id, deduped: true } as { summary: string; entryId?: string; deduped?: boolean },
				};
			}
			if (ctxRef) await syncIndexesNow(ctxRef);
			else await syncIndexesNow();
			const replacedNote = replaced ? ` · ${replaced}` : "";
			return {
				content: [{ type: "text" as const, text: `Saved to ${outcome.file} [${entry.id}] ${entry.time} keywords: ${entry.tags.join(",")}${replacedNote}` }],
				details: { summary: `saved ${outcome.file}`, entryId: entry.id, deduped: false } as { summary: string; entryId?: string; deduped?: boolean },
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
		{ value: "show", label: "show", description: "Print both layers' keyword index and consolidation watermark" },
		{ value: "compact project", label: "compact project", description: "Merge duplicate memories in this project's layer" },
		{ value: "compact user", label: "compact user", description: "Merge duplicate memories in the user (global) layer" },
		{ value: "rebuild project", label: "rebuild project", description: "Re-derive this project's keywords with the model, then its index" },
		{ value: "rebuild user", label: "rebuild user", description: "Re-derive the user (global) keywords with the model, then its index" },
	];

	pi.registerCommand("memory", {
		description: "Keyword index; compact|rebuild <project|user> act on ONE layer only",
		getArgumentCompletions: (prefix) => MEMORY_SUBS.filter((s) => s.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (args, ctx) => {
			syncProject(ctx);
			const cmd = parseMemoryArgs(args);

			if (cmd.kind === "unknown") {
				ctx.ui.notify(`memory: unknown argument "${cmd.arg}"\n${MEMORY_USAGE}`, "warning");
				return;
			}

			if (cmd.kind === "help") {
				ctx.ui.notify(MEMORY_USAGE, "info");
				return;
			}

			if (cmd.kind === "rebuild") {
				// Both commands are layer-scoped: running a project command must not
				// rewrite the user's shared store, or every project would redo the same
				// global work. A missing layer is a usage error, never a "do both".
				if (!cmd.layer) {
					ctx.ui.notify(`memory: rebuild needs a layer\n${MEMORY_USAGE}`, "warning");
					return;
				}
				const layer = cmd.layer;
				const label = layerLabel(layer);
				// The index is the only memory content in context, so a rebuild
				// re-derives that layer's keywords with the session model rather than
				// just re-rendering the stored ones. Without a session model the same
				// pass still repairs malformed tags deterministically, so the store
				// heals either way.
				const all = await loadAllEntries(config.globalDir, projectRoot);
				const entries = all.filter(({ entry }) => entry.layer === layer);
				const { model, registry } = modelInfo(ctx);
				const withModel = Boolean(model && registry);
				let summary = "";
				if (entries.length > 0) {
					if (withModel) ctx.ui.notify(`memory: re-extracting ${label} keywords for ${entries.length} ${entries.length === 1 ? "memory" : "memories"}…`, "info");
					try {
						const rekeyed = await runKeywordRekey(writeDeps(), entries, model, registry, {
							onProgress: (done, total) => {
								if (ctx.hasUI && done < total) ctx.ui.notify(`memory: ${label} keywords ${done}/${total}…`, "info");
							},
						});
						summary = withModel
							? ` · keywords re-derived: ${rekeyed.updated} changed, ${rekeyed.agreed} already good, ${rekeyed.unchanged} kept`
							: ` · no session model: repaired ${rekeyed.updated} malformed keyword list${rekeyed.updated === 1 ? "" : "s"} only`;
					} catch (error) {
						ctx.ui.notify(`memory: ${label} keyword re-extraction failed — ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				} else {
					summary = " · nothing stored in this layer";
				}
				const stats = await materializeAll(indexDeps(), { layers: [layer] });
				const s = stats[layer];
				ctx.ui.notify(
					`memory: ${label} index ${s.written ? "rebuilt" : "already current"} — ${s.entries} memories / ${s.keywords} keywords${summary}`,
					"info",
				);
				return;
			}

			if (cmd.kind === "compact") {
				if (!cmd.layer) {
					ctx.ui.notify(`memory: compact needs a layer\n${MEMORY_USAGE}`, "warning");
					return;
				}
				const layer = cmd.layer;
				const label = layerLabel(layer);
				const { model, registry } = modelInfo(ctx);
				if (!model || !registry) {
					ctx.ui.notify("memory: no session model available, cannot consolidate", "error");
					return;
				}
				if (consolidationInFlight) {
					ctx.ui.notify("memory: a consolidation round is already running", "warning");
					return;
				}
				consolidationInFlight = true;
				try {
					const all = await loadAllEntries(config.globalDir, projectRoot);
					const entries = all.filter(({ entry }) => entry.layer === layer);
					if (entries.length < 2) {
						ctx.ui.notify(`memory: nothing to merge — ${label} layer holds ${entries.length} memory`, "info");
						return;
					}
					ctx.ui.notify(`memory: consolidating ${label} (${entries.length} memories)…`, "info");
					const result = await runConsolidation(writeDeps(), entries, model, registry, CONSOLIDATION_TIMEOUT_MS, [layer]);
					if (result.noop) {
						// Nothing merged: keep the watermark, but don't re-run on the next write.
						const stats = await materializeAll(indexDeps(), { layers: [layer] });
						attemptedAt[layer] = stats[layer].sinceLast;
						ctx.ui.notify(`memory: nothing to merge in ${label} (${entries.length} memories)`, "info");
						return;
					}
					const stats = await materializeAll(indexDeps(), { resetCounter: true, layers: [layer] });
					attemptedAt[layer] = 0;
					const s = stats[layer];
					ctx.ui.notify(
						`memory: ${label} merged ${result.removed} ${result.removed === 1 ? "memory" : "memories"} across ${result.changedFiles} ${result.changedFiles === 1 ? "file" : "files"} — now ${s.entries} memories / ${s.keywords} keywords`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`memory: ${label} consolidation failed — ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					consolidationInFlight = false;
				}
				return;
			}

			const stats = await materializeAll(indexDeps());
			const entries = await loadAllEntries(config.globalDir, projectRoot);
			const usage = await loadUsage(config.globalDir, projectRoot).catch(() => ({ global: {}, project: {} }));
			const report = buildMemoryReport(entries, {
				globalDir: config.globalDir,
				projectRoot,
				projectName,
				threshold: config.consolidateEvery,
				global: stats.global,
				project: stats.project,
				usage,
				reviewMonths: config.reviewMonths,
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
		// A new session starts with a fresh cadence gate: the branch may already be
		// long (resume/fork), and nothing has been reviewed in it yet.
		reviewCursor = emptyReviewCursor();
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
		// Stateless trigger: count total turns from the branch each turn; fire at
		// every multiple of reviewTurns (e.g. 8 → turns 8, 16, 24...).
		//
		// The DECISION is stateful (review-gate.ts): `turn_end` is delivered more
		// than once for the same turn during a long tool loop, and re-firing on the
		// same turn re-extracts the same conversation into differently-worded
		// "new" memories. A turn index is reviewed at most once per session, and
		// only the messages added since the previous review are sent.
		const turn = countTurns(ctx);
		const decision = decideReview(reviewCursor, turn, config.reviewTurns);
		if (!decision.fire || reviewInFlight) return undefined;
		const branch = branchMessages(ctx);
		const fresh = newMessages(branch, reviewCursor);
		// Record the ATTEMPT before the async work starts, so a duplicate dispatch a
		// moment later cannot slip past the in-flight flag. The message cursor is
		// advanced separately, only after the extraction actually succeeded.
		reviewCursor = recordAttempt(reviewCursor, turn);
		if (fresh.length === 0) return undefined;
		scheduleReview(ctx, { messages: fresh, covered: branch.length });
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
			const summarized = [...event.preparation.messagesToSummarize];
			// The handoff reads the same messages a review would: whatever it covers
			// must not be re-sent by the next periodic review, or the pre-compaction
			// turns get extracted twice (once as handoff, once as review).
			//
			// The cursor moves only when the handoff SUCCEEDED, and only past the span the
			// handoff actually saw. getBranch() keeps the whole leaf path (compaction does
			// not prune it), so a failed handoff leaves those messages available to the
			// next review instead of dropping them.
			const coveredUpTo = messagesBefore(ctx, event.preparation.firstKeptEntryId);
			const transcript = serializeTranscript(summarized);
			void runHandoff(writeDeps(), transcript, model, registry)
				.then(async (outcome) => {
					// Same rule as the periodic review: only a call the provider actually
					// answered covers the messages it was given.
					if (!outcome.ok) return;
					reviewCursor = recordReview(reviewCursor, coveredUpTo);
					if (outcome.written.length > 0) await syncIndexesNow(ctx);
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
			// The flush covers whatever the last periodic review did not. It bypasses
			// the cadence gate on purpose (the session ends here) but still honours the
			// cursor: re-sending the whole branch here would extract the entire
			// conversation one more time, which is how quitting produced duplicate rows.
			// Nothing new since the last review → nothing to flush.
			const fresh = newMessages(branchMessages(ctx), reviewCursor);
			await Promise.race([
				scheduleReview(ctx, { timeoutMs: SHUTDOWN_FLUSH_TIMEOUT_MS, messages: fresh }),
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
