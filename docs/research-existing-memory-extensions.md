# 现有 pi 记忆扩展调研笔记

> 调研对象：`jayzeng/pi-memory`、`chandra447/pi-hermes-memory`（2026-10 源码级阅读）

## 一、pi-memory（jayzeng）

**定位**：极简主义。plain markdown + 全文搜索，单文件扩展（index.ts ~2500 行），除 pi 运行时外唯一可选依赖是 [qmd](https://github.com/tobi/qmd)（Tobi Lütke 的全文+向量检索 CLI）。

### 数据层
```
~/.pi/agent/memory/
  MEMORY.md          # 策展式长期记忆（决策、偏好、事实），#tag + [[wiki-link]] 约定
  SCRATCHPAD.md      # 待办清单（add/done/undo/clear）
  daily/YYYY-MM-DD.md# 每日 append-only 日志
  recovery/*.json    # memory_forget 删除的可恢复记录（删除是一等操作）
```
- 无数据库、无独立索引。tags/links 是内容约定而非元数据，qmd 全文索引免费覆盖。
- 设计依据：Letta 2025-08 benchmark（filesystem+search 74.0% vs Mem0 graph 68.5%），赌"文件系统 + agent 自带 grep 能力"胜过专用向量库。

### 工具（7 个）
memory_write / memory_forget / memory_restore / memory_read / scratchpad / memory_search（keyword~30ms BM25、semantic~2s 向量、deep~10s 混合重排）/ memory_status。

### 注入策略（核心亮点：KV cache 稳定快照）
- 注入优先级（16K 总预算）：scratchpad(2K) > 今日日志(3K, tail) > 检索结果(2.5K) > MEMORY.md(4K, middle-truncate) > 昨日日志(3K)。
- **snapshot "stable" 模式（默认）**：快照只在 session_start 与 compaction 时刷新；会话内 write/跨天都不重渲染，保证 system prompt 字节级稳定 → 本地 prefix cache 不失效。写入内容靠 tool-call history 与 memory_read/memory_search 兜底。删除/恢复是例外（权威变化，立即刷新）。
- `per-turn` 模式（opt-in）恢复每轮按 prompt 做 qmd 关键词检索注入 top3（3s 超时、静默失败）——代价是每轮打穿 prefix cache。

### 生命周期
- session_start：探测 qmd → 自动建 collection → 后台增量 embed → 拍快照。
- session_before_compact：自动写 handoff（open scratchpad + 日志尾部 15 行）进今日日志，作为 compaction 后的续接上下文。
- session_shutdown：LLM 生成 exit summary（Decisions/Lessons/Notes/Follow-ups，默认 low reasoning effort、10s 自超时）写入今日日志；<4 条消息的琐碎会话跳过；全 "None." 的空 summary 被过滤。

### 测试
三级：确定性单测（无 LLM）→ e2e（子进程跑真 pi + 真 LLM）→ recall eval（A/B：有/无 selective injection，15 题，预期 delta 主要来自 3 天前的日志条目）。

---

## 二、pi-hermes-memory（chandra447）

**定位**：重型、全功能。移植自 NousResearch Hermes Agent 的三层记忆架构，~18K 行 TS，SQLite(better-sqlite3) + FTS5，732 个测试。

### 数据层（三层 + 一个用户 pinned 层）
| 层 | 存储 | 说明 |
|---|---|---|
| L1 持久记忆 | MEMORY.md / USER.md / failures.md（全局）+ projects-memory/<project>/（项目级） | `§` 分隔条目，5K 字符上限 |
| L2 程序性记忆 | SKILL.md（pi 原生 skills 目录，global/project scope） | 结构化字段渲染：when_to_use/procedure/pitfalls/verification |
| L3 会话检索 | sessions.db：sessions/messages/message_fts(FTS5 trigram，支持 CJK 子串) | 全量索引历史会话，实时索引 + 启动增量 backfill |
| 扩展记忆 | memories/memory_fts 表 | markdown 写入镜像进 SQLite，突破 5K 上限 |
| Standing Instructions | STANDING.md（/memory-pin） | 用户权威指令，每会话必注入，agent 不可写，20 条/2K 硬上限 |

### 注入策略（与 pi-memory 相反的哲学）
- **默认 policy-only**：**不注入任何记忆内容**，只注入一段 `<memory-policy>` 指令，告诉 agent 何时该调用 `memory_search`。首 turn token 极低。
- `legacy-inject` 模式（可配）恢复旧行为：frozen snapshot 注入 MEMORY/USER/项目记忆 + 近期 failure，`<memory-context>` 围栏防注入。
- 关键洞察：**recall 是概率性的**——prohibition 类规则若依赖 agent 主动 search，恰恰在需要时它没有理由去搜。所以有 standing instructions 这个"每模式必注入"的用户直注层。

### 工具
memory_add / memory_replace / memory_remove（按 target: memory/user/project/failure）、memory_search（target/category 过滤 + hit_count 使用统计）、session_search（legacy snippet 或 anchors 变体）、skill_manage（create/patch/update/view/delete，slug 相似度防重）。

### 自动化闭环（最重的部分）
1. **Background review**：每 10 turn 或 15 tool call（OR 关系）用 `completeSimple()` 进程内 LLM 审查对话，提取值得存的事实；失败 fallback 到受限子进程 `pi -p --tools memory_add,...`（防逃逸）。
2. **Correction detection**：message_end/turn_end 正则检测用户纠正（"no, use yarn instead"），立即保存，不等 review 间隔；可自定义强弱/否定 pattern。
3. **Session flush**：compaction 前 / shutdown 时把会话要点刷进记忆。
4. **Auto-consolidation**：记忆满时自动合并（LLM 子进程或 direct transport），usage signals（never-recalled 条目是弱保留候选）+ 分块续传。
5. **Skill auto-extraction**：复杂任务（8+ tool calls、2+ 工具）后提示保存 reusable procedure。
6. **安全**：每次写入过 scanContent()（prompt injection/越权/secret/隐形 unicode 扫描）；memory 与 prompt 都有 XML 围栏。

### 命令
/memory-insights、/memory-skills（TUI 管理器）、/memory-consolidate、/memory-interview（onboarding）、/memory-switch-project、/memory-index-sessions、/memory-sync-markdown、/memory-preview-context、/memory-pin、/learn-memory-tool。

---

## 三、对比与张力点

| 维度 | pi-memory | pi-hermes-memory |
|---|---|---|
| 哲学 | 简单：文件即索引，agent 会用 grep | 全托管：自动学习闭环 + SQLite 检索 |
| 存储 | 纯 markdown + qmd 外部索引 | markdown（源）+ SQLite（镜像/会话索引） |
| 默认注入 | 内容注入（16K 快照，cache 稳定） | policy-only（不注入内容，按需 search） |
| 写入触发 | 显式工具调用 + exit summary | 全自动：review 循环 + 纠正检测 + flush |
| 记忆演化 | 手动 forget/restore | auto-consolidation + aging + usage signals |
| 程序性记忆 | 无 | SKILL.md（pi 原生 skills） |
| 安全 | 删除可恢复 | 内容扫描 + 围栏 + 子进程沙箱 |
| 复杂度 | ~2.5K 行单文件 | ~18K 行，40+ 配置项 |

**两者共同的痛点/取舍**：
1. 注入 vs 检索的根本张力——注入吃 token/cache，policy-only 靠模型自觉有漏召风险（hermes 用 standing instructions 补 prohibit 场景）。
2. 记忆质量：自动提取有噪声风险，pi-memory 只在退出时总结一次；hermes 用 usage signals 反馈回路。
3. CJK 检索：hermes 用 trigram tokenizer 解决；pi-memory 依赖 qmd。
4. 多项目隔离：hermes 有 two-tier；pi-memory 全局一坨。
5. KV cache：pi-memory 的 stable snapshot 是目前最系统的处理。
