# pi-memory-auto

Memory system extension for the [pi coding agent](https://github.com/earendil-works/pi).

Every memory is stored as **a body plus 1–3 keywords**. The keywords go into a per-layer `MEMORY.md` table (unique, max 200), which is injected into the system prompt; the bodies stay in category files. The agent matches a keyword against the current task, searches with it, and reads the body.

## Changelog

### 0.6.0

- New `/memory` command: `show` (keyword index + watermark), `compact` (merge duplicates now, regardless of the threshold), `rebuild` (regenerate `MEMORY.md`). Argument completion included.

### 0.5.0

- **Keyword contract enforced.** Every memory carries 1–3 keywords; each is at most 8 Chinese characters or 8 english words. `memory_write` rejects a write with an actionable error instead of storing an unusable keyword; the background extractor derives a keyword when the model omits one, so no memory is ever keyword-less.
- **`MEMORY.md` is a unique keyword table.** One line per keyword (`#deploy (3)`), no bodies, no gists. Keywords are unique per layer by a separator-insensitive key, so `serializeConversation` / `serialize-conversation` / `Serialize Conversation` collapse into one line. Caps at 200 keywords per layer (`PI_MEMORY_AUTO_INDEX_BUDGET` bounds the injected bytes).
- **Consolidation is triggered by accumulated memories, not by output size.** Each `MEMORY.md` carries `<!-- stats: entries=… keywords=… sinceLast=… -->`; when `sinceLast` reaches `PI_MEMORY_AUTO_CONSOLIDATE_EVERY` (default 20), a background round asks the model for merge groups and keyword renames, validates every proposal against the entries that exist, applies it deterministically, and keeps a `.bak` of each rewritten file. The old trigger (a MEMORY.md that had to reach 1000 chars — which only the consolidator could write) could never fire.
- `memory_search mode:"tag"` is now an exact canonical-keyword lookup: a keyword copied from the index always resolves.
- `npm run index:rebuild` prints per-layer stats (memories / keywords / sinceLast).

### 0.4.0

- Injection became a deterministic index instead of an LLM-consolidated digest: no `MEMORY.md` had ever been created, so every session started with an empty memory block.
- Search became token-based instead of compiling the whole query into one regex (multi-word and natural-language queries used to return nothing).
- New `id` search mode, id auto-detection in keyword mode, newest-entries fallback instead of an empty result.

### 0.3.0

- Review/handoff transcripts use pi's `serializeConversation` (tool calls + truncated tool results included)
- Review prompt carries an "Existing memories" digest for dedup, plus an anti-hallucination guard
- Transcript capped at 60k chars, keeping the most recent tail

### 0.2.0

- Truncated memories are rejected instead of stored (stopReason `length`)
- Background LLM maxTokens raised to 10000, configurable

## Model

```
memory_write(body, keywords[1..3])
      │
      ├─► body      → <layer>/<FILE>.md          (append-only, source of truth)
      └─► keywords  → <layer>/MEMORY.md          (derived table, injected)

every N new memories → consolidation (merge duplicates, rename keywords) → rebuild
```

- A keyword is **unique per layer**, but many memories may share it and one memory has 1–3.
- Layer is global (`~/.pi/agent/memory-auto/`) or project (`<project>/.pi/agent/memory-auto/`); read isolation is by location.
- Everything in `MEMORY.md` is derived from the entries — it can be deleted at any time and is rebuilt on the next write or session start.

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

## Commands

| Command | Effect |
|---|---|
| `/memory` or `/memory show` | Print both layers' keyword tables, memory/keyword counts, the `sinceLast` watermark, the consolidation marker, and the file paths. The report is added to the transcript as a custom message (so the agent sees the current index too). |
| `/memory compact` | Run a consolidation round immediately — merge duplicate memories and reconcile keywords — then reset the watermark. Needs a session model; failure leaves the store untouched. |
| `/memory rebuild` | Regenerate `MEMORY.md` from the category files (recovers from hand edits or a format migration) and report how many memories/keywords each layer now has. |

## How it works

### Storage layout

```
~/.pi/agent/memory-auto/          # global layer
  MEMORY.md                       # generated keyword table (unique keywords)
  USER.md  TOOLING.md  LESSONS.md # entry bodies

<project>/.pi/agent/memory-auto/  # project layer (commit it — team-shareable)
  MEMORY.md                       # generated keyword table
  CONVENTIONS.md  DECISIONS.md  FAILURES.md
```

`MEMORY.md`:

```markdown
<!-- AUTO-GENERATED keyword table for this layer — one line per unique keyword. … -->
<!-- stats: entries=9 keywords=17 sinceLast=3 lastConsolidated=2026-10-23T10:00:00.000Z -->
#deploy (3)
#pnpm
#serialize-conversation (2)
```

The `(n)` is how many memories share the keyword. `sinceLast` is the consolidation watermark: memories added since the last round.

### Entry format

```markdown
<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: myproject | src: user | tags: deploy,rsync,备份 -->
Deploy with `rsync --delete`; back up the previous release first.
```

- `tags` are the keywords (1–3). They are the retrieval surface.
- Metadata comments are stripped from the injected index and always kept in search results.

### Keyword rules

| Rule | Where it is enforced |
|---|---|
| 1–3 per memory | `sanitizeKeywords` on `memory_write` (rejects), `parseReviewResponse` (derives one if missing) |
| ≤ 8 Chinese characters or 8 english words | `keywordIssue`; the extractor prompt states it too |
| Unique per layer | canonical key = lowercase with separators removed (`src/keywords.ts`) |
| ≤ 200 per layer | `collectKeywords` cap; the least-used keywords are dropped from the table (their memories stay searchable by text) |

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
- Nothing is injected when nothing is stored.
- Truncation is explicit: `(+N more keywords — memory_search mode:"recent")`.

### Write rules

- `memory_write` targets category files only; keywords 1–3, required, validated. Writing `MEMORY.md` is rejected.
- After any write (tool, extraction, handoff) the keyword table is rebuilt, so the new keyword is visible to the next session.
- Auto-extraction runs every `PI_MEMORY_AUTO_REVIEW_TURNS` turns, reviews the serialized conversation (tool calls and results included), and appends at most 3 entries.

### Consolidation

Triggered when a layer has accumulated `PI_MEMORY_AUTO_CONSOLIDATE_EVERY` new memories (checked after every rebuild, including at session start, so a round that was due before exit is caught up).

1. The model receives id / layer / keywords / body for the stored memories and proposes `===MERGE===` (keep one, drop duplicates, optional merged text/keywords) and `===RENAME===` (keyword synonym) blocks.
2. Every proposal is validated against the entries that actually exist: unknown ids ignored, merges never span layers, self-merges dropped, keywords re-checked against the 1–3 / ≤8 rule, and a memory never ends up without a keyword.
3. The plan is applied deterministically (rewriting only the files it touches, `.bak` kept) and the watermark is reset.

Failure is safe: if the model proposes nothing usable, the store is untouched and the table is still rebuilt deterministically.

### Retrieval

| Mode | Behavior |
|---|---|
| `keyword` (default) | Query split into tokens (identifiers with `.`/`/`/`-` stay whole, stopwords dropped); a hit needs any one token; ranked by coverage → keyword hits → recency. Falls back to the newest entries when nothing matched. |
| `tag` | Exact canonical-keyword lookup — the mode for a keyword copied from the index. |
| `recent` | Newest entries first. |
| `all` | Same scorer as `keyword` with a stronger recency term. |
| `id` | Exact entry id. |

Results are paginated (10 per page) and always include entry metadata. No vector search — the model does the query expansion (synonyms, translations).

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
