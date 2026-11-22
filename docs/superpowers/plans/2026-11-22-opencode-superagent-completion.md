# opencode-superagent 补全计划（四阶段）

> 状态：规划稿（Plan mode）。切回 build agent 后移入 `plugin-opencode/../docs/superpowers/plans/` 并按 executing-plans 逐任务实施。
> 基线：feat/superagent-plugin 分支，82/82 测试全绿。每一阶段结束都是可发布状态。

**Goal:** 把 dsh-superagent 原型的可靠性恢复体系、orchestrator 会话智能、PR 生命周期治理、飞书 Source 按序移植进 OpenCode 插件。

**Spec:** 原型 `docs/003-execution.md`（恢复/重试/阶段）、`docs/002-authorization.md`、`docs/008-cookbook.md`（Source 方法论）、`prompts/` 全集。

**全局约束**（沿用）：不中途 commit、每任务 TDD RED→GREEN、`.ts` 导入扩展、zod strict、测试不访问真实 GitHub/飞书/模型、每阶段结束 `pnpm check` 全绿 + 用户确认后一次 commit。

---

## 阶段 ①：执行恢复体系（可靠性根基）

原型语义来源：docs/003-execution.md 的 Ticket stages、Failure and recovery、Stored work、Restart 各节。OpenCode 没有可控的 shell-job 治理，对应简化：后台任务上限与槽位语义不移植（worker session 由 OpenCode 自管），恢复按"Assignment 记录 + 未读消息重放 + 恢复说明"实现。

### Task 1.1 Assignment 实体化
- `core/assignment.ts`：`Assignment { id, ticketId, status: 'pending'|'running'|'ended', endReason?, startedAt, endedAt }`，KV 键 `assignment/<id>`，Ticket 增加 `assignmentIds: string[]`。
- Executor.dispatch 创建 Assignment（pending→running），session prompt 结束（turn 返回）→ running；`endAssignment(reason)` → ended。
- 测试：dispatch 建 Assignment 并推进状态；endAssignment 独立于 Ticket 状态。

### Task 1.2 临时性失败重试
- 失败分类函数 `isTransient(error)`：HTTP 408/429/5xx、ECONNRESET/ECONNREFUSED/ETIMEDOUT、模型供应商 5xx → transient。
- Executor.dispatch 抛 transient 错误 → 重试 3 次（2s 起步翻倍），仍失败 → Ticket 记 `failed` Report + held；非 transient 直接 failed 不重试。
- 测试：假 sessions 前两次抛 ECONNRESET 第三次成功；第 4 次仍败 → failed；非 transient 一次即 failed。

### Task 1.3 未读消息账本
- Executor 维护 `taken/<sessionId>` 账本：`deliver` 成功写入"已投递未确认"，worker 的下一个 Report 或 turn 结束 → 标记已读（模拟原型的 step 认领语义：prompt 成功返回即视为下一步会取走）。
- 重试/重启换新 Assignment 时：取账本中"未确认"的消息，从新 Assignment 的首条 prompt 重新投递。
- 测试：投递后无 Report → 换 Assignment 重投；Report 到达后 → 不重投。

### Task 1.4 恢复说明与启动重建
- `assemble.start()` 恢复顺序扩展：recover outbox → executor.rebuild() → **对每张 running/open 且有 Assignment 的 Ticket 重发恢复说明**（brief 追加："主进程曾重启，先检查目录、git 历史、远端状态，再决定是否重复任何外部动作"）→ resume pending → retryPending。
- 重启时 running Assignment 记 `ended('host restarted')`，新 Assignment 按最旧 Ticket 先行。
- 测试：KV 预置 open Ticket + running Assignment + 未读消息 → start 后新 session 收到恢复说明 + 重投消息；两 awaiting 恢复按 id 排序。

### Task 1.5 Ticket stage 推导
- `core/stage.ts`：按 docs/003 首表实现九阶段（person/delivery、person/answer、person/review、person/blocked、person/failed、working/queued、idle、working……首条匹配）。面板 attention 列改由 stage 驱动（`person/*` 即待人工）。
- 测试：逐阶段构造 Report/Input/Assignment 组合断言 stage。

## 阶段 ②：orchestrator 会话（补智能）

原型语义来源：docs/004-prompts.md、prompts/orchestrator.md、subscription 的 follow-up 归属规则。

### Task 2.1 Orchestrator 会话端口
- `core/orchestrator.ts`：`OrchestratorPort { decide(input): Promise<Decision>; classifyFollowUp(input): Promise<{ owner: 'ticket-1'|'none'|..., inScope: boolean }> }`。生产实现 = 一个常驻 orchestrator session（`ctx.session.create` 一次，之后 `ctx.session.prompt` 驱动），要求 JSON 输出（复用 LlmAssessor 的 extractJson）。
- Engine 的 Assessor 改为优先走 orchestrator 会话，`unavailable` 时回退现有单次 generate。
- 测试：假 orchestrator 会话（记录 prompt 数、返回脚本决策）；回退路径触发条件。

