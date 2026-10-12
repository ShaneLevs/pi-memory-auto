import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { isTrivialSession, parseReviewResponse, REVIEW_SYSTEM_PROMPT, transcriptFromMessages } from "../src/extractor.ts";
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

test("trivial session gate", () => {
	assert.equal(isTrivialSession(2), true);
	assert.equal(isTrivialSession(4), false);
});

test("transcript capped and roles labeled", () => {
	const t = transcriptFromMessages([
		{ role: "user", text: "hello" },
		{ role: "assistant", text: "hi" },
		{ role: "assistant", text: "" },
	]);
	assert.match(t, /^user: hello\n\nassistant: hi$/);
});

test("rubric and preamble are English and non-empty", () => {
	assert.ok(CLASSIFICATION_RUBRIC.includes("Step 1 — Admission"));
	assert.ok(CLASSIFICATION_RUBRIC.includes("would a future session"));
	assert.ok(INJECTION_PREAMBLE.includes("memory_search"));
	assert.ok(REVIEW_SYSTEM_PROMPT.includes("NOTHING_TO_SAVE"));
});
