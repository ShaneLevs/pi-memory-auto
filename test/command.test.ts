import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_USAGE, layerLabel, parseLayer, parseMemoryArgs } from "../src/command.ts";

test("bare show / empty argument shows the index", () => {
	assert.deepEqual(parseMemoryArgs(""), { kind: "show" });
	assert.deepEqual(parseMemoryArgs("   "), { kind: "show" });
	assert.deepEqual(parseMemoryArgs("show"), { kind: "show" });
	assert.deepEqual(parseMemoryArgs("SHOW"), { kind: "show" });
});

test("compact and rebuild require an explicit layer", () => {
	// No layer -> usage error, NOT "both layers": silently doing both is the
	// cross-project repetition this scoping exists to prevent.
	assert.deepEqual(parseMemoryArgs("compact"), { kind: "compact" });
	assert.deepEqual(parseMemoryArgs("rebuild"), { kind: "rebuild" });
	assert.equal(parseMemoryArgs("compact").kind === "compact" && !("layer" in parseMemoryArgs("compact")), true);
});

test("layer names and aliases resolve to the internal layer", () => {
	assert.deepEqual(parseMemoryArgs("compact project"), { kind: "compact", layer: "project" });
	assert.deepEqual(parseMemoryArgs("compact user"), { kind: "compact", layer: "global" });
	assert.deepEqual(parseMemoryArgs("rebuild user"), { kind: "rebuild", layer: "global" });
	assert.deepEqual(parseMemoryArgs("rebuild project"), { kind: "rebuild", layer: "project" });
	// Aliases and case/whitespace tolerance.
	assert.deepEqual(parseMemoryArgs("  REBUILD   Global "), { kind: "rebuild", layer: "global" });
	assert.equal(parseLayer("g"), "global");
	assert.equal(parseLayer("p"), "project");
	assert.equal(parseLayer("proj"), "project");
	assert.equal(parseLayer("nope"), null);
});

test("a misspelled layer is an error, never a silent default", () => {
	assert.deepEqual(parseMemoryArgs("rebuild projects"), { kind: "unknown", arg: "projects" });
	assert.deepEqual(parseMemoryArgs("compact glboal"), { kind: "unknown", arg: "glboal" });
	assert.deepEqual(parseMemoryArgs("rebuild project extra"), { kind: "unknown", arg: "project extra" });
	assert.deepEqual(parseMemoryArgs("nuke"), { kind: "unknown", arg: "nuke" });
});

test("help is available and uses the layer vocabulary", () => {
	assert.deepEqual(parseMemoryArgs("help"), { kind: "help" });
	assert.deepEqual(parseMemoryArgs("?"), { kind: "help" });
	for (const sub of ["compact project", "compact user", "rebuild project", "rebuild user"]) {
		assert.ok(MEMORY_USAGE.includes(`/memory ${sub}`), sub);
	}
});

test("labels use 'user' for the global layer", () => {
	assert.equal(layerLabel("global"), "user");
	assert.equal(layerLabel("project"), "project");
});
