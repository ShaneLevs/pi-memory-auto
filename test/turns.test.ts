import assert from "node:assert/strict";
import { test } from "node:test";
import { countTurnsFromBranch } from "../src/turns.ts";

function msg(role: string): { type: "message"; message: { role: string } } {
	return { type: "message", message: { role } };
}

test("empty branch -> 0 turns", () => {
	assert.equal(countTurnsFromBranch([]), 0);
});

test("complete turns counted", () => {
	const branch = [msg("user"), msg("assistant"), msg("user"), msg("assistant")];
	assert.equal(countTurnsFromBranch(branch), 2);
});

test("incomplete last turn not counted (min rule)", () => {
	const branch = [msg("user"), msg("assistant"), msg("user")];
	assert.equal(countTurnsFromBranch(branch), 1);
	// single user message is not a turn
	assert.equal(countTurnsFromBranch([msg("user")]), 0);
});

test("compaction entries skipped but prior turns still count", () => {
	const branch = [
		msg("user"),
		msg("assistant"),
		{ type: "compaction", summary: "...", firstKeptEntryId: "x", tokensBefore: 100 },
		msg("user"),
		msg("assistant"),
	];
	assert.equal(countTurnsFromBranch(branch), 2);
});

test("other entry types (custom etc.) ignored", () => {
	const branch = [
		{ type: "custom" } as any,
		msg("user"),
		{ type: "custom_message" } as any,
		msg("assistant"),
		msg("user"),
		msg("assistant"),
	];
	assert.equal(countTurnsFromBranch(branch), 2);
});

test("integer multiple trigger semantics", () => {
	const reviewTurns = 10;
	// Simulate turn-by-turn: fires when totalTurns % reviewTurns === 0 and totalTurns > 0.
	const fired: number[] = [];
	for (let t = 1; t <= 25; t++) {
		if (t % reviewTurns === 0) fired.push(t);
	}
	assert.deepEqual(fired, [10, 20]);
});
