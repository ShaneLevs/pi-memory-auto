# pi-memory-auto — technical documentation

[English README](README.md) · [中文说明](README.zh-CN.md) · **Technical documentation**

How the store is laid out, what runs when, and why each mechanism is shaped the
way it is. Everything here is implementation detail — the user-facing story is
in the [README](README.md).

- [Model](#model)
- [Invariants](#invariants)
- [Lifecycle](#lifecycle)
- [What happens to a memory](#what-happens-to-a-memory)
- [Storage layout](#storage-layout)
- [Entry format](#entry-format)
- [Keyword rules](#keyword-rules)
- [Injection](#injection)
- [Write path](#write-path)
- [Staleness](#staleness)
- [Usage log](#usage-log)
- [Near-duplicate detection](#near-duplicate-detection)
- [Superseded requirements](#superseded-requirements)
- [Consolidation](#consolidation)
- [Retrieval](#retrieval)
- [Commands](#commands)
- [Health report](#health-report)
- [Configuration](#configuration)
- [Development](#development)
- [Changelog (detailed)](#changelog-detailed)

## Model

```
memory_write(body, keywords[1..3], supersedes?[])
      │
      ├─► body      → <layer>/<FILE>.md          (append-only, source of truth)
      │                 · identical body again → seen/last bumped, no new row
      │                 · supersedes: [id]      → old row gains superseded-by (kept)
      └─► keywords  → <layer>/MEMORY.md          (derived table, program-owned, never read back)

memory_search → <layer>/usage.json              (which keywords actually found something)

every N new memories → consolidation (merge duplicates, rename keywords) → rebuild
```

- A keyword is **unique per layer**, but many memories may share it and one memory has 1–3.
- Layer is global (`~/.pi/agent/memory-auto/`) or project (`<project>/.pi/agent/memory-auto/`); read isolation is by location.
- Everything in `MEMORY.md` is derived from the entries — it can be deleted at any time and is rebuilt on the next write or session start.
- **`MEMORY.md` is program-owned: never edit it by hand.** The extension rewrites it on every memory write, `/memory rebuild` and consolidation, so a manual line is simply lost on the next write. It is also never read back — injection re-renders the table from the category files, which keeps the injected bytes honest even if the file is stale, missing or damaged. Treat it as a read-only view of derived state.

## Invariants

Four rules that every module obeys; most of the design follows from them.

1. **Nothing is ever deleted, except a validated merge.** `supersedes` adds a
   field, staleness is computed, the usage log is disposable. The only write
   path that removes a row is consolidation, and only when the model proposed
   the merge *and* the plan validated against entries that actually exist. The
   only other deletion is a layer's `MEMORY.md` when its last entry is gone.
   A changed requirement is therefore handled by **retiring** the old row
   (`superseded-by`), never by dropping it — an automated system that can delete
   has no way to undo a wrong deletion, and the entry is the only record of what
   used to be true.
2. **The model proposes, the code decides.** Extraction output, consolidation
   plans and keywords are all re-validated locally. A failed or malformed LLM
   response changes nothing.
3. **No hook or tool may throw.** Index refresh, injection, extraction,
   handoff and usage writes all swallow their errors and degrade to "no memory
   this turn". A broken memory system must not break the conversation.
4. **Derived state never drives a decision.** `MEMORY.md` is never read back,
   `usage.json` only reorders a table, staleness stores nothing. Deleting any
   derived file costs ranking quality, never a memory.

## Lifecycle

Five hooks, in the order a session hits them. None of them can fail the run.

| Hook | What runs | Awaited? |
|---|---|---|
| `session_start` | Rewrite both `MEMORY.md` tables from the entries, then `maybeConsolidate` — which catches up a round that was due before the last exit | no, the session starts immediately |
| `before_agent_start` | Re-render the keyword table **only** on the first run and right after compaction; every other run returns nothing, so the prompt bytes stay identical and the prefix cache survives | yes (it builds the prompt) |
| `turn_end` | Every `REVIEW_TURNS` turns: serialize the messages added since the last review, review them, append at most 3 entries, rebuild the index. A turn index is reviewed at most once, so repeated `turn_end` delivery cannot re-extract | no, it lands on a later turn |
| `session_before_compact` | One handoff extraction over the messages being summarized (at most 2 entries), then mark the index for re-render | no, compaction is never delayed |
| `session_shutdown` | Only for `quit` (never reload/new/resume/fork): one last review of the conversation tail, hard-capped at 30 s and awaited — pi tears the process down right after the handler returns | yes, raced against a timeout |

Turn counting is stateless: the turn number is derived from the session branch
on every `turn_end`, so restarts, compaction and forks cannot desynchronise a
counter. The *decision* to review is stateful (`src/review-gate.ts`), and its
two pieces of state move at different moments on purpose:

- `lastTurn` is recorded **before** the async call. A repeated `turn_end` for
the same turn index can therefore never start a second review, even after the
first one has finished.
- the message `cursor` is recorded **after** the call succeeded. If the provider
errors, times out or returns an empty/aborted response, nothing is marked as
covered and the next round re-offers the same tail. Both `runReview` and
`runHandoff` report this as `ok: false`, so "the model never answered" is never
confused with "the conversation held nothing worth storing".

A session with fewer than 4 messages is never reviewed. Triviality is tested
against the whole branch, not against the slice being sent: an incremental
review covers only the turns since the previous one, which is a handful of
messages even in a long session.

Extraction is skipped entirely when: the session is trivial, no session model
is available, a review is already in flight, the turn was already reviewed (`turn_end`
is delivered more than once per turn during a long tool loop), there is nothing
new after the cursor, or the serialized transcript is empty. Only the messages
after the cursor are sent, and the transcript is capped at 60 000 characters
**keeping the tail**; it runs through pi's own `serializeConversation` (the
compaction path), so the model sees `[Assistant tool calls]` / `[Tool result]`
lines and not only prose. The review prompt also carries an "Existing memories"
digest (capped at 4 000 characters, all ids that fit are listed) and any
`<possible-conflicts>` pairs — that is what makes dedup, `SUPERSEDES:` and
retiring an outdated requirement possible.

## What happens to a memory

Every mechanism acts on one of these rows:

| Situation | Mechanism | In the index | In search | On disk |
|---|---|---|---|---|
| Written again, identical body | `seen`/`last` bumped in place | unchanged | unchanged | one row |
| Written again, different wording | nothing — it becomes a near-duplicate candidate | both keywords listed | both rows returned | two rows, until a merge |
| Written again about the same subject with a changed value | conflict candidate → the model judges it, then `supersedes` | only the new row's keywords stay | old row ranks last, labelled | two rows, old one marked |
| Corrected | `supersedes` → old row gains `superseded-by` | old row's keywords leave | old row ranks last, labelled | old row kept |
| Not verified for its interval | derived from `last`/`time`, nothing stored | unchanged | ranks below fresh, labelled `stale` | kept |
| Merged by consolidation | drop rows, keep one, rewrite the file (`.bak` kept) | recomputed | one result | row removed |
| Layer emptied | `MEMORY.md` deleted | file removed | empty | — |

## Storage layout

```
~/.pi/agent/memory-auto/          # global layer
  MEMORY.md                       # generated keyword table (unique keywords)
  usage.json                      # keyword recall counters (sidecar, never injected)
  USER.md  TOOLING.md  LESSONS.md # entry bodies

<project>/.pi/agent/memory-auto/  # project layer (commit it — team-shareable)
  MEMORY.md                       # generated keyword table
  usage.json                      # sidecar: per-machine use counts
  CONVENTIONS.md  DECISIONS.md  FAILURES.md
```

`usage.json` is the only file that churns on every search and is machine-specific
— if the project layer is committed, add `usage.json` (and `*.bak`) to
`.gitignore`. It is disposable: deleting it only loses ranking bias, never a
memory. Consolidation keeps a `.bak` of every file it rewrites.

`MEMORY.md`:

```markdown
<!-- AUTO-GENERATED — do not edit. This file is owned entirely by the extension: … -->
<!-- stats: entries=9 keywords=17 sinceLast=3 lastConsolidated=2026-10-23T10:00:00.000Z -->
#deploy (3)
#pnpm
#serialize-conversation (2)
```

The `(n)` is **how many memories use that keyword** — not an entry number.
Ordering is `count + min(recalls, 4)`, then `count`, then alphabetical: a keyword
that several memories share *and* that has actually found something sorts first,
so the fixed budget keeps the useful part of the table. `sinceLast` is the
consolidation watermark: memories added since the last round.

The watermark advances by the delta in entry count on every rebuild
(`max(0, entriesNow - previous.entries)`, so merging cannot make it negative, and
a missing file starts at 0), and resets to 0 when a consolidation round
completes. It is a count of *new input*, never the size of an output file.

## Entry format

```markdown
<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: myproject | src: user | tags: deploy,rsync,备份 -->
Deploy with `rsync --delete`; back up the previous release first.
```

Optional trailing fields (absent in the common case, so a normal entry's bytes stay minimal):

| Field | Meaning |
|---|---|
| `seen: 3 \| last: <time>` | The same body was written again 3 times; `last` is the most recent confirmation. Drives `memory_write`'s "already stored" answer and refreshes the staleness clock. |
| `supersedes: <id>,<id>` | On a corrected entry: the entries it replaces. |
| `superseded-by: <id>` | On a replaced entry: kept on disk, out of the index, ranked last in search. |

- `tags` are the keywords (1–3). They are the retrieval surface.
- Metadata comments are stripped from the injected index and always kept in search results.
- Ids are shape-checked on read (`YYYYMMDD-xxxx`): a hand-edited or truncated
  file cannot make an entry point at garbage or de-index itself.
- The body must be complete: text with an unclosed code span, unbalanced
  `(`/`[`/`{`, or a trailing opening delimiter is rejected as truncated
  (`src/integrity.ts`).

## Keyword rules

| Rule | Where it is enforced |
|---|---|
| 1–3 per memory | `sanitizeKeywords` on `memory_write` (rejects), `parseReviewResponse` / `runHandoff` (derive or trim), `coerceKeywords` on read + `/memory rebuild` |
| ≤ 8 Chinese characters or 8 english words | `keywordIssue`; the extractor and rekey prompts state it too |
| Unique per layer | canonical key = lowercase with separators removed (`src/keywords.ts`) |
| ≤ 200 per layer | `collectKeywords` cap; the lowest-ranked keywords (shared count + recalls) are dropped from the table (their memories stay searchable by text) |

Stored tags are repaired on read (`coerceKeywords`): legacy space-separated
`#a #b #c` blobs are split back into individual keywords, over-long or invalid
ones are dropped, and an entry left with nothing gets a keyword derived from its
body. The read path never writes — `/memory rebuild` is what persists the repair.

## Injection

The system prompt gets the keyword table, rendered once per session:

```
<memory-auto>
This is the memory index: one line per KEYWORD from a past session. The memory bodies are NOT in context.
When the current task touches any keyword below … call memory_search with mode:"tag" …
</memory-auto>

global — 7 memories, 24 keywords
#macos
#svg (2)
#utools (4)

project: myrepo — 9 memories, 17 keywords
#deploy (3)
…
```

- Byte-stable within a session (snapshot), so the prompt prefix cache stays
  warm; re-rendered after compaction. `SnapshotManager` holds exactly two
  fields (`snapshot`, `compactionDirty`): a cached snapshot returns `null` from
  `getInjection`, which means "do not touch the prompt".
- **Rendered from the category files at injection time, not read from
  `MEMORY.md`.** Both are produced by the same builder from the same entries
  (`MEMORY.md` writes all 200 keywords, the injected block trims the same table
  to the budget), but rendering live means a stale, deleted or hand-damaged
  `MEMORY.md` can never affect what the model sees.
- A `memory_write` does **not** change the current session's prompt: the new
  keyword appears in the next session's table. Same for `usage.json` — it is
  deliberately not a re-render trigger, or every search would throw the KV cache
  away.
- Nothing is injected when nothing is stored.
- Truncation is explicit and staged (see `renderKeywordTable`): counted lines
  first, then the remaining keywords packed onto continuation lines without
  counts (a count costs 4 characters and is the least useful information in the
  table — this roughly doubles how many topics fit), and only then
  `(+N more — memory_search mode:"keyword")`. The hint points at a real lookup,
  not at `recent`, the weakest retrieval mode.

## Write path

`appendEntry` (`src/store.ts`), in order:

1. Normalize the body with `normalizeMemoryText` — case, whitespace and
   trailing punctuation only. Stripping more would make genuinely different
   memories collide, and a collision silently drops the second one.
2. Shape-check every `supersedes` id and de-duplicate.
3. Scan **all three** category files of the layer (not just the target file)
   for an entry with the same normalized body, skipping superseded rows. The
   layer-wide scan exists because the extractor flip-flops between e.g.
   `LESSONS.md` and `FAILURES.md` for the same fact.
4. On a match, re-read the file **inside** the file lock (a consolidation may
   have rewritten it meanwhile), re-find the entry, and rewrite exactly one
   line: `seen + 1`, `last = now`, merged `supersedes`. The body bytes are never
   touched. Written via temp file + rename, so a crash cannot truncate the file.
5. Otherwise append a new row, then run `markSuperseded`.
6. Return `AppendOutcome { entry, deduped, file, superseded }`; the caller
   decides whether to refresh the index and what to report.

Two consequences worth knowing:

- **Re-asserting a superseded body revives the fact** as a new, live row. The
  dead row is not bumped, so the agent is never told "already stored" about a
  memory the index does not show.
- `seen`/`last` are omitted while `seen === 1`, so entries that were never
  re-confirmed keep their original bytes — no migration.

`memory_write` also rejects: a target outside the category files, keywords that
fail the rules (with the reasons), and truncated text. Every write path (tool,
extraction, handoff) awaits `syncIndexesNow()` before returning, so "saved"
always implies "the keyword is on disk".

## Staleness

A memory older than its file's review interval is not deleted, hidden, or
penalised in the index — it is labelled and demoted:

```
[20260111-aabb] project/FAILURES.md | 2026-01-11 10:00:00 | src: auto | tags: deploy |
  stale (263d, interval 12mo) — verify before relying on it
```

| File | Interval |
|---|---|
| `TOOLING.md` | 3 months |
| `USER.md`, `CONVENTIONS.md` | 6 months |
| `LESSONS.md`, `FAILURES.md`, `DECISIONS.md` | 12 months |

Derived from the entry's own timestamp (`last` when it was re-confirmed), so
re-writing or superseding a memory refreshes the clock, and no stored field or
migration is needed. A month is a fixed 30 days so the threshold cannot drift
with the calendar. Superseded entries are never "stale" (they are already dead,
and saying both would double-report them).

Every automatic deletion scheme in the survey hung the life of a memory on an
LLM-assigned importance score, which is why there is none here.

## Usage log

`<layer>/usage.json` records how often each keyword was **credited with a
successful find**: a search credits a keyword only when a returned memory
carries it *and* the query mentioned it (equal or substring either way), only on
page 1 (deeper pages re-read a hit that was already credited), and never on a
fallback or a `recent` listing (nothing was matched). Crediting every keyword of
every hit would just re-measure `count`; crediting keywords the query never
mentioned would credit noise.

Recalls are capped per keyword (10) so one noisy session cannot dominate, and
the file is capped at 5 000 keys. Writes are read-modify-write under the file
mutex with temp file + rename, so parallel searches cannot lose each other's
credits. Missing or corrupt reads as "no data"; errors are swallowed.

This is a sidecar — never parsed as an entry, never injected. Deleting it costs
ranking bias, nothing else.

## Near-duplicate detection

Exact duplicates are folded at write time, so what is left are near-duplicates:
the same fact recorded twice with slightly different wording, usually months
apart. They can only be resolved by a judgement call, so `src/duplicates.ts`
never merges anything — it produces candidates.

```
tokenJaccard = |A ∩ B| / |A ∪ B|   lowercased word tokens
                                   (Han runs compared as 2-grams: no word delimiters)
kwJaccard    = same, on canonical keyword keys
score        = 0.6 * tokenJaccard + 0.4 * kwJaccard      (1 for an identical body)
```

Two guards keep templated sentences out:

- when both bodies carry numbers and the number sets differ, the pair is not a
  candidate ("port 80" and "port 81" are different facts, not a rewording);
- a pair must be mostly the same text (`tokenJaccard ≥ 0.45`), or share at least
  two keywords *and* reach `tokenJaccard ≥ 0.25`. The final `score` must clear
  `0.5`.

Superseded rows are skipped, layers are compared separately, and the output is
deterministic (including order). A false candidate costs one line in a report; a
false merge loses a memory, so the bias is towards silence.

## Superseded requirements

The failure this layer exists for: a memory records a requirement, the user
changes that requirement in a later session, and the change is never written
down. Both memories stay live, and a later session reads whichever the index
ranks first — so it confidently follows the instruction the user already
abandoned. Nothing about that is a missing *delete*: the store is missing a
**conflict**, and deleting cannot detect one either.

Three places close it, in increasing order of intelligence:

1. **Write time.** The extraction prompt carries the live memories as a digest,
   including entry ids, and instructs the model to emit `SUPERSEDES: <id>` when
the user's newer instruction replaces one of them. `memory_write` accepts the
   same thing directly, and the injected contract states that the user's current
   instruction outranks any stored memory that covers the same thing.
2. **Deterministic detection** (`src/conflicts.ts`). Pairs of live entries in the
   same layer that *share a keyword* and whose bodies are similar enough to be
   about one subject, but whose content diverged, are conflict candidates. A
   diverged number is the strongest signal (port, version, timeout); rows that
   only look templated but share no keyword are ignored, and identical bodies
   are left to the duplicate layer. Like `duplicates.ts`, this module never
   decides anything — it only produces pairs, and it is attached as a
   `<possible-conflicts>` hint when the store is reviewed.
3. **Consolidation.** The `<possible-conflicts>` hint is passed to the rounds, and
   the prompt gained case 3: the newer memory is KEEP, the older one is DROP
   (i.e. superseded), and a pair that turns out to be two genuinely different
   facts is left alone. So a stale requirement is retired the next time the
   store is compacted, even if no turn ever noticed the change.

A `<possible-conflicts>` line reads:

```
- shared: dev-server | differing values: 3000, 8080
  older [20261001-aaaa] The dev server listens on port 3000.
  newer [20261002-bbbb] The dev server listens on port 8080.
```

The older id is the one superseded. Ranking inside a layer prefers pairs with
diverging numbers, then higher similarity; the output keeps input order so the
same store always yields the same prompt.

Retiring is deliberately weaker than deleting, and it is reversible by
re-asserting the old body (which revives the fact as a new live row):

| | Live row | Superseded row |
|---|---|---|
| In `MEMORY.md` | its keywords | keywords removed |
| In `memory_search` | normal rank | ranked last, labelled `superseded by [id]` |
| On disk | its body | its body, `superseded-by` added |

The injected contract also tells the model what to do when it reads two
memories that disagree: the newer one wins, and the older one should be
superseded rather than followed.

## Consolidation

Triggered when a layer has accumulated `CONSOLIDATE_EVERY` new memories
(`sinceLast ≥ threshold` **and** `sinceLast > attemptedAt[layer]`, the second
condition stopping a re-ask after a round that found nothing), checked after
every rebuild — including at session start, so a round that was due before exit
is caught up. Needs a session model; only the layers that are actually due are
sent, and only their files are rewritten.

1. The store is examined in **pages of 120 memories**, newest first. Every
   memory is seen exactly once per pass; a page with nothing to merge just moves
   on. Merges remove ids, so the store is re-read before the next page. A failed
   call ends the pass (whatever was already applied stays applied). At most 12
   rounds per invocation.
2. Each prompt also carries a `<likely-duplicates>` hint: the top deterministic
   near-duplicate pairs computed over the **whole** store, whose ids may sit
   outside the page. They are hints, never verdicts, and they close the paging
   blind spot below. A second hint block, `<possible-conflicts>`, names pairs
   that look like two versions of one fact (see
   [Superseded requirements](#superseded-requirements)); the newer id is kept
   and the older superseded. Hint ids are resolved against the whole pool, so a
   pair is actionable even when one side is off-page.
3. For each page the model receives id / layer / keywords / body and proposes
   `===MERGE===` (keep one, drop duplicates, optional merged text/keywords) and
   `===RENAME===` (keyword synonym) blocks.
4. Every proposal is validated against the entries that actually exist: unknown
   ids ignored, merges never span layers, self-merges dropped, keywords
   re-checked against the 1–3 / ≤8 rule, and a memory never ends up without a
   keyword.
5. The plan is applied deterministically (rewriting only the files it touches,
   `.bak` kept) and the watermark is reset.

Failure is safe: if the model proposes nothing usable, the store is untouched
and the table is still rebuilt deterministically.

Pages are time-ordered, so two duplicates that land in *different* pages cannot
be merged in the same pass unless the `<likely-duplicates>` hint names them —
which is exactly the case it is computed for.

## Retrieval

| Mode | Behavior |
|---|---|
| `keyword` (default) | Query split into tokens (identifiers with `.`/`/`-` stay whole, stopwords dropped); a hit needs any one token; ranked by coverage → keyword hits → recency. Falls back to the newest entries when nothing matched. |
| `tag` | Exact canonical-keyword lookup — the mode for a keyword copied from the index. |
| `recent` | Newest entries first. |
| `all` | Same scorer as `keyword` with a stronger recency term. |
| `id` | Exact entry id. |

Scoring: `coverage * 10 + tagExact * 4 + tagPartial * 2 + textHits * 0.5 +
recencyBoost * recency`, where `recency = max(0, 1.5 - ageDays / 60)` and the
boost is 3 for `all`, 1 otherwise. Content match dominates; time only breaks
ties. An id-shaped query is treated as an id lookup even in `keyword` mode, and
an empty/stopword-only query lists the newest entries.

Results are paginated (10 per page) and always include entry metadata. Ranking
is per mode, then demoted in two stable groups: **stale** entries below fresh
ones (`stale` label included), **superseded** entries last of all
(`superseded by [id]` label included). Ranks are memoised per entry, because the
comparator runs thousands of times and staleness parses a timestamp.

No vector search — the model does the query expansion (synonyms, translations).

## Commands

| Command | Effect |
|---|---|
| `/memory` or `/memory show` | Print both layers' keyword tables, memory/keyword counts, the `sinceLast` watermark, the consolidation marker, the file paths, and the **health line**, **merge candidates** and **possible superseded requirements** with the exact command to act on them. The report is added to the transcript as a custom message (so the agent sees the current index too). |
| `/memory compact project` | Merge duplicate memories in **this project's layer only**, then reset that layer's watermark. Needs a session model; failure leaves the store untouched. |
| `/memory compact user` | Same, for the **user (global) layer only**. |
| `/memory rebuild project` | **Re-derive this project's keywords with the session model**, write them back into the entry metadata (`.bak` kept), then regenerate that layer's `MEMORY.md`. Batched 12 entries per call; without a session model it only repairs malformed tags deterministically. |
| `/memory rebuild user` | Same, for the **user (global) layer only**. |
| `/memory help` | Print the usage list. |

`compact` and `rebuild` **require** an explicit layer. Without one they print
usage instead of acting — doing both silently would mean every project rewrites
the shared user store, so N projects would re-process the same global memories N
times (and churn `MEMORY.md.bak` N times). `user`/`global`/`g` all mean the
global layer; `project`/`proj`/`p` mean the current project. A misspelled layer
is an error, never a silent fallback, and a surplus argument is a typo rather
than something to ignore.

Layer scoping is enforced below the command layer too: `runConsolidation` only
sends the scoped layers' entries to the model and only rewrites their files, and
`materializeAll({ layers })` only writes those `MEMORY.md` files. The automatic
background round uses the same path and only consolidates layers that reached the
threshold.

## Health report

`/memory` ends each layer with the signals that need a human/model decision. None
of them is automatic:

```
  health: 2 superseded (kept on disk, out of the index) · 6/24 keywords never recalled · 3 stale — re-verify (DECISIONS.md 2, CONVENTIONS.md 1)
  merge candidates (2) — /memory compact project:
    · [20261001-aaaa] ↔ [20261020-bbbb] 78% shared: deploy, rsync
      "Deploy goes through rsync to the staging host." / "Deploy uses rsync to reach staging."
  possible superseded requirements (1) — older vs newer; if the newer one is current, write it again with supersedes:[older id], or /memory compact project to let the pass decide:
    - shared: dev-server | differing values: 3000, 8080 | confidence 88%
      older [20261001-aaaa] (2026-10-01 10:00:00, project/DECISIONS.md): "The dev server listens on port 3000."
      newer [20261002-bbbb] (2026-10-02 10:00:00, project/DECISIONS.md): "The dev server listens on port 8080."
```

A non-zero counter is an instruction, not a warning: superseded rows can be
merged away by a consolidation round, never-recalled keywords are what
`/memory rebuild` re-derives, and stale entries are re-confirmed by writing them
again or replaced with `supersedes`.

The last block lists the pairs `src/conflicts.ts` judged to be two versions of
one fact. They are deliberately NOT in the merge list: they are not duplicates,
so a merge would keep whichever body it saw fit and still leave the obsolete
value reachable. The two rows are printed oldest first with the differing values
spelled out, because the decision is "which of these two numbers is current" —
that is the exact decision a reader cannot make from the keyword table.

"Never recalled" is only shown once the layer has accumulated at least 5 recalls
in total — on a fresh install every keyword sits at zero, which would read as a
problem when it is just an empty log.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PI_MEMORY_AUTO_REVIEW_TURNS` | `10` | Conversation turns between automatic extraction reviews (clamped 1–1000) |
| `PI_MEMORY_AUTO_CONSOLIDATE_EVERY` | `20` | New memories per layer that trigger a consolidation round (clamped 2–500) |
| `PI_MEMORY_AUTO_DIR` | `~/.pi/agent/memory-auto` | Global memory directory |
| `PI_MEMORY_AUTO_INDEX_BUDGET` | `3000` | Characters per layer for the injected keyword table (clamped 200–6000) |
| `PI_MEMORY_AUTO_LLM_MAX_TOKENS` | `10000` | maxTokens for background LLM calls (extraction / handoff / consolidation); large enough that a `stopReason: "length"` response is rejected instead of stored |
| `PI_MEMORY_AUTO_REVIEW_MONTHS` | `0` | Staleness interval override in months for every file. `0` = the per-file defaults (3/6/12), clamped to ≥ 0 so a typo cannot silently disable the feature |

## Development

```sh
bun install
npm test           # node --experimental-strip-types --test test/*.test.ts
npm run typecheck  # tsc --noEmit
npm run index:rebuild -- --print   # regenerate MEMORY.md for cwd + preview the injection
```

The extension runs on pi's jiti loader — no build step needed. Runtime text that
reaches a prompt or a tool description is English; Chinese appears only in design
docs.

## Changelog (detailed)

### 0.9.0

- **A review is no longer re-triggered by the same turn.** The trigger used to be
  a turn counter plus a bare `reviewInFlight` flag, so `turn_end` firing more
  than once for one turn index (long tool loops, retries) started another review
  as soon as the previous one finished — each appending up to three more
  memories worded just differently enough to miss the exact-body dedup. The
  decision is now stateful per session (`src/review-gate.ts`): a turn index is
  reviewed at most once, and `lastTurn` is recorded *before* the async work
  starts so a duplicate dispatch cannot slip through the gap.
- **The transcript is incremental.** Each review serializes only the messages
  after a per-session cursor (`newMessages`) instead of the whole conversation
  again, so a late review sees new material instead of re-extracting from what
  earlier reviews already covered. A compaction handoff advances the same cursor,
  and the quit flush honours it, so the pre-compaction turns are not extracted
  twice. A cursor past the end (fork, shrunk branch) reads as "nothing new"
  rather than replaying the entire history. The cursor moves only when the
  extraction actually succeeded (`ok`), so a provider failure defers the tail to
  the next round instead of silently dropping it.
- **Stale requirements are detected and retired.** `src/conflicts.ts` finds live
  pairs that share a keyword but disagree, the extractor prompt gained
  `SUPERSEDES:`, consolidation gained case 3 (newer kept, older superseded), and
  the injected contract now tells the model that a memory is a record of what was
  true when written, so the user's current instruction wins and the outdated
  entry should be superseded in the same turn.

### 0.8.0

- **Write-time idempotency.** Writing a body that already exists in the same
  layer no longer appends a second row. The stored entry's metadata gains
  `seen: N | last: <time>` and is rewritten in place; `memory_write` says so
  instead of pretending to save. The check spans the layer's files, so the
  extractor flip-flopping between `LESSONS.md` and `FAILURES.md` for the same
  fact is caught too. `seen`/`last` are omitted while `seen === 1`, so untouched
  entries keep their original bytes.
- **Corrections instead of contradictions (`supersedes`).** `memory_write` takes
  an optional `supersedes: [id]` (the extractor emits a `SUPERSEDES:` line, and
  the digest it reviews now carries entry ids). The replaced entry keeps its row
  and its body, gains `superseded-by`, stops contributing keywords to
  `MEMORY.md`, and ranks below every live memory in search. Nothing is deleted —
  this is the only form of forgetting added, because "does this memory have a
  replacement?" is a judgement a deterministic system can make.
- **Staleness instead of TTL.** A memory past its file's review interval
  (TOOLING 3 months, USER/CONVENTIONS 6, LESSONS/FAILURES/DECISIONS 12) is
  labelled `stale (Nd, interval Nmo) — verify before relying on it` and ranks
  below fresh memories. It is derived from the entry's own timestamp (`last` when
  re-confirmed), so there is no new field, no migration, and re-confirming or
  superseding refreshes it. No decay, no eviction, no deletion.
- **Keyword usage log.** Every successful `memory_search` credits the keywords
  that actually found something (`usage.json` sidecar, per layer, never injected
  and never an entry). The index now ranks by shared count *plus* recalls, so the
  fixed character budget keeps the keywords that have proven useful instead of
  the ones that merely look popular. A missing or corrupt log reads as "no data".
- **`/memory` reports health, and consolidation gets targets.** The report lists
  near-duplicate pairs (`/memory compact project` acts on them), superseded rows,
  keywords that were never recalled, and stale entries. Near-duplicate detection
  is deterministic (token + keyword Jaccard, with numbers treated as significant
  so "port 80" and "port 81" never pair up) and never merges anything. The same
  pairs are attached to consolidation prompts as `<likely-duplicates>` hints,
  which also closes the paging blind spot where two duplicates recorded months
  apart never share a page.
- **The injected table degrades in stages.** When the budget runs out, the
  remaining keywords are packed onto continuation lines without their `(count)`
  suffix (roughly doubling how many topics fit), and only then collapsed into
  `(+N more — memory_search mode:"keyword")`. The old hint pointed at `recent`,
  the weakest retrieval mode.

### 0.7.1

- **`/memory compact` (and the automatic round) now examines the whole store,
  not just the newest 120 memories.** It used to send one prompt capped at 120
  and silently leave everything older unexamined — forever, since every later
  round again took the newest 120. A duplicate between a fresh memory and an old
  one, the most common case, could therefore never be found. The pass now pages
  through the store (120 per call, newest first), re-reading the entries after
  each page that changed them, and stops early only when the provider fails.
  `ConsolidationResult.rounds` reports how many calls it took.

## License

MIT
