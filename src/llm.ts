/**
 * Thin wrapper around ctx.modelRegistry.complete() for background LLM calls
 * (auto-extraction review and main-file consolidation).
 * Always uses the current session model; fire-and-forget friendly with
 * self-timeout and cacheRetention: "none" (background calls must not pollute
 * the prompt cache).
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { LLM_TIMEOUT_MS } from "./constants.ts";

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

/** Run one provider-neutral completion with the session model. Never throws. */
export async function completeWithSessionModel(
	model: Model<any>,
	registry: { complete: (m: Model<any>, context: unknown, options: unknown) => Promise<{ content: { type: string; text?: string }[] }> },
	opts: CompleteOptions,
): Promise<CompleteResult> {
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
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		return { ok: true, text };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, text: "", error: message };
	} finally {
		clearTimeout(timer);
	}
}
