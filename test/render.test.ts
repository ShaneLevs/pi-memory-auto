import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInjection, renderMainMemory } from "../src/render.ts";

const meta = "<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: proj | src: user | tags: t -->\n";
const raw = `${meta}First entry text.\n\n${meta}Second entry text.\n`;

test("strips metadata and compacts whitespace", () => {
	const out = renderMainMemory(raw, 1000);
	assert.equal(out, "First entry text.\n\nSecond entry text.");
});

test("budget trim drops whole paragraphs from the end", () => {
	const long = `${meta}${"a".repeat(40)}\n\n${meta}${"b".repeat(40)}\n\n${meta}${"c".repeat(40)}\n`;
	const out = renderMainMemory(long, 100);
	assert.ok(out.length <= 100);
	assert.ok(out.startsWith("a".repeat(40)));
	assert.ok(!out.includes("c".repeat(40)));
});

test("single huge paragraph hard-sliced within budget", () => {
	const out = renderMainMemory("x".repeat(500), 100);
	assert.ok(out.length <= 100);
});

test("byte-stable for identical input", () => {
	assert.equal(renderMainMemory(raw, 1000), renderMainMemory(raw, 1000));
});

test("buildInjection: empty sections omitted, preamble prepended", () => {
	const out = buildInjection("PRE", raw, "", 1000);
	assert.ok(out.startsWith("PRE"));
	assert.ok(out.includes("## Global memory"));
	assert.ok(!out.includes("## Project memory"));
	assert.equal(buildInjection("PRE", "", "", 1000), "");
});

test("buildInjection includes both sections when present", () => {
	const out = buildInjection("PRE", "G", "P", 1000);
	assert.ok(out.includes("## Global memory\n\nG"));
	assert.ok(out.includes("## Project memory\n\nP"));
});
