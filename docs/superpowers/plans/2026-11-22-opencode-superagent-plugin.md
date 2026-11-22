# opencode-superagent 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本仓库新增 `plugin-opencode/` 子项目：一个双层 OpenCode 插件，复刻 dsh-superagent 的领域模型与哲学（Source → Eval → Ticket/Mandate → Executor → Channel）。

**Architecture:** 编排核心内嵌于插件 server part（跑在常驻 `opencode serve` 进程内），内存只是缓存、真相持久化在 OpenCode 插件 storage；Executor 通过 ctx.session 为每个 Ticket 创建 worker session + ctx.worktree 创建独立目录；Eval 研判用 ctx.experimental.generate.text；GitHub Source 轮询 Notifications API，Channel 用 REST 发评论。

**Tech Stack:** TypeScript (ESM, NodeNext, strict, noUncheckedIndexedAccess, verbatimModuleSyntax, `.ts` 相对导入)、zod 4、vitest 4、`@opencode/plugin`。

**Spec:** 本会话讨论定稿的设计 + 原型 `docs/000-philosophy.md`、`docs/001-domain.md`、`docs/003-execution.md`（同仓库，executor 直接阅读）。

## Global Constraints

- **不中途 commit**：所有任务完成、`pnpm check`（typecheck+test+build）通过后，一次性 commit，且必须先经用户手动确认。
- 目录：所有新代码在 `plugin-opencode/` 下，不改动现有 dsh-superagent 代码。
- 相对导入一律带 `.ts` 扩展名（与仓库根 tsconfig 一致，plugin-opencode 沿用同一套 compilerOptions）。
- 配置 schema 一律 zod `.strict()`。
- 安全默认：allowed list 默认为空；proactive 模式默认 `record`（只记录不执行）；面板只监听 127.0.0.1。
- 领域术语沿用原型中文对照（Trigger/触发、Ticket/工单、Mandate/授权……见 docs/001-domain.md 词汇表）。
- 测试不得访问真实 GitHub/真实模型：Source 与 Eval 通过注入的 port 接口测试。

## Review Focus

- 重复投递同一 Trigger 必须幂等（同一 Trigger 二次进入只产生一个 Ticket）→ Task 4 幂等测试。
- 插件热重载/重启后内存清零，状态必须从 storage 完整恢复（含未发出的 Outbox 消息）→ Task 5 恢复测试。
- Policy 暂停（paused）期间 Source 继续记录 Trigger，但不开新 Eval、不派工 → Task 4 暂停测试。
- worker session 的 Report 必须是结构化的，禁止从自由文本推断状态 → Task 6 Report 状态机测试。
- GitHub 404（可能失去私有库访问）不当作终态错误，重试处理 → Task 7 轮询测试。

---

### Task 1: 插件脚手架 + 领域模型类型

**Files:**
- Create: `plugin-opencode/package.json`（name: `opencode-superagent`，type: module，deps: `@opencode/plugin`、`zod`，devDeps: typescript、vitest、@types/node）
- Create: `plugin-opencode/tsconfig.json`、`plugin-opencode/vitest.config.ts`（include `tests/**/*.spec.ts`）
- Create: `plugin-opencode/core/model.ts`、`plugin-opencode/core/ids.ts`
- Test: `plugin-opencode/tests/model.spec.ts`

**Interfaces:**
- Produces: `newTriggerId(): TriggerId` 等 id 工厂（格式 `<prefix>_<26位 ULID 式随机>`）；zod schema `TriggerSchema`（`{ id, source: 'github', actor: { id: string; bot: boolean }, text, url, at: number, threadKey: string }`）、`MandateSchema`（`{ policyVersion, scope, strength: 'explicit'|'inferred', rules: string[], actor, via, createdAt }`）、`TicketSchema`（`{ id, mandateId, status: 'open'|'ended', outcome?, sessionId?, directory?, subscriptions: string[], reports: ReportSchema[] }`）、`ReportSchema`（`{ kind: 'progress'|'waiting'|'ready'|'blocked'|'failed'|'dropped', text, at }`）、`DecisionSchema`（`{ kind: 'accept'|'stop'|'ignore'|'unavailable', reason?, ticketId? }`）。

