# pi-memory-auto 设计文档（v3，功能设计已定稿）

> 参考调研：pi-memory、pi-hermes-memory（`research-existing-memory-extensions.md`）、pmem
> 状态：功能设计定稿，待出实现规划

## 1. 目标

给 pi agent 做一个记忆系统：

- 记忆是 plain markdown，人可读、可编辑、可 git 提交
- 注入内容极小且严格受限：主记忆文件**渲染后每文件 ≤1000 字**，session start / compaction 时注入，之后字节级稳定（保 prefix cache）
- agent 对记忆的访问以**检索**为主：不提供整文件读取工具
- 支持用户显式记录 + 受控的自动提取（按对话轮数触发）

## 2. 存储模型

### 2.1 两级位置

| 层 | 位置 | 内容 |
|---|---|---|
| 全局 | `~/.pi/agent/memory-auto/` | 用户身份、偏好、跨项目工具习惯、通用经验 |
| 项目 | `<project>/.pi/agent/memory-auto/` | 该仓库的约定、架构决策、命令、坑 |

- 读取规则由路径天然保证：项目内会话只见「当前项目记忆 + 全局记忆」
- 项目记忆**纳入 git**（不 gitignore），团队共享、可 review

### 2.2 每层结构：主文件 + 分类文件

```
~/.pi/agent/memory-auto/
  MEMORY.md            # 全局主文件（唯一注入候选）
  USER.md              # 用户档案
  TOOLING.md           # 工具习惯
  LESSONS.md           # 通用教训（自动提取默认落点）

<project>/.pi/agent/memory-auto/
  MEMORY.md            # 项目主文件（唯一注入候选）
  CONVENTIONS.md       # 仓库约定
  DECISIONS.md         # 决策记录
  FAILURES.md          # 踩坑记录（自动提取默认落点）
```

- 主文件放"当前最重要的浓缩记忆"，由整理器维护；其余文件为分类文件，只进不出、不整理、无上限

### 2.3 条目格式（逐条存储 + 元数据）

记忆**逐条存储**，每条带元数据，检索结果需将元数据一并返回给 agent：

```markdown
<!-- id: 20261011-a1b2 | time: 2026-10-11 19:40:00 | project: pi-memory-auto | layer: project | source: user | tags: decision,auth -->
#decision [[auth-strategy]] 采用 URL 前缀版本化，避免 CDN 缓存问题。
```

元数据字段（HTML 注释行，注入渲染时剔除）：
- `id` — 条目唯一标识（分页游标、去重用）
- `time` — 写入时间
- `project` — 项目名（项目层条目）
- `layer` — global / project
- `source` — user（显式要求）/ auto（自动提取）
- `tags` — 逗号分隔

### 2.4 长度限制

- 原始文件不限制字数
- 注入时渲染后**每个主文件 ≤1000 字**（全局 + 项目各一个，合计 2000 字），渲染管线为确定性代码：剔除元数据注释、压缩空白、超限裁剪
- 主文件**清洗后的内容达到 1000 字以上时触发自动整理**（见 §3.4）

## 3. 记忆准入与分级标准（三级判断）

> 综合两个参考项目的判断条件：hermes 的 target rubric、COMBINED_REVIEW_PROMPT 正/负例、"genuinely worth saving" 门槛、pi-memory 的琐碎会话门槛与空结果过滤。

### 3.1 第一级：准入标准（该不该存）

**核心检验：未来的某个新会话，没有这条记忆会把事情做错或做慢吗？** 答案是否定的就不存。

该存（正例类别）：

| 类别 | 说明 | 示例 |
|---|---|---|
| 用户画像与偏好 | 身份、沟通风格、工作习惯 | "喜欢简洁回答" |
| 决策及理由 | 选型/方案取舍，重点记 why | "选 PostgreSQL 因为 JSON 支持" |
| 约定 | 团队/仓库规范 | "commit 用 conventional commits" |
| 失败与纠正 | 试错结论、用户纠正、教训 | "localStorage 存 token 有 XSS 风险"、"用 pnpm 不用 npm" |
| 洞察 | 经验得出的可复用认知 | "这个 SDK 自动处理 refresh token" |
| 工具癖性 | 非显而易见的工具/命令行为 | "CI 忄需加 --frozen-lockfile" |

不该存（负例清单）：
- 任务进度、会话结果、临时状态（"我正在修 bug"）
- 能从仓库直接推导的信息（README/代码里明摆着的）
- 一次性细节（某个 bug 的具体堆栈，除非结论可复用）
- 通用知识（模型本来就知道的东西）
- 秘密/密钥（安全红线，写入口扫描拦截）

准入门槛（防噪声机制）：
- 显式写入：用户说"记住"直接进（用户是最终裁决者），但层/文件仍按以下标准判断
- 自动提取：默认 "nothing to save"（宁缺毋滥），必须命中正例类别才写；写入前先检索查重，重复不写
- 琐碎会话不提取（少于一轮有效对话的会话跳过）

