/**
 * LLM calls for background work (auto-extraction review, compaction handoff).
 *
 * Uses the official extension seam: ctx.modelRegistry.complete(model, context,
 * options) — request-time authentication (API key / OAuth) is resolved
 * internally by the registry, same as pi's own compaction path.
 *
 * Defensive behavior (lessons from pi-memory / pi-hermes-memory):
 * - never throws: failures return { ok: false, error }
 * - stopReason "error" / "aborted" are treated as failures
 * - empty text responses are treated as failures
 * - self-timeout via AbortSignal (timer unref'd, never holds the process open)
 * - cacheRetention "none": background calls must not pollute the prompt cache
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { LLM_TIMEOUT_MS } from "./constants.ts";

/** Minimal structural type for ModelRegistry.complete — keeps this module
 * testable without importing pi at runtime. */
export interface RegistryLike {
	complete(model: Model<any>, context: unknown, options?: unknown): Promise<AssistantMessage>;
}

export interface CompleteOptions {
	systemPrompt?: string;
	userPrompt: string;
	maxTokens?: number;
	timeoutMs?: number;
}

export interface CompleteResult {
	ok: boolean;
	text: string;
	error?: string;
}

function extractText(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
}

/** Run one provider-neutral completion with the session model. Never throws. */
export async function completeWithSessionModel(
	model: Model<any>,
	registry: RegistryLike,
	opts: CompleteOptions,
): Promise<CompleteResult> {
	if (!model) return { ok: false, text: "", error: "no session model" };
	if (!registry || typeof registry.complete !== "function") {
		return { ok: false, text: "", error: "model registry unavailable" };
	}

	const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	timer.unref?.();

	try {
		const response = await registry.complete(
			model,
			{
				...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: opts.userPrompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				maxTokens: opts.maxTokens ?? 4096,
				signal: abort.signal,
				cacheRetention: "none",
				sessionId: uuidv7(),
			},
		);

		if (response.stopReason === "aborted" || abort.signal.aborted) {
			return { ok: false, text: "", error: "aborted" };
		}
		if (response.stopReason === "error") {
			return { ok: false, text: "", error: response.errorMessage || "provider error" };
		}
		// A maxTokens-truncated response can cut an entry mid-sentence; storing the
		// partial text would persist a truncated memory. Reject instead.
		if (response.stopReason === "length") {
			return { ok: false, text: "", error: "response truncated (maxTokens)" };
		}

		const text = extractText(response);
		if (!text) {
			return { ok: false, text: "", error: "empty response" };
		}
		return { ok: true, text };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, text: "", error: abort.signal.aborted ? "timeout" : message };
	} finally {
		clearTimeout(timer);
	}
}