### Task 2.2 follow-up 归属
- Engine.intake 对有活工单线程的 trigger 先问 orchestrator `classifyFollowUp`：in-scope → 扇出（现状）；out-of-scope 或指向其他 Ticket → 交给对应 Ticket 或回流 Eval 做新工单候选。
- 被工单"hand back"的消息：recorded 到线程，作为新候选进入 Eval（不再隐式扇出）。
- 测试：hand-back 路径建新 Ticket；in-scope 不多评。

### Task 2.3 prompts/orchestrator.md
- 移植原型 orchestrator 的核心段落：路由原则、一次一个具体问题、stop-only 介入他人 Ticket、诚实报告。docs.spec 断言关键句存在。
- 测试：复用 Task 11 的 docs.spec 模式。

## 阶段 ③：PR 跟随与合并治理

原型语义来源：docs/003-execution.md 的 Pull requests、Merging 两节。

### Task 3.1 PR 发现与跟随
- GitHub Source 轮询 `pulls?state=open`（每 poll 附带），head ref 末段匹配 Ticket 短名 → 订阅该 PR 线程（`github:{repo}:pr:{number}`）到 Ticket.subscriptions。
- Ticket 完成判定：报告 ready 且其开启的 PR 全部关闭/合并 → Ticket ended（outcome 按 close 类型）；开启 PR 未闭合 → 保持 review 等待。
- 测试：发现 PR → subscription 增加；PR merged → ended/completed；PR closed 未合并 → ended + 最终通知。

### Task 3.2 事件触发 worker
- PR 上的新评论/approve/request-changes → Trigger → 扇出到 worker（唤醒等待 review 的 Ticket）。
- 测试：approve comment 触发 fanout。

### Task 3.3 合并治理 prompt + 交付要求
- prompts/worker.md 增补：默认不开 auto-merge；<200 行变更且 ready 时才按交付要求执行；推新修订前先撤 auto-merge。
- Ticket brief（executor.brief）注入交付要求段。
- 测试：brief 含交付要求；prompt 文件断言关键句。

### Task 3.4 PR 结果通知
- PR 关闭/合并 → 经 Outbox 向起源 Channel（issue 评论）发一条最终通知。
- 测试：merged → outbox 收到 notice 记录。

## 阶段 ④：飞书 Source

方法论：docs/008-cookbook.md 全流程；传输层用 `lark-cli`（与原型一致，测试注入假 CLI 输出）。

### Task 4.1 SourceKind 抽象
- 现有 GitHub 逻辑上提为 `SourceKind` 接口（`find/scope/channel/health`），GitHub 实现适配；registry 按配置选择启用哪些 kind。
- 测试：现有 github 测试不改语义全部通过（回归门槛）。

### Task 4.2 Feishu 翻译层
- `sources/feishu/translate.ts`：消息 → Trigger（threadKey `feishu:{chat}:{root id}`；actor = open_id；bot 自身与不在监听列表的 chat 过滤）。
- 测试：cookbook 里的消息样例 → Trigger 断言。

### Task 4.3 lark-cli 通道
- `sources/feishu/cli.ts`：`pull/reply/thread` 三个子命令封装，JSON 解析、410 删除会话 → 消息 dropped、错误分类进 health。
- 测试：假 CLI stdout fixture；410 dropped；连续失败 health error。

### Task 4.4 轮询 + 回复
- `sources/feishu/index.ts`：pollSeconds 轮询 pull --after 游标；Channel.reply 经 Outbox；回复 key 幂等（每 key 只发一次）。
- 测试：游标推进、重复 pull 不重发、reply 幂等。

### Task 4.5 配置与文档
- ConfigSchema 增加 `sources.feishu`（chats/listen 模式/bot CLI 路径），默认不启用；README 增飞书段落。
- 测试：docs.spec 惯例。

## 里程碑与顺序

| 阶段 | 任务数 | 完成标志 |
|---|---|---|
| ① 恢复体系 | 5 | 重启/重试/未读重放全绿，面板按 stage 显示 |
| ② orchestrator | 3 | Eval 走常驻会话，follow-up 归属生效 |
| ③ PR 治理 | 4 | Ticket 随 PR 生命周期结束，通知到位 |
| ④ 飞书 | 5 | 双 Source 可配置，回归全绿 |

每阶段收尾：`pnpm check` 全绿 → 更新 README → 用户确认 commit（一次 commit/阶段）。
