<!-- mid: 20261011-9b88 | t: 2026-10-11 22:37:46 | p: pi-memory-auto | src: auto | tags: turn_end-turnindex,turn-counting,pi-framework -->
In pi, the `turn_end` event's `turnIndex` is an agent-internal counter that resets to 0 on every `agent_start` — it does not correspond to session-wide turn count. Do not use it for session-level turn tracking; derive turn counts from branch messages instead.

<!-- mid: 20261012-cfba | t: 2026-10-12 20:56:17 | p: pi-memory-auto | src: user | tags: maxtokens,stopreason-length,truncation -->
pi-memory-auto: truncated memories in local MD files were caused by LLM responses hitting maxTokens (stopReason "length") — partial entry text was stored verbatim. Fixed in src/llm.ts by rejecting stopReason "length" responses. Storage path itself has no char limit.

<!-- mid: 20261024-c8e1 | t: 2026-10-24 15:36:22 | p: pi-memory-auto | src: auto | tags: release,versioning,npm -->
Before selecting a release version, compare `package.json`, Git tags, and npm’s published versions: v0.7.0 and v0.7.1 existed as Git tags but were never published, causing npm to jump from 0.6.0 to 0.8.0.

<!-- mid: 20261024-5678 | t: 2026-10-24 15:47:05 | p: pi-memory-auto | src: auto | tags: npm,node,jiti -->
When validating the published npm package, do not import its TypeScript source with Node’s `--experimental-strip-types` because Node refuses type stripping under `node_modules`; compare the installed tarball with the repo or run it through pi’s jiti loader.

<!-- mid: 20261024-628b | t: 2026-10-24 15:54:15 | p: pi-memory-auto | src: user | tags: npm发布,版本号,git-tag -->
pi-memory-auto 发布新版本前必须同时核对三处：`package.json` 的 version、git tag 列表、npm 上已发布的 versions——它们会不一致。实际情况：v0.7.0/v0.7.1 只打了 git tag、从未发到 npm（npm latest 停在 0.6.0），所以 0.8.0 发布时 npm 版本从 0.6.0 直接跳到 0.8.0，中间 0.7.x 在 npm 上不存在。看到 git tag 有某个版本不代表 npm 上有。