- [ ] **Step 1:** 写失败测试 `tests/model.spec.ts`：解析合法 Trigger/Mandate/Ticket JSON 通过；`.strict()` 拒绝多余字段；id 工厂输出不重复且带正确前缀。
- [ ] **Step 2:** `pnpm vitest run tests/model.spec.ts` 确认失败。
- [ ] **Step 3:** 实现 ids.ts（用 `crypto.randomUUID` 去横线 + 前缀即可，不引第三方 ULID）与 model.ts。
- [ ] **Step 4:** 测试通过 + `pnpm typecheck` 通过。

### Task 2: KV 存储层

**Files:**
- Create: `plugin-opencode/core/kv.ts`
- Test: `plugin-opencode/tests/kv.spec.ts`

**Interfaces:**
- Produces: `interface KV { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; scan(prefix: string): Promise<{ key: string; value: unknown }[]> }`；`MemoryKV()`（测试用）；`PrefixKV(base: KV, prefix: string)`（命名空间包装）。
- 消费方（Task 5+）在生产环境用插件 `ctx.storage`（本身满足该接口形状）适配一个 `PluginKV`。

- [ ] **Step 1:** 失败测试：MemoryKV set/get/remove/scan 前缀过滤；PrefixKV 隔离两个命名空间。
- [ ] **Step 2:** 确认失败 → 实现 → 通过。

### Task 3: Policy（gate 层）

**Files:**
- Create: `plugin-opencode/core/policy.ts`
- Test: `plugin-opencode/tests/policy.spec.ts`

**Interfaces:**
- Produces: `ConfigSchema`（zod strict：`{ policyVersion: string, paused: boolean = false, proactive: 'off'|'record'|'act' = 'record', sources: { github: { repository: string, allowedActors: string[] = [], pollSeconds: number = 60, agentLogin: string } } }`）；`GateResult = { admissible: false; reason: string } | { admissible: true; strength: 'explicit' | 'inferred' }`；`gate(policy, trigger, tickets): GateResult` —— actor 在 allowedActors → explicit；actor 等于仓库所有者且为 human 且 proactive='act' → inferred（record 模式只记录不创建 Ticket，返回 `{ admissible: true, strength: 'inferred', recordOnly: true }` 标记）；其余拒绝并给 reason 码（`actor-not-allowed` / `paused` / `bot-ignored`）。`revalidate(policy, mandate): boolean` —— policyVersion 相同且 paused=false。

- [ ] **Step 1:** 失败测试覆盖：allowed 命中/未命中、bot 拒绝、paused、record 模式 inferred 只记录、revalidate 版本不匹配拒绝。
- [ ] **Step 2:** 失败 → 实现 → 通过。

### Task 4: Engine（intake → Thread → Eval → Ticket → Subscription）

**Files:**
- Create: `plugin-opencode/core/engine.ts`
- Test: `plugin-opencode/tests/engine.spec.ts`

**Interfaces:**
- Consumes: model.ts 全部类型、policy.gate、`Assessor` port、`KV`。
- Produces: `class Engine`，构造注入 `{ kv, policy, assessor, clock: () => number, notify(event) }`。方法：`intake(trigger: Trigger): Promise<Disposition>`（Disposition = `filtered` | `evaluated` | `fannedOut` | `recorded`）；`resume(ticketId, actor): Promise<void>`（人消息恢复 ended Ticket，前提 revalidate 通过）；`stop(ticketId): Promise<void>`（人停单，撤 Mandate 效力）；`thread(key): Promise<ThreadState | undefined>`。规则：Thread 串行 Eval（队列合并后续 Trigger 进下一批）；同 Trigger 二次进入不重复建 Ticket（按 triggerId 记录 disposition）；accept → 建 Ticket（Mandate 附 Policy 版本）+ 记录 subscription 到 threadKey；accept 但 assessor 超时/抛错 → Decision `unavailable`，Trigger 排队重评。Assessor port：`interface Assessor { assess(input: { batch: Trigger[]; thread: ThreadState; tickets: Ticket[] }): Promise<Decision> }`。

