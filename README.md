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

## Design

See `docs/design-draft.md` (design, Chinese) and `docs/implementation-plan.md`. Research notes on prior art (`pi-memory`, `pi-hermes-memory`, pmem) in `docs/research-existing-memory-extensions.md`.

## License

MIT
