# pi-memory-auto

A memory for your pi coding agent. It remembers what you told it last week, so
you do not have to say it again.

[English](README.md) · [中文](README.zh-CN.md) · [Technical documentation](TECHNICAL.md)

## The idea in one sentence

Think of a **notebook plus a stack of index cards**. You never read the whole
notebook — you glance at the cards, see a word that matches what you are doing,
and ask for that page.

That is exactly how this works:

- every memory is **one short paragraph plus 1–3 keywords**;
- the keywords are all that the agent sees at the start of a session — never the
  paragraphs;
- when a keyword matches the current work, the agent fetches the paragraph
  itself, without being told.

## What a memory looks like

> Deploy with rsync and back up the previous release first.
> `#deploy` `#rsync`

The keywords are the hooks that let a future session find it again. That is why
they matter more than the wording: pick the words you would search for later,
in both languages if you switch between them.

## What you see when a session starts

A small list of words, nothing else:

```
you (global)              this project
#macos                   #deploy (3)
#svg (2)                 #release (2)
#utools (4)              #port
```

The `(3)` means three memories share that keyword. The paragraphs stay on disk
until they are actually needed — most of them have nothing to do with today's
task.

## Three rules that keep the notebook from rotting

All three follow the same principle: **when in doubt, do nothing — never lose
anything.**

**1. The same thing is said twice → put a tick on the existing entry.**

No second card. The entry quietly notes "confirmed 3 times, last on Tuesday".
Repeating yourself does not make the notebook fatter, it just makes the old
entry more trustworthy.

**2. A memory turns out to be wrong → stick "see the new one" on it.**

Say you first noted "use MySQL", later "use PostgreSQL". The old entry gets a
label saying it has been replaced: it stays on the page, but it is no longer
advertised in the keyword list, and in search it always comes last with a note
pointing at the newer entry.

Why not tear it out? Because the old sentence often contains a detail the new
one forgot — and tearing out is permanent. If that judgement is ever wrong, the
detail is gone for good.

**3. Something has not been checked for a long time → stick "please re-check" on it.**

Tools and habits change within months, so "this library has no X" can become
confidently wrong. Old entries get labelled ("263 days, please verify before
relying on it") and rank below fresh ones.

It is only a label: nothing is deleted, hidden, or treated as false just because
it is old. There is no automatic cleanup anywhere — deciding "is this still
useful?" would require guessing, and guessing wrong loses data.

## Tidying up

Every 20 new memories (or on request) it does a round of tidying: two entries
about the same thing become one, and different spellings of one concept become a
single keyword. It tells you how many were merged, and every file it rewrites
keeps a backup.

`/memory` gives you a checkup at any time: which entries have been replaced,
which keywords nobody ever searched for, which ones are due for a re-check, and
which pairs look like duplicates. Every suggestion there is manual — nothing is
applied behind your back.

## It gets better at guessing what you need

The system quietly counts **which keywords actually led you somewhere** and
promotes those in the next session's card list. Since the list is short, that
feedback slowly makes it match your real habits.

The list only changes between sessions, never mid-conversation.

## Commands

| Type this | What happens |
|---|---|
| `/memory` | Show the checkup: keyword list, counts, what needs your decision, and where the files are |
| `/memory compact project` | Merge duplicate memories in **this project** |
| `/memory compact user` | Merge duplicate memories in **your global notes** |
| `/memory rebuild project` | Pick better keywords for **this project's** memories, then rebuild its list |
| `/memory rebuild user` | Same, for **your global notes** |
| `/memory help` | Show this list |

`compact` and `rebuild` need to know which one you mean (`project` or `user`),
so they refuse to guess — otherwise every project would rewrite your shared
global notes.

## Where memories live

- **Your global notes** — `~/.pi/agent/memory-auto/` — habits, preferences,
  tools, lessons that hold anywhere.
- **This project's notes** — `.pi/agent/memory-auto/` — decisions, conventions
  and failures specific to this repo. Commit this folder and your teammates
  inherit it.

Both are plain markdown. You can read, edit or delete them by hand — they are
the source of truth. The generated `MEMORY.md` next to them is a view, rebuilt
automatically, so do not bother editing that one.

## Install

```sh
pi install npm:@shanelevs/pi-memory-auto
```

## Settings

Optional, environment variables, all with sensible defaults:

| Variable | Default | Meaning |
|---|---|---|
| `PI_MEMORY_AUTO_REVIEW_TURNS` | `10` | How many turns between "let me note something down" |
| `PI_MEMORY_AUTO_CONSOLIDATE_EVERY` | `20` | How many new memories before a tidying round |
| `PI_MEMORY_AUTO_DIR` | `~/.pi/agent/memory-auto` | Where your global notes live |
| `PI_MEMORY_AUTO_INDEX_BUDGET` | `3000` | How much room the keyword list may take |
| `PI_MEMORY_AUTO_LLM_MAX_TOKENS` | `10000` | Answer budget for the background notes |
| `PI_MEMORY_AUTO_REVIEW_MONTHS` | `0` | Re-check interval in months, `0` = 3/6/12 by topic |

## What's new

**0.8.0** — the notebook learned to correct itself: repeating a memory puts a
tick on the old one instead of adding a copy, a wrong memory gets "see the new
one" rather than being torn out, old memories get a "please re-check" label, and
the keyword list slowly reorders itself around the words that actually helped.
`/memory` now also reports what is worth cleaning up.

Older versions: see the [technical documentation](TECHNICAL.md#changelog-detailed).

## License

MIT