- [ ] **Step 1:** 失败测试（用脚本化假 Assessor + MemoryKV + 假时钟）：①新 trigger accept 建 Ticket 含 Mandate；②同 trigger 重放幂等；③paused 时 recorded 且无 Eval；④evaluated Ticket 收到同 thread 后续 trigger 扇出（fannedOut，不新开 Eval）；⑤人消息 resume ended Ticket；⑥人 stop 后 bot 消息不再唤醒；⑦assessor 抛错 → unavailable 且 trigger 留队。
- [ ] **Step 2:** 失败 → 实现 Engine（Thread 队列用 Promise chain 保证串行）→ 通过。

### Task 5: Outbox（stored work + 退避重试 + 重启恢复）

**Files:**
- Create: `plugin-opencode/core/outbox.ts`
- Test: `plugin-opencode/tests/outbox.spec.ts`

**Interfaces:**
- Consumes: KV。
- Produces: `class Outbox`，构造 `{ kv, clock, send(name: string, payload: unknown): Promise<void>, delay(ms): Promise<void> }`。`enqueue(kind, payload)` 先持久化（key `outbox/<递增序号>`）再执行；失败按 2s 起步、翻倍至 60s 重试；连续 3 次失败标记 problem；`recover()` 启动时扫描未完成项重放。测试用假 send 可配置前 N 次抛错。

- [ ] **Step 1:** 失败测试：①成功即删记录；②send 连续失败两次后第三次成功（间隔按假时钟推进验证退避序列 2s→4s）；③recover() 重放崩溃前残留项；④不同 kind 互不阻塞。
- [ ] **Step 2:** 失败 → 实现 → 通过。

### Task 6: Executor（worker session + worktree + Report 状态机）

**Files:**
- Create: `plugin-opencode/executor/session.ts`、`plugin-opencode/executor/dirs.ts`、`plugin-opencode/core/executor-port.ts`
- Test: `plugin-opencode/tests/executor.spec.ts`

**Interfaces:**
- Consumes: Engine 的 Ticket；`SessionPort`（生产实现包装 ctx.session；测试用假实现）：`interface SessionPort { create(title: string, agent: 'worker'): Promise<{ sessionID: string }>; prompt(sessionID: string, text: string): Promise<void>; interrupt(sessionID: string): Promise<void> }`；`WorktreePort`（生产 = ctx.worktree.create；测试假）：`{ create(name: string): Promise<{ directory: string }> }`。
- Produces: `class Executor`，构造 `{ sessions: SessionPort, worktrees: WorktreePort, kv, onReport }`。`dispatch(ticket, inputs: string[])`：为 Ticket 建 worktree（名 = ticket 短名，已存在则复用）+ worker session，首条 prompt 含 worktree 目录路径、仓库、Mandate 摘要与待办输入。`deliver(ticketId, text)`：向 worker session prompt 新输入。`report(ticketId, report)`：由 report_ticket 工具回调，写入 Ticket.reports 并推进状态机——`ready` 无 PR 需求则 Ticket 置 ended/completed；`dropped` 置 ended；`blocked`/`failed` 停止自动投递直到人的新消息；`waiting` 置 idle。并发：`Semaphore(limit)`，一个 Ticket 占一个槽，人的消息可走额外应急槽（limit+1）。

- [ ] **Step 1:** 失败测试：①dispatch 建 worktree+session 且首条 prompt 含目录与 Mandate；②同 Ticket 二次 dispatch 复用同一 sessionID 与目录；③ready Report 结束 Ticket；④blocked 后 deliver 被拒，人的 resume 后放行；⑤并发 limit=2 时第 3 个 dispatch 排队，但人的消息用应急槽立即投递。
- [ ] **Step 2:** 失败 → 实现 → 通过。

### Task 7: GitHub Source + Channel

