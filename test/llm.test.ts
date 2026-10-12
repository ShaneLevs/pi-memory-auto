import assert from "node:assert/strict";
import { test } from "node:test";
import { completeWithSessionModel, type RegistryLike } from "../src/llm.ts";

const model = { provider: "test", id: "test-model" } as any;

function registryWith(response: any, capture?: (opts: any) => void): RegistryLike {
	return {
		async complete(_m: any, _ctx: unknown, opts: any) {
			capture?.(opts);
			if (response instanceof Error) throw response;
			return response;
		},
	};
}

const okResponse = {
	stopReason: "stop",
	content: [
		{ type: "text", text: "line one" },
		{ type: "thinking", text: "hidden" },
		{ type: "text", text: "line two" },
	],
};

test("success: text extracted, thinking channel ignored", async () => {
	const r = await completeWithSessionModel(model, registryWith(okResponse), { userPrompt: "hi" });
	assert.equal(r.ok, true);
	assert.equal(r.text, "line one\nline two");
});

test("options: cacheRetention none, sessionId, maxTokens, signal", async () => {
	let captured: any;
	await completeWithSessionModel(model, registryWith(okResponse, (o) => (captured = o)), {
		userPrompt: "hi",
		maxTokens: 123,
	});
	assert.equal(captured.cacheRetention, "none");
	assert.ok(captured.sessionId);
	assert.equal(captured.maxTokens, 123);
	assert.ok(captured.signal instanceof AbortSignal);
});

test("no model / no registry -> failure, never throws", async () => {
	const r1 = await completeWithSessionModel(undefined as any, registryWith(okResponse), { userPrompt: "hi" });
	assert.equal(r1.ok, false);
	assert.equal(r1.error, "no session model");
	const r2 = await completeWithSessionModel(model, undefined as any, { userPrompt: "hi" });
	assert.equal(r2.ok, false);
	const r3 = await completeWithSessionModel(model, {} as any, { userPrompt: "hi" });
	assert.equal(r3.ok, false);
});

test("stopReason error / aborted -> failure", async () => {
	const r1 = await completeWithSessionModel(model, registryWith({ stopReason: "error", errorMessage: "boom", content: [] }), { userPrompt: "x" });
	assert.equal(r1.ok, false);
	assert.equal(r1.error, "boom");
	const r2 = await completeWithSessionModel(model, registryWith({ stopReason: "aborted", content: [] }), { userPrompt: "x" });
	assert.equal(r2.ok, false);
});

test("stopReason length (maxTokens truncation) -> failure, partial text rejected", async () => {
	const r = await completeWithSessionModel(
		model,
		registryWith({ stopReason: "length", content: [{ type: "text", text: "partial entry text that was cut off mid-sen" }] }),
		{ userPrompt: "x" },
	);
	assert.equal(r.ok, false);
	assert.equal(r.error, "response truncated (maxTokens)");
});

test("empty text -> failure", async () => {
	const r = await completeWithSessionModel(model, registryWith({ stopReason: "stop", content: [{ type: "thinking", text: "only thinking" }] }), { userPrompt: "x" });
	assert.equal(r.ok, false);
	assert.equal(r.error, "empty response");
});

test("thrown provider error -> failure with message", async () => {
	const r = await completeWithSessionModel(model, registryWith(new Error("network down")), { userPrompt: "x" });
	assert.equal(r.ok, false);
	assert.equal(r.error, "network down");
});

test("timeout aborts and reports timeout", async () => {
	// Registry that hangs until the signal fires.
	const hanging: RegistryLike = {
		complete: (_m, _c, opts: any) =>
			new Promise((_resolve, reject) => {
				opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
			}),
	};
	const r = await completeWithSessionModel(model, hanging, { userPrompt: "x", timeoutMs: 50 });
	assert.equal(r.ok, false);
	assert.equal(r.error, "timeout");
});
