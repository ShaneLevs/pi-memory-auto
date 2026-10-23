<!-- mid: 20261023-25a2 | t: 2026-10-23 23:55:48 | p: pi-memory-auto | src: user | tags: pi-cli,local-path-install,插件安装 -->
pi-memory-auto is installed into the local pi as a LOCAL PATH package (`pi install /Users/shane/Documents/GitHub/pi-memory-auto`, stored as `../../Documents/GitHub/pi-memory-auto` in ~/.pi/agent/settings.json), not `npm:@shanelevs/pi-memory-auto`. pi loads local sources from the resolved path without copying, so edits in this repo are live on the next pi start; the npm copy under ~/.pi/agent/npm/node_modules must stay absent or the extension registers twice. Never re-install the npm entry for day-to-day dev — publish to npm only for other users.

<!-- mid: 20261024-4b14 | t: 2026-10-24 00:17:50 | p: pi-memory-auto | src: auto | tags: readme-changelog,版本小节,versioning -->
pi-memory-auto 的 README changelog 只保留最近两个版本小节——发布 0.7.1 时只留 `### 0.7.1` 与 `### 0.7.0`，`0.6.0` 及更早已被删除；新增小节时要顺手删掉最旧的一节。改 `package.json` 版本号与写 changelog 都只是文件编辑，绝不能据此 commit/publish。