**Files:**
- Create: `plugin-opencode/sources/github/poll.ts`、`plugin-opencode/sources/github/channel.ts`
- Test: `plugin-opencode/tests/github-source.spec.ts`

**Interfaces:**
- Consumes: Engine.intake、model.ts。
- Produces: `class GitHubSource`，构造 `{ config: GithubSourceConfig, engine: { intake(t: Trigger): Promise<Disposition> }, kv, fetchJSON: (url: string, init?: RequestInit) => Promise<{ status: number; json: unknown }> }`（fetchJSON 注入以便测试与运行时共用同一逻辑，运行时实现带 `Authorization: Bearer <GITHUB_TOKEN>`）。`pollOnce()`：GET `/repos/{repo}/notifications`（未读），按 thread（issue/PR number）映射 threadKey `github:{repo}:{number}`，actor 从 comment author 取；bot 自己的评论（login === agentLogin）过滤；读位置记 `since`（Last-Modified 时间戳，请求带 If-Modified-Since）；404 → 记 thread 级错误不推进（Review Focus 第 5 条）；连续 3 次轮询失败标记 source 错误，成功即清零。`Channel`：`reply(threadKey, text)` → POST `/repos/{repo}/issues/{number}/comments`；经 Outbox 发送。

- [ ] **Step 1:** 失败测试（假 fetchJSON 返回 fixture）：①issue 评论 → intake 收到正确 Trigger（threadKey/actor/text/url）；②bot 自评被过滤；③404 → 报错且 since 不推进；④连续 3 次失败置 error，第 4 次成功清除；⑤reply 组装正确 POST 且经 Outbox。
- [ ] **Step 2:** 失败 → 实现 → 通过。

### Task 8: Eval 研判（Assessor 实现）+ prompt

**Files:**
- Create: `plugin-opencode/core/assessor.ts`、`plugin-opencode/prompts/assessor.md`、`plugin-opencode/prompts/worker.md`、`plugin-opencode/prompts/shared.md`
- Test: `plugin-opencode/tests/assessor.spec.ts`

**Interfaces:**
- Consumes: Assessor port、`GeneratePort`（生产 = ctx.experimental.generate.text；测试假）：`{ text(opts: { model?: string; prompt: string }): Promise<{ text: string }> }`。
- Produces: `class LlmAssessor implements Assessor`，构造 `{ generate: GeneratePort, timeoutMs = 60000 }`。assess：组装 prompts/assessor.md（内容：哲学摘录——只在被请求或书面规则允许时行动、诚实报告、一次只问一个具体问题；batch 原文、thread 历史、现有 Ticket 列表、gate 结果与 Mandate 候选），要求输出单个 JSON 对象 `{"kind":"accept|stop|ignore","scope":"...","reason":"..."}`；解析失败/超时/非 JSON → Decision `unavailable`（Review Focus：绝不猜测）。prompts/worker.md：worker 行为规范（用 report_ticket 上报结构化状态、blocked 时停手提问、完成后 ready 并给 PR 链接、诚实标记草稿）。

- [ ] **Step 1:** 失败测试：①合法 JSON 输出解析为 accept；②输出夹带 markdown 围栏仍可解析（提取 `{...}`）；③超时 → unavailable；④非 JSON → unavailable。
- [ ] **Step 2:** 失败 → 实现 → 通过。三个 prompt 文件为静态文案，写入后由 Task 11 的 prompt 测试断言关键句存在。

### Task 9: 插件装配（server part 入口 + report_ticket 工具）

**Files:**
- Create: `plugin-opencode/index.ts`
- Test: `plugin-opencode/tests/plugin.spec.ts`

