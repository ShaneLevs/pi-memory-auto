import assert from "node:assert/strict";
import { test } from "node:test";
import { findTruncationSignal } from "../src/integrity.ts";
import { parseReviewResponse } from "../src/extractor.ts";

test("a half sentence with a dangling code span is detected", () => {
	// The exact damaged entry found in the real global store.
	assert.equal(
		findTruncationSignal("`pi` CLI extension management: local-path installs (`"),
		"unclosed code span",
	);
});

test("an unclosed parenthesis / bracket / brace is detected", () => {
	assert.equal(findTruncationSignal("Deploy with rsync (after backing up the previous release"), "unclosed parenthesis");
	assert.equal(findTruncationSignal("The flag lives in the array [--delete, --exclude"), "unclosed bracket");
	assert.equal(findTruncationSignal("Configure the object {recursive: true"), "unclosed brace");
});

test("text ending on an opening delimiter or comma is detected", () => {
	assert.equal(findTruncationSignal("Supported values are:"), null);
	assert.equal(findTruncationSignal("Supported values, "), "ends with an opening delimiter");
	assert.equal(findTruncationSignal("See also ("), "unclosed parenthesis");
});

test("complete memories are not flagged", () => {
	const complete = [
		"Deploy with `rsync --delete`; back up the previous release first.",
		"Use `serializeConversation(convertToLlm(messages))` for transcripts.",
		"Text with a literal smiley :) is fine.",
		"Regex `[^\\p{L}\\p{N}_]` splits identifiers.",
		"A shell example `grep -E \"a(b\"` stays inside the code span.",
		"Fenced block:\n```\nfoo(bar\n```\nafter the block.",
		"用户给参考图时要求「直接照抄」，不要简化。",
		"",
	];
	assert.equal(findTruncationSignal(complete[0]!), null);
	assert.equal(findTruncationSignal(complete[1]!), null);
	assert.equal(findTruncationSignal(complete[2]!), null);
	assert.equal(findTruncationSignal(complete[3]!), null);
	assert.equal(findTruncationSignal(complete[4]!), null);
	assert.equal(findTruncationSignal(complete[5]!), null);
	assert.equal(findTruncationSignal(complete[6]!), null);
	// Empty text is rejected separately (it would store a memory with no body).
	assert.equal(findTruncationSignal(complete[7]!), "empty");
});

test("parseReviewResponse drops a truncated entry but keeps the valid ones", () => {
	const response = `===ENTRY===
FILE: TOOLING.md
LAYER: global
TAGS: pi-cli
TEXT: \`pi\` CLI extension management: local-path installs (\`

===ENTRY===
FILE: LESSONS.md
LAYER: global
TAGS: deploy
TEXT: Deploy with \`rsync --delete\`; back up the previous release first.`;
	const parsed = parseReviewResponse(response, "proj");
	assert.equal(parsed.length, 1);
	assert.match(parsed[0]!.text, /back up the previous release/);
});