### 3.2 第二级：层级标准（全局还是项目）

**试金石：这句话换个项目仓库还成立吗？**

| 判断 | 去向 |
|---|---|
| 含具体仓库路径/命令/架构/团队规范 | 项目层 |
| 与仓库无关、对任何项目都成立的用户事实 | 全局层 |
| 通用环境事实（OS、shell、编辑器） | 全局层 |
| 项目环境（pinned 版本、本地端口约定） | 项目层 |
| 犹豫不决 | **项目层**（影响面小：分错了项目层只污染一个仓库，分错全局层污染所有项目） |

注意同一条内容可能存在两种解读："用 pnpm 不用 npm"——是用户的跨项目习惯（→ TOOLING）还是本仓库的规则（→ CONVENTIONS）？判断依据是内容表述本身，工具 rubric 中会给出此例。

### 3.3 第三级：文件位置标准（存哪个文件）

| 文件 | 收什么 | 不收什么 |
|---|---|---|
| USER.md | 用户身份、画像、沟通风格 | 工具偏好（归 TOOLING） |
| TOOLING.md | 跨项目工具习惯（包管理器、编辑器、shell 环境） | 项目内命令（归项目层） |
| LESSONS.md | 通用教训/洞察（全局自动提取默认落点） | 项目相关教训（归项目层） |
| CONVENTIONS.md | 仓库约定（命名、分支、commit 规范） | 架构选型（归 DECISIONS） |
| DECISIONS.md | 架构/技术选型决策及理由 | 尚未决策的备选项 |
| FAILURES.md | 项目内踩坑/失败/纠正（项目自动提取默认落点） | 通用教训（归 LESSONS） |

### 3.4 标准的落点（同一份 rubric，两处使用）

rubric 作为常量维护一份（constants.ts），**英文撰写**（最终注入提示词/工具描述的内容必须是英文，中文仅用于设计文档表述），同时注入：
1. **memory_write 工具描述**——显式写入时模型自判层与文件
2. **自动提取的 review prompt**——自动提取时按同一标准判断，并额外执行准入门槛（宁缺毋滥 + 查重）

#### 3.4.1 Rubric 英文稿（即提示词实际内容）

以下是三级标准的英文成稿，实现时作为常量直接嵌入工具描述与 review prompt：

```text
# Memory Classification Guide

## Step 1 — Admission: should this be remembered at all?

The test: would a future session, without this memory, do the job wrong or slower?
If not, do not save it.

DO save:
- User profile & preferences: identity, communication style, work habits
- Decisions & rationale: tech/plan choices with the WHY (e.g. "Chose PostgreSQL for JSON support")
- Conventions: team or repo rules (naming, branching, commit style)
- Failures & corrections: what was tried and failed, user corrections, lessons (include what worked instead)
- Insights: reusable knowledge earned from experience
- Tool quirks: non-obvious tool/package/CI behavior

DO NOT save:
- Task progress, session outcomes, temporary state ("currently fixing bug X")
- Anything directly derivable from the repo (what README/code already says)
- One-off details (a specific stack trace, unless the conclusion is reusable)
- General knowledge the model already has
- Secrets, API keys, tokens (never store)

Admission guardrails:
- When in doubt, do not save. "Nothing to save" is a valid outcome.
- Before adding, check for duplicates; skip if an equivalent entry exists.
- Trivial exchanges (no real decisions or corrections) yield no memories.

## Step 2 — Layer: global or project?

The test: would this statement still hold true in a different repo?

| Signal | Layer |
|---|---|
| Mentions repo paths, commands, architecture, team rules | project |
| User facts true regardless of repo (identity, style, habits) | global |
| General environment (OS, shell, editor) | global |
| Project environment (pinned versions, local ports) | project |
| Undecided | project (misrouting here pollutes one repo; misrouting to global pollutes every project) |

Example: "use pnpm, not npm" — a cross-project user habit goes to global TOOLING;
"this repo requires pnpm" goes to project CONVENTIONS. Judge by the wording itself.

## Step 3 — File: which file within the layer?

| File | Accepts | Rejects |
|---|---|---|
| USER.md | identity, profile, communication style | tool preferences (go to TOOLING) |
| TOOLING.md | cross-project tool habits (package manager, editor, shell) | repo-specific commands (go to project layer) |
| LESSONS.md | general lessons & insights (default for global auto-extraction) | project-related lessons (go to project layer) |
| CONVENTIONS.md | repo rules (naming, branches, commit style) | architecture choices (go to DECISIONS) |
| DECISIONS.md | architecture/tech choices with rationale | undecided alternatives |
| FAILURES.md | project-specific pitfalls, failures, corrections (default for project auto-extraction) | general lessons (go to LESSONS) |
```