**Interfaces:**
- Consumes: 全部前序模块。
- Produces: `export default Plugin.define({ id: 'opencode-superagent', async setup(ctx) { ... } })`。装配顺序：读 ctx.options（覆盖 ConfigSchema 默认）→ 建 KV 适配（ctx.storage）→ 建 Engine/Executor/Outbox/GitHubSource/LlmAssessor → `ctx.tool.transform` 注册命名空间 `superagent` 下工具 `report_ticket`（input: `{ ticket: string, kind: 'progress'|'waiting'|'ready'|'blocked'|'failed'|'dropped', text: string }`，execute 调 executor.report）→ 定时器启动 GitHub 轮询（setInterval pollSeconds）→ 返回 cleanup（清定时器、abort、flush outbox）。Eval 研判使用 ctx.experimental.generate.text。启动时先 `recover()`（Outbox）再恢复未完成 Ticket 的 dispatch（Review Focus 第 2 条）。
- 测试策略：index.ts 拆出纯函数 `assemble(deps)`，测试直接调 assemble 用假 deps，验证工具注册、cleanup 清理定时器、恢复顺序（Outbox recover 先于 dispatch 恢复）。Plugin.define 壳层不单测。

- [ ] **Step 1:** 失败测试 tests/plugin.spec.ts：①assemble 注册了 `superagent_report_ticket` 工具且 execute 正确转发 report；②cleanup 清掉轮询定时器（用假 timer 注入）；③启动恢复顺序正确。
- [ ] **Step 2:** 失败 → 实现 assemble + Plugin 壳 → 通过 → `pnpm build`（tsup 或 tsdown，输出 dist/，package.json exports `"."` 指向 `./index.ts`——OpenCode 本地目录模式直接加载 TS）。

### Task 10: 迷你面板

**Files:**
- Create: `plugin-opencode/panel/http.ts`
- Test: `plugin-opencode/tests/panel.spec.ts`

**Interfaces:**
- Produces: `startPanel(engine, { port = 4096, host = '127.0.0.1' }): Promise<{ url: string; close(): Promise<void> }>`（node:http）。路由：`GET /` 单页 HTML（无依赖内联）：顶部系统问题（Outbox 连续失败项、Source 错误），其后"待人工"列表（blocked/failed/waiting-answer 的 Ticket，含短名、等待原因、最后报告时间），再列 working/idle Ticket 一行一条；`GET /api/state` 返回同内容 JSON。健康状态不占版面（哲学）。

- [ ] **Step 1:** 失败测试（注入 MemoryKV 的 Engine 状态 + 真实 http 但随机端口）：①`/api/state` 的 attention 列表只含 blocked/failed；②`GET /` 200 且含 Ticket 短名；③close() 后端口释放。
- [ ] **Step 2:** 失败 → 实现 → 通过。

### Task 11: README、安装说明与一致性测试

**Files:**
- Create: `plugin-opencode/README.md`、`plugin-opencode/tests/docs.spec.ts`
- Modify: 无（根 README 不动，README 中不加链接避免根 docs.spec 链接检查——如需提及在根 README 增加相对链接 `plugin-opencode/README.md` 并让根测试自然覆盖）

**Interfaces:**
- Produces: README 章节：哲学一句话（最少注意力）、安装（clone 本仓库 → `pnpm install && pnpm build`（plugin-opencode 目录）→ 使用者项目 `opencode.json` 加 `"plugins": ["<本地绝对路径>/plugin-opencode"]` → 跑 `opencode serve`）、最低配置（GITHUB_TOKEN + repository + allowedActors）、operator 责任（Start narrow / 少噪音 / 对发言负责）、词汇表指向根 docs/001-domain.md。
- docs.spec.ts：断言 README 中每个相对链接可解析、安装命令里出现 `"plugins"` 与 `opencode serve`、README 引用的文件路径（prompts/*.md）存在。

- [ ] **Step 1:** 写失败测试 docs.spec.ts。
- [ ] **Step 2:** 失败 → 写 README → 通过。

### Task 12: 全量验证 + 一次性提交（需用户确认）

- [ ] **Step 1:** `cd plugin-opencode && pnpm check`（typecheck + vitest run + build）全部通过；同时根目录 `pnpm check` 不回归。
- [ ] **Step 2:** 向用户展示 diff 摘要，经用户确认后执行唯一一次 commit：`feat(plugin-opencode): add OpenCode superagent plugin (two-layer, dsh-superagent inspired)`。
