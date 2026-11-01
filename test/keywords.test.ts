import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_KEYWORDS,
	MAX_KEYWORDS_PER_LAYER,
	coerceKeywords,
	deriveKeyword,
	keywordDisplay,
	keywordIssue,
	keywordKey,
	sanitizeKeywords,
	splitTagCandidates,
} from "../src/keywords.ts";

test("keywordKey collapses case and separators (uniqueness key)", () => {
	assert.equal(keywordKey("serializeConversation"), "serializeconversation");
	assert.equal(keywordKey("serialize-conversation"), "serializeconversation");
	assert.equal(keywordKey("Serialize Conversation"), "serializeconversation");
	assert.equal(keywordKey("#pnpm"), "pnpm");
	assert.equal(keywordKey("   "), "");
});

test("keywordDisplay is lowercase and dash-joins words", () => {
	assert.equal(keywordDisplay("#PnPM"), "pnpm");
	assert.equal(keywordDisplay("check list"), "check-list");
	assert.equal(keywordDisplay("serializeConversation"), "serializeconversation");
});

test("keywordIssue enforces 8 CJK chars / 8 words", () => {
	assert.equal(keywordIssue("部署"), null);
	assert.equal(keywordIssue("一二三四五六七八"), null);
	assert.equal(keywordIssue("一二三四五六七八九"), "9 characters (max 8)");
	assert.equal(keywordIssue("a b c d e f g h"), null);
	assert.equal(keywordIssue("a b c d e f g h i"), "9 words (max 8)");
	assert.equal(keywordIssue("serializeConversation"), null);
	assert.equal(keywordIssue("   "), "keyword is empty");
});

test("sanitizeKeywords keeps the first keyword and counts the rest as dropped", () => {
	const r = sanitizeKeywords(["部署", "serializeConversation", "serialize-conversation", "deploy", "extra"]);
	assert.deepEqual(r.keywords, ["部署"]);
	// Going over the one-keyword cap is not an error: the extras are dropped, not rejected.
	assert.deepEqual(r.issues, []);
	assert.equal(r.dropped, 4); // every valid extra, including the spelling variant

	const bad = sanitizeKeywords(["一二三四五六七八九"]);
	assert.deepEqual(bad.keywords, []);
	assert.match(bad.issues[0]!, /9 characters \(max 8\)/);
	assert.equal(bad.dropped, 0);
});

test("sanitizeKeywords keeps at most MAX_KEYWORDS", () => {
	assert.equal(MAX_KEYWORDS, 1);
	const r = sanitizeKeywords(["a1", "a2", "a3", "a4"]);
	assert.equal(r.keywords.length, MAX_KEYWORDS);
	assert.deepEqual(r.keywords, ["a1"]);
	assert.equal(r.dropped, 3);
});

test("deriveKeyword prefers backticked identifiers, then latin, then CJK", () => {
	assert.equal(deriveKeyword("call `utools.copyImage(x)` here"), "utools.copyimage");
	assert.equal(deriveKeyword("Use pnpm in this repo"), "use");
	// Latin tokens win over CJK runs; a pure-CJK body yields a CJK keyword.
	assert.equal(deriveKeyword("这个仓库必须使用 pnpm"), "pnpm");
	assert.equal(deriveKeyword("这个仓库很重要"), "这个仓库很重要");
	assert.equal(deriveKeyword("!!!"), "misc");
});

test("per-layer cap is 200 keywords", () => {
	assert.equal(MAX_KEYWORDS_PER_LAYER, 200);
});

test("splitTagCandidates splits legacy '#'-prefixed blobs but keeps multi-word keywords", () => {
	assert.deepEqual(splitTagCandidates("#ui-taste #design-feedback #screenshots"), ["ui-taste", "design-feedback", "screenshots"]);
	// A '#' glued into the middle is a separator too: a model answering
	// "TAGS: memory-write #tool-quirk" used to store one unsearchable keyword.
	assert.deepEqual(splitTagCandidates("memory-write-#tool-quirk"), ["memory-write", "tool-quirk"]);
	// A genuine multi-word keyword (allowed by the 8-word rule) survives whole.
	assert.deepEqual(splitTagCandidates("Serialize Conversation"), ["Serialize Conversation"]);
	// Commas are always separators.
	assert.deepEqual(splitTagCandidates("deploy, rsync"), ["deploy", "rsync"]);
	assert.deepEqual(splitTagCandidates("  "), []);
});

test("sanitizeKeywords never stores a '#' glue blob", () => {
	assert.deepEqual(sanitizeKeywords(["memory-write-#tool-quirk"]).keywords, ["memory-write"]);
	// The split still happens, so the extras are counted as dropped (not as one blob).
	assert.equal(sanitizeKeywords(["memory-write-#tool-quirk"]).dropped, 1);
	assert.deepEqual(sanitizeKeywords(["#a #b"]).keywords, ["a"]);
	assert.equal(sanitizeKeywords(["#a #b"]).dropped, 1);
	// A '#' inside a keyword is still rejected when it reaches validation directly.
	assert.match(keywordIssue("memory-write-#tool-quirk") ?? "", /contains '#'/);
});

test("coerceKeywords repairs dirty tags in the read path", () => {
	// One keyword is the contract, so an old three-keyword entry reaches the
	// index as its first keyword only — and is flagged as needing a rebuild.
	const dirty = coerceKeywords(["#a #b #c #d #e"], "body");
	assert.deepEqual(dirty.keywords, ["a"]);
	assert.equal(dirty.changed, true);
	assert.equal(dirty.derived, false);

	const legacy = coerceKeywords(["deploy", "rsync"], "body");
	assert.deepEqual(legacy.keywords, ["deploy"]);
	assert.equal(legacy.changed, true);

	const clean = coerceKeywords(["deploy"], "body");
	assert.deepEqual(clean.keywords, ["deploy"]);
	assert.equal(clean.changed, false);
});

test("coerceKeywords derives a keyword when the stored tags are unusable", () => {
	const r = coerceKeywords(["一二三四五六七八九"], "call `pnpm install` first");
	assert.equal(r.derived, true);
	assert.equal(r.changed, true);
	assert.deepEqual(r.keywords, ["pnpm"]);
});

test("coerceKeywords never returns more than MAX_KEYWORDS", () => {
	assert.equal(coerceKeywords(["a", "b", "c", "d", "e"], "x").keywords.length, MAX_KEYWORDS);
	assert.equal(MAX_KEYWORDS, 1);
});
