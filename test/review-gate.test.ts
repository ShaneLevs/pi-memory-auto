import assert from "node:assert/strict";
import { test } from "node:test";
import { decideReview, emptyReviewCursor, newMessages, recordAttempt, recordReview } from "../src/review-gate.ts";

test("turn 0 is never due and non-multiples are not due", () => {
	assert.equal(decideReview(emptyReviewCursor(), 0, 5).fire, false);
	assert.equal(decideReview(emptyReviewCursor(), 3, 5).fire, false);
	assert.deepEqual(decideReview(emptyReviewCursor(), 5, 5), { fire: true, turn: 5 });
});

test("the SAME turn is never reviewed twice — the duplicate-memory bug", () => {
	let cursor = emptyReviewCursor();
	assert.equal(decideReview(cursor, 10, 10).fire, true);
	cursor = recordAttempt(cursor, 10);
	// turn_end delivered again for the same index (long tool loop / retry).
	assert.deepEqual(decideReview(cursor, 10, 10), { fire: false, reason: "duplicate_turn" });
	assert.deepEqual(decideReview(cursor, 10, 10), { fire: false, reason: "duplicate_turn" });
});

test("a duplicate turn stays blocked even after the review finished", () => {
	// The old guard was only the in-flight flag, so the second dispatch fired as
	// soon as the first review completed. State, not a flag, must block it.
	let cursor = recordAttempt(emptyReviewCursor(), 20);
	cursor = recordReview(cursor, 100);
	assert.equal(decideReview(cursor, 20, 10).fire, false);
	// The next multiple still fires.
	assert.equal(decideReview(cursor, 30, 10).fire, true);
	cursor = recordReview(recordAttempt(cursor, 30), 150);
	assert.equal(decideReview(cursor, 30, 10).fire, false);
});

test("reviewTurns < 1 never fires", () => {
	assert.equal(decideReview(emptyReviewCursor(), 10, 0).fire, false);
});

test("recording an attempt does not claim the messages were covered", () => {
	// A failed call must leave the tail uncovered: otherwise the failure silently
	// drops the conversation that was never extracted.
	const cursor = recordAttempt(emptyReviewCursor(), 30);
	assert.equal(cursor.cursor, 0);
	assert.equal(cursor.lastTurn, 30);
});

test("the cursor never moves backwards", () => {
	const cursor = recordReview(recordReview(emptyReviewCursor(), 50), 30);
	assert.equal(cursor.cursor, 50);
	assert.equal(recordReview(cursor, 10).cursor, 50);
});

test("recordReview keeps lastTurn intact", () => {
	const cursor = recordReview(recordAttempt(emptyReviewCursor(), 30), 10);
	assert.equal(cursor.lastTurn, 30);
	assert.equal(cursor.cursor, 10);
});

test("only messages after the cursor are extracted", () => {
	const all = ["m1", "m2", "m3", "m4"];
	const cursor = recordReview(emptyReviewCursor(), 2);
	assert.deepEqual(newMessages(all, cursor), ["m3", "m4"]);
	// Nothing new since the last review.
	assert.deepEqual(newMessages(["m1", "m2"], cursor), []);
});

test("a cursor past the end reads as nothing new instead of replaying", () => {
	// Fork / shrunk branch: the branch no longer holds what the cursor counted.
	// Replaying it here is what produced duplicate rows.
	const cursor = recordReview(emptyReviewCursor(), 80);
	assert.deepEqual(newMessages(["m1", "m2", "m3"], cursor), []);
	// It recovers once the branch grows past the cursor again.
	assert.deepEqual(newMessages(new Array(81).fill("m"), cursor), ["m"]);
	assert.deepEqual(newMessages(new Array(82).fill("m"), cursor).length, 2);
});

test("a compaction handoff advances the cursor without claiming a turn", () => {
	const before = recordReview(recordAttempt(emptyReviewCursor(), 10), 100);
	const after = recordReview(before, 140);
	assert.equal(after.cursor, 140);
	assert.equal(after.lastTurn, 10, "the handoff must not mark a turn as reviewed");
	// A handoff that covered less than a review does cannot rewind the cursor.
	assert.equal(recordReview(after, 120).cursor, 140);
});

test("pre-compaction messages are not extracted again by the next review", () => {
	let cursor = recordReview(recordAttempt(emptyReviewCursor(), 10), 100);
	cursor = recordReview(cursor, 160); // compaction summarized 60 more messages
	const branchAfterCompaction = new Array(160).fill("m");
	assert.deepEqual(newMessages(branchAfterCompaction, cursor), []);
	// A new exchange after compaction is still extracted.
	assert.equal(newMessages([...branchAfterCompaction, "new"], cursor).length, 1);
});
