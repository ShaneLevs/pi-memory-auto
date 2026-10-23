# pi-memory-auto

Memory system extension for the [pi coding agent](https://github.com/earendil-works/pi).

Every memory is stored as **a body plus 1–3 keywords**. The keywords go into a per-layer `MEMORY.md` table (unique, max 200), which is injected into the system prompt; the bodies stay in category files. The agent matches a keyword against the current task, searches with it, and reads the body.

## Changelog

### 0.8.0

Six changes, all of them "do the cheap deterministic thing instead of asking a model":

- **Write-time idempotency.** Writing a body that already exists in the same layer no longer appends a second row. The stored entry's metadata gains `seen: N | last: <time>` and is rewritten in place; `memory_write` says so instead of pretending to save. The check spans the layer's files, so the extractor flip-flopping between `LESSONS.md` and `FAILURES.md` for the same fact is caught too. `seen`/`last` are omitted while `seen === 1`, so untouched entries keep their original bytes.
- **Corrections instead of contradictions (`supersedes`).** `memory_write` takes an optional `supersedes: [id]` (the extractor emits a `SUPERSEDES:` line, and the digest it reviews now carries entry ids). The replaced entry keeps its row and its body, gains `superseded-by`, stops contributing keywords to `MEMORY.md`, and ranks below every live memory in search. Nothing is deleted — this is the only form of forgetting added, because "does this memory have a replacement?" is a judgement a deterministic system can make.
- **Staleness instead of TTL.** A memory past its file's review interval (TOOLING 3 months, USER/CONVENTIONS 6, LESSONS/FAILURES/DECISIONS 12) is labelled `stale (Nd, interval Nmo) — verify before relying on it` and ranks below fresh memories. It is derived from the entry's own timestamp (`last` when re-confirmed), so there is no new field, no migration, and re-confirming or superseding refreshes it. No decay, no eviction, no deletion.
- **Keyword usage log.** Every successful `memory_search` credits the keywords that actually found something (`usage.json` sidecar, per layer, never injected and never an entry). The index now ranks by shared count *plus* recalls, so the fixed character budget keeps the keywords that have proven useful instead of the ones that merely look popular. A missing or corrupt log reads as "no data".
- **`/memory` reports health, and consolidation gets targets.** The report lists near-duplicate pairs (`/memory compact project` acts on them), superseded rows, keywords that were never recalled, and stale entries. Near-duplicate detection is deterministic (token + keyword Jaccard, with numbers treated as significant so "port 80" and "port 81" never pair up) and never merges anything. The same pairs are attached to consolidation prompts as `<likely-duplicates>` hints, which also closes the paging blind spot where two duplicates recorded months apart never share a page.
- **The injected table degrades in stages.** When the budget runs out, the remaining keywords are packed onto continuation lines without their `(count)` suffix (roughly doubling how many topics fit), and only then collapsed into `(+N more — memory_search mode:"keyword")`. The old hint pointed at `recent`, the weakest retrieval mode.

### 0.7.1

- **`/memory compact` (and the automatic round) now examines the whole store, not just the newest 120 memories.** It used to send one prompt capped at 120 and silently leave everything older unexamined — forever, since every later round again took the newest 120. A duplicate between a fresh memory and an old one, the most common case, could therefore never be found. The pass now pages through the store (120 per call, newest first), re-reading the entries after each page that changed them, and stops early only when the provider fails. `ConsolidationResult.rounds` reports how many calls it took.

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

## Install

```sh
pi install npm:@shanelevs/pi-memory-auto
```

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PI_MEMORY_AUTO_REVIEW_TURNS` | `10` | Conversation turns between automatic extraction reviews |
| `PI_MEMORY_AUTO_CONSOLIDATE_EVERY` | `20` | New memories per layer that trigger a consolidation round |
| `PI_MEMORY_AUTO_DIR` | `~/.pi/agent/memory-auto` | Global memory directory |
| `PI_MEMORY_AUTO_INDEX_BUDGET` | `3000` | Characters per layer for the injected keyword table |
| `PI_MEMORY_AUTO_LLM_MAX_TOKENS` | `10000` | maxTokens for background LLM calls (extraction / handoff / consolidation) |
| `PI_MEMORY_AUTO_REVIEW_MONTHS` | `0` | Staleness interval override in months for every file. `0` = the per-file defaults (3/6/12), never negative so a typo cannot silently disable the feature. |

## Commands

| Command | Effect |
|---|---|
| `/memory` or `/memory show` | Print both layers' keyword tables, memory/keyword counts, the `sinceLast` watermark, the consolidation marker, the file paths, and the **health line** (superseded rows, never-recalled keywords, stale entries due for review) plus **merge candidates** with the exact command to act on them. The report is added to the transcript as a custom message (so the agent sees the current index too). |
| `/memory compact project` | Merge duplicate memories in **this project's layer only**, then reset that layer's watermark. Needs a session model; failure leaves the store untouched. |
| `/memory compact user` | Same, for the **user (global) layer only**. |
| `/memory rebuild project` | **Re-derive this project's keywords with the session model**, write them back into the entry metadata (`.bak` kept), then regenerate that layer's `MEMORY.md`. Batched 12 entries per call; without a session model it only repairs malformed tags deterministically. |
| `/memory rebuild user` | Same, for the **user (global) layer only**. |
| `/memory help` | Print the usage list. |

`compact` and `rebuild` **require** an explicit layer. Without one they print usage instead of acting — doing both silently would mean every project rewrites the shared user store, so N projects would re-process the same global memories N times (and churn `MEMORY.md.bak` N times). `user`/`global`/`g` all mean the global layer; `project`/`proj`/`p` mean the current project. A misspelled layer is an error, never a silent fallback.

Layer scoping is enforced below the command layer too: `runConsolidation` only sends the scoped layers' entries to the model and only rewrites their files, and `materializeAll({ layers })` only writes those `MEMORY.md` files. The automatic background round uses the same path and only consolidates layers that reached the threshold.

## How it works

### Storage layout

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

`usage.json` is the only file that churns on every search and is machine-specific — if the project layer is committed, add `usage.json` (and `*.bak`) to `.gitignore`. It is disposable: deleting it only loses ranking bias, never a memory.

`MEMORY.md`:

```markdown
<!-- AUTO-GENERATED keyword table for this layer — one line per unique keyword. … -->
<!-- stats: entries=9 keywords=17 sinceLast=3 lastConsolidated=2026-10-23T10:00:00.000Z -->
#deploy (3)
#pnpm
#serialize-conversation (2)
```

The `(n)` is **how many memories use that keyword** — not an entry number. Ranking is `count + recalls` (recalls capped at 4, see the usage log below), then alphabetical: a keyword that several memories share *and* that has actually found something sorts first, so the fixed budget keeps the useful part of the table. `sinceLast` is the consolidation watermark: memories added since the last round.

### Entry format

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
- The body must be complete: text with an unclosed code span, unbalanced `(`/`[`/`{`, or a trailing opening delimiter is rejected as truncated (`src/integrity.ts`).

### Keyword rules

| Rule | Where it is enforced |
|---|---|
| 1–3 per memory | `sanitizeKeywords` on `memory_write` (rejects), `parseReviewResponse` / `runHandoff` (derive or trim), `coerceKeywords` on read + `/memory rebuild` |
| ≤ 8 Chinese characters or 8 english words | `keywordIssue`; the extractor and rekey prompts state it too |
| Unique per layer | canonical key = lowercase with separators removed (`src/keywords.ts`) |
| ≤ 200 per layer | `collectKeywords` cap; the least-used keywords are dropped from the table (their memories stay searchable by text) |

Stored tags are repaired on read (`coerceKeywords`): legacy space-separated `#a #b #c` blobs are split back into individual keywords, over-long or invalid ones are dropped, and an entry left with nothing gets a keyword derived from its body. The read path never writes — `/memory rebuild` is what persists the repair. |

### Injection

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

- Byte-stable within a session (snapshot), so the prompt prefix cache stays warm; re-rendered after compaction.
- **Rendered from the category files at injection time, not read from `MEMORY.md`.** The two always contain the same keyword lines (the file is generated from the same entries), but rendering live means a stale, deleted or hand-damaged `MEMORY.md` can never affect what the model sees.
- Nothing is injected when nothing is stored.
- Truncation is explicit and staged: counted lines first, then the remaining keywords packed without counts, and only then `(+N more — memory_search mode:"keyword")`.

### Write rules

- `memory_write` targets category files only; keywords 1–3, required, validated. Writing `MEMORY.md` is rejected.
- **Idempotent by body.** A body that already exists in the same layer does not get a second row: the stored entry's `seen`/`last` are bumped and the tool reports "already stored" (`src/entry.ts:normalizeMemoryText` — case, whitespace and trailing punctuation are ignored, nothing more, so genuinely different memories never collide).
- **Corrections use `supersedes`, deletions do not exist.** Passing `supersedes: [id]` marks the old row `superseded-by`: it leaves the index, keeps its body, and ranks below every live memory. The extractor does the same through a `SUPERSEDES:` line, and its "existing memories" digest carries ids so it can name them.
- After any write (tool, extraction, handoff) the keyword table is rebuilt, so the new keyword is visible to the next session.
- Auto-extraction runs every `PI_MEMORY_AUTO_REVIEW_TURNS` turns, reviews the serialized conversation (tool calls and results included), and appends at most 3 entries.

### Staleness (review, not expiry)

A memory older than its file's review interval is not deleted, hidden, or penalised in the index — it is labelled and demoted:

```
[20260111-aabb] project/FAILURES.md | 2026-01-11 10:00:00 | src: auto | tags: deploy |
  stale (263d, interval 12mo) — verify before relying on it
```

| File | Interval |
|---|---|
| `TOOLING.md` | 3 months |
| `USER.md`, `CONVENTIONS.md` | 6 months |
| `LESSONS.md`, `FAILURES.md`, `DECISIONS.md` | 12 months |

Derived from the entry's own timestamp (`last` when it was re-confirmed), so re-writing or superseding a memory refreshes the clock, and no stored field or migration is needed. Every automatic deletion scheme in the survey hung the life of a memory on an LLM-assigned importance score, which is why there is none here.

### Usage log

`<layer>/usage.json` records how often each keyword was **credited with a successful find**: a search credits a keyword only when a returned memory carries it *and* the query mentioned it, only on page 1, and never on a fallback or a `recent` listing. Recalls are capped per keyword so one noisy session cannot dominate. The file is a sidecar — it is never parsed as an entry and never injected.

Deliberately not a re-render trigger: a search must not change the system prompt mid-session, or the prefix cache dies on every search. Usage shapes the **next** session's table.

### Consolidation

Triggered when a layer has accumulated `PI_MEMORY_AUTO_CONSOLIDATE_EVERY` new memories (checked after every rebuild, including at session start, so a round that was due before exit is caught up).

1. The store is examined in **pages of 120 memories**, newest first. Every memory is seen exactly once per pass; a page with nothing to merge just moves on to the next page. Merges remove ids, so the store is re-read before the next page. A failed call ends the pass (whatever was already applied stays applied).
2. Each prompt also carries a `<likely-duplicates>` hint: the top deterministic near-duplicate pairs computed over the **whole** store, whose ids may sit outside the page. They are hints, never verdicts, and they close the paging blind spot below.
3. For each page the model receives id / layer / keywords / body and proposes `===MERGE===` (keep one, drop duplicates, optional merged text/keywords) and `===RENAME===` (keyword synonym) blocks.
4. Every proposal is validated against the entries that actually exist: unknown ids ignored, merges never span layers, self-merges dropped, keywords re-checked against the 1–3 / ≤8 rule, and a memory never ends up without a keyword.
5. The plan is applied deterministically (rewriting only the files it touches, `.bak` kept) and the watermark is reset.

Failure is safe: if the model proposes nothing usable, the store is untouched and the table is still rebuilt deterministically.

Pages are time-ordered, so two duplicates that land in *different* pages cannot be merged in the same pass unless the `<likely-duplicates>` hint names them — which is exactly the case it is computed for.

### Retrieval

| Mode | Behavior |
|---|---|
| `keyword` (default) | Query split into tokens (identifiers with `.`/`/`/`-` stay whole, stopwords dropped); a hit needs any one token; ranked by coverage → keyword hits → recency. Falls back to the newest entries when nothing matched. |
| `tag` | Exact canonical-keyword lookup — the mode for a keyword copied from the index. |
| `recent` | Newest entries first. |
| `all` | Same scorer as `keyword` with a stronger recency term. |
| `id` | Exact entry id. |

Results are paginated (10 per page) and always include entry metadata. Ranking is per mode, then demoted in two stable groups: **stale** entries below fresh ones (`stale` label included), **superseded** entries last of all (`superseded by [id]` label included). No vector search — the model does the query expansion (synonyms, translations).

## Health report

`/memory` ends each layer with the signals that need a human/model decision. None of them is automatic:

```
  health: 2 superseded (kept on disk, out of the index) · 6/24 keywords never recalled · 3 stale — re-verify (DECISIONS.md 2, CONVENTIONS.md 1)
  merge candidates (2) — /memory compact project:
    · [20261001-aaaa] ↔ [20261020-bbbb] 78% shared: deploy, rsync
      "Deploy goes through rsync to the staging host." / "Deploy uses rsync to reach staging."
```

Near-duplicate detection is deterministic and explainable: token Jaccard (Han text compared as 2-grams) blended 0.6/0.4 with keyword Jaccard, rejected outright when the two bodies carry different numbers ("port 80" ≠ "port 81"), and skipped for superseded rows. A false candidate costs one line in a report; a false merge loses a memory, so the bias is towards silence.

## Development

```sh
bun install
npm test           # node --experimental-strip-types --test test/*.test.ts
npm run typecheck  # tsc --noEmit
npm run index:rebuild -- --print   # regenerate MEMORY.md for cwd + preview the injection
```

The extension runs on pi's jiti loader — no build step needed.

## License

MIT
