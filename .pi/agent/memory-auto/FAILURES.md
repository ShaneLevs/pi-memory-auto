<!-- mid: 20261011-9b88 | t: 2026-10-11 22:37:46 | p: pi-memory-auto | src: auto | tags: turn_end-turnindex,turn-counting,pi-framework -->
In pi, the `turn_end` event's `turnIndex` is an agent-internal counter that resets to 0 on every `agent_start` — it does not correspond to session-wide turn count. Do not use it for session-level turn tracking; derive turn counts from branch messages instead.

<!-- mid: 20261012-cfba | t: 2026-10-12 20:56:17 | p: pi-memory-auto | src: user | tags: maxtokens,stopreason-length,truncation -->
pi-memory-auto: truncated memories in local MD files were caused by LLM responses hitting maxTokens (stopReason "length") — partial entry text was stored verbatim. Fixed in src/llm.ts by rejecting stopReason "length" responses. Storage path itself has no char limit.

