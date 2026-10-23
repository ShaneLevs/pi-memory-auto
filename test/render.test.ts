import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInjection } from "../src/render.ts";

test("empty index means no injection at all", () => {
	assert.equal(buildInjection("PRE", ""), "");
	assert.equal(buildInjection("PRE", "   "), "");
});

test("preamble comes first, index after", () => {
	const out = buildInjection("PRE", "global — 1 entry, 1 topic\n- #x hello [20260101-aaaa]");
	assert.ok(out.startsWith("PRE\n\n"));
	assert.ok(out.includes("#x hello"));
});

test("byte-stable for identical input", () => {
	const a = buildInjection("PRE", "IDX");
	assert.equal(a, buildInjection("PRE", "IDX"));
});
