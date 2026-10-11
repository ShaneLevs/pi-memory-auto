# pi-memory-auto 实现规划

> 设计文档见 `docs/design-draft.md`（v3 定稿）。本文是面向实现的模块划分与并行执行计划。

## 1. 技术形态

- **单个 TypeScript 扩展目录**，入口 `index.ts`，pi 用 jiti 直接加载，无需构建步骤
- 依赖：仅 `@earendil-works/pi-coding-agent`（类型）、`typebox`（工具参数 schema）。零运行时依赖
- 测试：`node --test` + `tsx`（或 node 原生 TS strip），纯函数模块不依赖 pi 运行时，可直接测

## 2. 目录结构

```
pi-memory-auto/
  index.ts                  # 入口：registerTool × 2 + 生命周期 wiring
  package.json              # name/type/dependencies（jiti 加载用）
  tsconfig.json
  README.md
  src/
    config.ts               # 环境变量解析（PI_MEMORY_AUTO_REVIEW_TURNS=10、PI_MEMORY_AUTO_DIR）
    constants.ts            # 文件名常量、渲染预算(1000)、分页(10)、ENTRY_RE 参考项目的英文 rubric 全文
    types.ts                # MemoryEntry、SearchMode、ToolResultDetails 等
    entry.ts                # 条目序列化/解析：metadata 注释行 <-> MemoryEntry（id/time/project/layer/source/tags）
    store.ts                # 目录管理、追加写、per-file 异步 mutex、lockfile+mtime 跨进程守卫、清foil后字数检查
    render.ts               # 确定性渲染：去 metadata 注释、压缩空白、按预算裁剪
    snapshot.ts             # 快照状态机：session_start / compaction 脏标记 -> 重拍；否则复用字节
    search.ts               # keyword/tag/recent/all 四模式 + 融合打分 + 分页
    llm.ts                  # ctx.modelRegistry.complete() 封装（review/consolidation 共用，会话模型）
    extractor.ts            # 自动提取：turn 计数 -> review prompt -> 解析 entries -> 去重 -> 写分类文件
    consolidator.ts         # 主文件整理：>=1000 触发、.bak、防抖、复检循环
    handoff.ts              # compaction handoff：append handoff 条目（异步不阻塞）
  test/
    entry.test.ts  render.test.ts  search.test.ts  store.test.ts
```

## 3. 关键实现决定

- **注入**：`before_agent_start` 中，若无快照或 `compactionDirty` 则渲染全局+项目主文件拼 preamble 返回 `{ systemPrompt: event.systemPrompt + injected }`；否则返回 undefined（零改动保 cache）
- **条目格式**（`entry.ts` 单一事实源）：
  `<!-- mid: 20261011-a1b2 | t: 2026-10-11 19:40:00 | p: <project|-> | src: user|auto | tags: a,b -->` + 正文单行/多行
- **准入 rubric**：英文全文放 `constants.ts`，`memory_write` 描述与 extractor 的 review prompt 共用
- **整理触发**：`store.append()` 后对主文件做 clean-length 检查（>=1000 触发 consolidator，异步防抖）；主文件只由 consolidator 写
- **检索**：无 memory_read；`memory_search` 返回条目（含元数据）+ `total`/`page`/`hasMore`
- **LLM 调用**：`ctx.modelRegistry.complete(ctx.model, {...}, { cacheRetention:"none", sessionId: uuidv7() })`，review/consolidation 均 fire-and-forget + 自超时
- **compaction**：`session_before_compact` 返回 undefined（不接管）+ 置脏标记 + 异步写 handoff 条目
- **session_shutdown**：flush 提取（简版：<4 条消息跳过）、清理 pending 定时器

## 4. 并行执行计划（subagent lanes）

Lanes 按文件所有权划分，避免写冲突：

| Lane | 拥有文件 | 依赖 |
|---|---|---|
| A 基础层 | config/constants/types/entry + tests | 无 |
| B 存储层 | store.ts + tests | A 的类型/常量（接口先行约定） |
| C 渲染+快照 | render.ts/snapshot.ts + tests | A |
| D 检索 | search.ts + tests | A |
| E 整合 | index.ts、llm/extractor/consolidator/handoff | A-D 完成后 |

接口契约由 lane A 的 types.ts/constants.ts 冻结（先写完再放行 B/C/D）。最终 lane E 整合 + 全量测试。

## 5. 验收

- [ ] `pi --extension .` 能加载（空目录自动创建）
- [ ] 新会话注入 preamble（≤2000 字），后续 turn 字节稳定
- [ ] memory_write 只写分类文件；检索四模式 + 分页正确；元数据随条目返回
- [ ] 10 轮触发自动提取；主文件 ≥1000 字触发整理且有 .bak
- [ ] compaction 后下轮重新注入
- [ ] `npm test` 全绿
