<!-- mid: 20261023-25a2 | t: 2026-10-23 23:55:48 | p: pi-memory-auto | src: user | tags: pi-cli,local-path-install,插件安装 -->
pi-memory-auto is installed into the local pi as a LOCAL PATH package (`pi install /Users/shane/Documents/GitHub/pi-memory-auto`, stored as `../../Documents/GitHub/pi-memory-auto` in ~/.pi/agent/settings.json), not `npm:@shanelevs/pi-memory-auto`. pi loads local sources from the resolved path without copying, so edits in this repo are live on the next pi start; the npm copy under ~/.pi/agent/npm/node_modules must stay absent or the extension registers twice. Never re-install the npm entry for day-to-day dev — publish to npm only for other users.

<!-- mid: 20261024-4b14 | t: 2026-10-24 00:17:50 | p: pi-memory-auto | src: auto | tags: readme-changelog,版本小节,versioning -->
pi-memory-auto 的 README changelog 只保留最近两个版本小节——发布 0.7.1 时只留 `### 0.7.1` 与 `### 0.7.0`，`0.6.0` 及更早已被删除；新增小节时要顺手删掉最旧的一节。改 `package.json` 版本号与写 changelog 都只是文件编辑，绝不能据此 commit/publish。

<!-- mid: 20261024-9fd4 | t: 2026-10-24 15:36:22 | p: pi-memory-auto | src: auto | tags: documentation,readme,i18n -->
Keep `README.md` and `README.zh-CN.md` beginner-friendly and free of implementation detail, keep their structure aligned, and place technical information in `TECHNICAL.md`; ship all three documents in the npm package.

<!-- mid: 20261101-2bd0 | t: 2026-11-01 16:46:59 | p: pi-memory-auto | src: user | tags: 版本号,release,changelog -->
pi-memory-auto 当前版本 1.0.0（0.9.0 → 1.0.0，因为「1-3 关键词」是破坏性契约变更）。发布流程仍按老规矩：先核对 `package.json` version、git tag、npm 已发布版本三处，README 只保留最近两个版本的「What's new / 新版有什么」小节（加 1.0.0 时删掉 0.8.0 小节），详细记录写进 `TECHNICAL.md` 的 `## Changelog (detailed)`。改版本号/写 changelog/更新 README 都只是文件编辑，不等于授权 commit、tag 或 publish。