## 4. 写入规则

### 4.1 层级与目标选择

`memory_write` 按工具描述内的三级标准 rubric（§3）自选「层 + 文件」。

### 4.2 主文件写入保护

- 主文件不接受任何直接写入；`memory_write` 只能写分类文件
- 主文件唯一合法来源是后台整理器

### 4.3 自动提取

- 触发：**仅按对话轮数**，默认每 10 轮一次（无工具调用次数触发条件）
- 阈值可通过环境变量自定义（见 §8）
- 进程内 LLM 调用，宁缺毋滥，空结果不写；只写分类文件

### 4.4 主文件整理

- **触发条件：主文件清洗后内容 ≥1000 字**，自动触发一次整理；**不提供手动命令**
- 整理在后台异步执行，不阻塞当前对话，不影响当前会话上下文（快照不因整理重渲染）
- 整理调用**直接使用当前会话的模型**，无单独模型配置项
- 整理 prompt：输入主文件 + 分类文件近期条目，合并重复、按时间解决矛盾、提炼最有价值内容，输出 ≤1000 字的新主文件；旧内容备份（`.bak`）可恢复
- 并发控制：每文件一把异步锁 + 写入防抖；整理完成后复查，仍超限则再排一轮
- 失败兜底：保持原样，渲染时按预算裁剪，并告警

### 4.5 分类文件

- 不整理、无存储上限，可以一直添加
- 写入并发控制：每文件异步锁；跨进程并发用 lockfile + mtime 检查兜底

## 5. 注入策略

- **注入时机：只有新开对话和压缩对话之后**才重新注入
- `before_agent_start` 检查快照状态——无快照或 compaction 脏标记置位才重拍；其余 turn 复用快照字节（stable 模式）
- 注入内容 = 全局主文件渲染（≤1000 字）+ 项目主文件渲染（≤1000 字），并附一段简短使用说明（记忆是背景上下文、检索用 memory_search 等）
- 会话内新写入不进 prompt：靠 tool-call history 兜底 + 检索工具按需取

## 6. 检索（最终方案）

### 6.1 能力边界（已定稿）

- 只做三类检索：**正则/关键词、tag、时间排序**；**不做向量检索（永久非目标，不接 qmd、不接本地模型）**
- 不提供整文件读取工具：**agent 不允许直接读取整个记忆文件，仅提供检索功能**

### 6.2 工具面（已定稿）

**`memory_search`** — 检索当前项目 + 全局记忆：

| mode | 行为 |
|---|---|
| `keyword`（默认） | 正则/关键词匹配条目内容 |
| `tag` | 匹配条目 tags |
| `recent` | 按时间排序返回最新条目 |
| `all` | 融合 keyword + tag + recency 打包返回 |

- 返回条目**连同元数据**（id/time/project/layer/source/tags）一起返回
- **返回数量上限**（如每页 10 条），**支持分页**（`page` 或 id 游标参数）
- 工具描述写清各 mode 适用场景，由模型自动选择

**`memory_write`** — 写入记忆（target: 层 × 分类文件，逐条追加）

（无 `memory_read`——整文件读取不提供给 agent；用户可随时用编辑器/`cat` 查看文件）

## 7. 生命周期

| 事件 | 行为 |
|---|---|
| session_start | 确保目录存在 → 渲染并拍注入快照 |
| before_agent_start | 无快照或 compaction 脏标记 → 重拍快照注入 |
| turn_end / message_end | 轮数计数；达阈值（默认 10）触发自动提取（异步，写分类文件） |
| 写入后主文件清洗内容 ≥1000 字 | 后台异步整理（防抖 + 文件锁，会话模型） |
| session_before_compact | 置脏标记（下轮重拍快照）；**写 compaction handoff**（第一期实现） |
| session_shutdown | 可选 exit summary / flush（<4 消息跳过、空结果过滤、自超时）——第一期做简版 |

## 8. 非目标（明确不做）

- 向量检索 / 语义检索（qmd、本地模型，永久非目标）
- 手动整理命令（整理全自动，无 `/memory-consolidate` 类命令）
- agent 端整文件读取工具（memory_read）
- 分类文件归档/上限
- 工具调用次数触发的自动提取
- 配置文件（第一期仅环境变量）

## 9. 配置（第一期：仅环境变量）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_MEMORY_AUTO_REVIEW_TURNS` | `10` | 自动提取的对话轮数阈值 |
| `PI_MEMORY_AUTO_DIR` | `~/.pi/agent/memory-auto` | 全局记忆目录（测试/自定义用） |

- 整理模型：无配置项，固定使用当前会话模型
- 其余暂不提供配置，需要时再加

## 10. 待办

- [ ] 实现规划：目录结构、模块划分、扩展骨架（extension 入口 / 工具 / 快照 / 整理器 / 提取器 / 存储）
