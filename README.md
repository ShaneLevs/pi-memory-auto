# pi-memory-auto

Memory system extension for the [pi coding agent](https://github.com/earendil-works/pi).

## Features

- **Two-layer memory**: global (`~/.pi/agent/memory-auto/`) + per-project (`<project>/.pi/agent/memory-auto/`), plain markdown, git-friendly
- **Main + category files**: each layer has a `MEMORY.md` main file (the only injection candidate) plus category files (USER/TOOLING/LESSONS, CONVENTIONS/DECISIONS/FAILURES)
- **Entry-based storage**: every memory is one entry with metadata (id, time, project, layer, source, tags) in an HTML comment
- **Snapshot injection**: rendered main memories (≤1000 chars each) injected only on session start and after compaction — byte-stable in between to preserve prompt prefix cache
- **Search-only access**: the agent never reads whole files; `memory_search` supports `keyword` / `tag` / `recent` / `all` modes with pagination
- **Guarded writes**: `memory_write` appends to category files only; the main file is maintained exclusively by the background consolidator (triggered when cleaned content ≥1000 chars, uses the session model, keeps a `.bak`)
- **Turn-based auto-extraction**: every N turns (default 10, `PI_MEMORY_AUTO_REVIEW_TURNS`) a background review extracts durable memories into category files; conservative by default ("nothing to save" is valid)
- **Compaction handoff**: before context compaction, a handoff entry is appended so important state survives

## Install

Copy/symlink this directory into `~/.pi/agent/extensions/pi-memory-auto/` (or `<project>/.pi/extensions/`).

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PI_MEMORY_AUTO_REVIEW_TURNS` | `10` | Conversation turns between automatic extraction reviews |
| `PI_MEMORY_AUTO_DIR` | `~/.pi/agent/memory-auto` | Global memory directory |

## How it works

### Storage layout

```
~/.pi/agent/memory-auto/          # global layer
  MEMORY.md                       # main file — the only injected content
  USER.md  TOOLING.md  LESSONS.md # category files (never injected, no size limit)

<project>/.pi/agent/memory-auto/  # project layer (commit it — team-shareable)
  MEMORY.md
  CONVENTIONS.md  DECISIONS.md  FAILURES.md
```

- Category files are append-only and unbounded; only the main files are injected.
- Read isolation is enforced by location: a project session only ever sees the current project's memories plus the global layer.

### Entry format

Every memory is one entry with a metadata comment:

```markdown
<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: myproject | src: user | tags: auth,db -->
Adopt URL-prefix API versioning to avoid CDN cache invalidation.
```

- `mid` — unique entry id; `t` — local write time; `p` — project name (`-` for global); `src` — `user` (explicit) or `auto` (extraction); `tags` — comma-separated retrieval tags.
- Metadata comments are stripped before injection; they are always included in search results.

### Injection

Rendered main memories (global + project, ≤1000 chars each after stripping metadata) are injected into the system prompt **only on session start and after compaction**. Between those boundaries the injected bytes are reused verbatim, so the provider's prompt prefix cache is preserved. Mid-session file changes (including manual edits and background consolidation) take effect at the next injection boundary, never mid-conversation.

### Write rules

- `memory_write` targets category files only (`layer` × `file` chosen by the model using a built-in classification rubric: admission → global/project layer → specific file). Writing the main file is rejected.
- The main file is maintained exclusively by the background consolidator, which runs when a main file's cleaned content reaches 1000 chars: it merges duplicates, resolves contradictions (newer wins), distills important category entries, and keeps the previous version as `MEMORY.md.bak`. Consolidation uses the current session model and never blocks the conversation.
- Auto-extraction runs every `PI_MEMORY_AUTO_REVIEW_TURNS` turns, reviews the recent conversation with the session model, and appends at most 3 entries to category files. It is conservative by default — trivial exchanges produce nothing.

### Retrieval

The agent has no whole-file read tool. `memory_search` modes:

| Mode | Behavior |
|---|---|
| `keyword` (default) | Regex/substring match on entry text and tags (invalid regex falls back to substring) |
| `tag` | Entries whose tags include any comma-separated query tag |
| `recent` | Newest entries first, regardless of query |
| `all` | Fused: keyword + tag + recency scoring |

Results are paginated (10 per page) and always include entry metadata. No vector/semantic search — retrieval is deterministic.

## Development

```sh
bun install        # or npm install
npm test           # node --experimental-strip-types --test test/*.test.ts
npm run typecheck  # tsc --noEmit
```

The extension runs on pi's jiti loader — no build step needed. Internal notes live in `docs/` (not published).

## License

MIT
