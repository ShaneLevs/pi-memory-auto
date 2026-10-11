<!-- mid: 20261011-9b88 | t: 2026-10-11 22:37:46 | p: pi-memory-auto | src: auto | tags: pi-framework,events,turn-counting,pitfall -->
In pi, the `turn_end` event's `turnIndex` is an agent-internal counter that resets to 0 on every `agent_start` — it does not correspond to session-wide turn count. Do not use it for session-level turn tracking; derive turn counts from branch messages instead.

