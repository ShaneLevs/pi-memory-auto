import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import {
	buildReviewUserPrompt,
	isTrivialSession,
	parseReviewResponse,
	REVIEW_SYSTEM_PROMPT,
	serializeTranscript,
} from "../src/extractor.ts";
import { CLASSIFICATION_RUBRIC, INJECTION_PREAMBLE } from "../src/constants.ts";

test("loadConfig defaults", () => {
	const c = loadConfig({});
	assert.equal(c.reviewTurns, 10);
	assert.match(c.globalDir, /memory-auto$/);
	assert.equal(c.pageSize, 10);
	assert.equal(c.llmMaxTokens, 10_000);
});

test("loadConfig llmMaxTokens env override + clamping", () => {
	assert.equal(loadConfig({ PI_MEMORY_AUTO_LLM_MAX_TOKENS: "16000" }).llmMaxTokens, 16000);
	assert.equal(loadConfig({ PI_MEMORY_AUTO_LLM_MAX_TOKENS: "abc" }).llmMaxTokens, 10_000);
	assert.equal(loadConfig({ PI_MEMORY_AUTO_LLM_MAX_TOKENS: "100" }).llmMaxTokens, 1024);
});

test("loadConfig env overrides", () => {
	const saved = { turns: process.env.PI_MEMORY_AUTO_REVIEW_TURNS, dir: process.env.PI_MEMORY_AUTO_DIR };
	process.env.PI_MEMORY_AUTO_REVIEW_TURNS = "25";
	process.env.PI_MEMORY_AUTO_DIR = "/tmp/mem";
	try {
		const c = loadConfig();
		assert.equal(c.reviewTurns, 25);
		assert.equal(c.globalDir, "/tmp/mem");
	} finally {
		if (saved.turns === undefined) delete process.env.PI_MEMORY_AUTO_REVIEW_TURNS;
		else process.env.PI_MEMORY_AUTO_REVIEW_TURNS = saved.turns;
		if (saved.dir === undefined) delete process.env.PI_MEMORY_AUTO_DIR;
		else process.env.PI_MEMORY_AUTO_DIR = saved.dir;
	}
	// invalid values fall back to default (out-of-range is clamped to default here)
	assert.equal(loadConfig({ PI_MEMORY_AUTO_REVIEW_TURNS: "abc" }).reviewTurns, 10);
	assert.equal(loadConfig({ PI_MEMORY_AUTO_REVIEW_TURNS: "0" }).reviewTurns, 1);
	assert.equal(loadConfig({ PI_MEMORY_AUTO_REVIEW_TURNS: "-5" }).reviewTurns, 1);
});

test("parseReviewResponse: entries parsed, layer/file validated", () => {
	const response = `===ENTRY===
FILE: FAILURES.md
LAYER: project
TAGS: bug, ci
TEXT: CI needs --frozen-lockfile.

===ENTRY===
FILE: MEMORY.md
LAYER: project
TAGS: -
TEXT: should be rejected (main file)

===ENTRY===
FILE: TOOLING.md
LAYER: global
TAGS: -
TEXT: Shane prefers bun.

NOTHING_TO_SAVE noise should not leak as entry`;
	const parsed = parseReviewResponse(response, "proj");
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0]!.target.file, "FAILURES");
	assert.equal(parsed[0]!.target.layer, "project");
	assert.deepEqual(parsed[0]!.tags, ["bug", "ci"]);
	assert.equal(parsed[1]!.target.file, "TOOLING");
	assert.equal(parsed[1]!.target.layer, "global");
});

test("parseReviewResponse: NOTHING_TO_SAVE only", () => {
	assert.equal(parseReviewResponse("NOTHING_TO_SAVE", "p").length, 0);
	assert.equal(parseReviewResponse("", "p").length, 0);
});

test("parseReviewResponse: SUPERSEDES ids are shape-checked and capped", () => {
	const response = `===ENTRY===
FILE: DECISIONS.md
LAYER: project
TAGS: db
SUPERSEDES: 20261011-a1b2, not-an-id, 20261012-b3c4, 20261013-d5e6
TEXT: Use MySQL after all.

===ENTRY===
FILE: TOOLING.md
LAYER: global
TAGS: bun
SUPERSEDES: -
TEXT: Shane prefers bun.`;
	const parsed = parseReviewResponse(response, "proj");
	assert.equal(parsed.length, 2);
	// Garbage dropped, only the first MAX_SUPERSEDES kept.
	assert.deepEqual(parsed[0]!.supersedes, ["20261011-a1b2", "20261012-b3c4"]);
	assert.deepEqual(parsed[1]!.supersedes, []);
});

test("review prompt teaches SUPERSEDES and keeps the id in the digest contract", () => {
	assert.match(REVIEW_SYSTEM_PROMPT, /SUPERSEDES: <ids of existing memories/);
	assert.match(REVIEW_SYSTEM_PROMPT, /nothing is deleted/);
});

test("trivial session gate", () => {
	assert.equal(isTrivialSession(2), true);
	assert.equal(isTrivialSession(4), false);
});

test("transcript capped and roles labeled", () => {
	const t = serializeTranscript([
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 } },
	]);
	assert.match(t, /\[User\]: hello/);
	assert.match(t, /\[Assistant\]: hi/);
});

test("serializeTranscript: includes tool calls and results, caps length", () => {
	const messages = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "fix the test" }], timestamp: 1 } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "running tests" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test" } },
				],
				timestamp: 2,
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [{ type: "text", text: "1 failed, 3 passed" }],
				isError: true,
				timestamp: 3,
			},
		},
	];
	const t = serializeTranscript(messages);
	assert.ok(t.includes("[User]"));
	assert.ok(t.includes("[Assistant]"));
	assert.ok(t.includes("bash(command="));
	assert.ok(t.includes("[Tool result]"));
	// Truncation keeps the tail (most recent context).
	const long = serializeTranscript([
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "x".repeat(70_000) }], timestamp: 1 } },
	]);
	assert.ok(long.length <= 60_000);
});

test("buildReviewUserPrompt: existing memories section", () => {
	const p = buildReviewUserPrompt("transcript body", "- [global/USER.md] prefers bun");
	assert.ok(p.includes("Existing memories"));
	assert.ok(p.includes("prefers bun"));
	assert.ok(p.includes("transcript body"));
	const empty = buildReviewUserPrompt("t", "");
	assert.ok(empty.includes("(empty"));
});

test("rubric and preamble are English and non-empty", () => {
	assert.ok(CLASSIFICATION_RUBRIC.includes("Step 1 — Admission"));
	assert.ok(CLASSIFICATION_RUBRIC.includes("would a future session"));
	assert.ok(INJECTION_PREAMBLE.includes("memory_search"));
	assert.ok(REVIEW_SYSTEM_PROMPT.includes("NOTHING_TO_SAVE"));
	// Anti-hallucination guard: process lines are evidence, never invent details.
	assert.ok(REVIEW_SYSTEM_PROMPT.includes("[Assistant tool calls]"));
	assert.ok(REVIEW_SYSTEM_PROMPT.includes("never invent"));
	// Existing memories are for dedup.
	assert.ok(REVIEW_SYSTEM_PROMPT.includes("Existing memories"));
});
