# opencode-superagent-lite

同一领域模型的**极小实现**：去掉 GitHub 与飞书 Source，用 **OpenCode 本会话消息**作为唯一 Source，用最少的代码展示 super agent 的核心思想。仓库根就是插件本体，与 [完整插件（main 分支）](https://github.com/ZephyrBD/opencode-superagent/tree/main)的区别只在于 Source 与研判层——main 由 GitHub/飞书事件驱动、带模型研判与面板，lite 由你在会话里 `/work` 直接驱动。

> 尽可能少占用人的注意力，尽可能多地给出价值——同一哲学，没有外部依赖。

分支全貌见 [main 的 README](https://github.com/ZephyrBD/opencode-superagent#三种形态)。本 README 只讲 lite 自己。

## 保留了什么

- **Trigger**：`/work <任务>` 命令把消息变成不可变触发，内容 hash 做幂等（同一条消息重复提交不会重复开单）
- **Eval（显式 gate）**：会话操作者的直接指令总是 `explicit` 强度，gate 即 Decision，记录可审计的 Decision
- **Ticket + Mandate**：接单原子创建工单与授权（范围、强度、发起者），授权与上下文分离
- **Executor**：每个工单一个 worker session 和一个独立 worktree 目录，最多 `workerLimit` 个并发槽位，超出排队
- **Subscription 扇出**：同一线程的后续消息送达最近的 live 工单，不需再次指派；`/work #t3 <说明>` 精确路由到工单
- **Resume**：人的消息可以在同一 Mandate 下恢复已结束（未被停止）的工单
- **Report**：worker 用结构化报告推进工单（progress / waiting / ready / blocked / failed / dropped），`ready`/`dropped` 结束工单，`blocked` 挂起等待人

## 去掉了什么

GitHub/飞书 Source 与 Channel、模型研判层（inferred）、Outbox 回执与重试、Effects 队列、策略版本化通知、面板。Lite 版信任本机会话，可靠性以"简单"换。

## 安装

对你的编码 Agent 说：

```text
按 https://github.com/ZephyrBD/opencode-superagent lite 分支的 SETUP.md，带我安装 opencode-superagent-lite。
```

也可以手动安装，见本分支的 [SETUP.md](SETUP.md)。核心步骤：

```bash
git clone https://github.com/ZephyrBD/opencode-superagent.git
cd opencode-superagent && git switch lite
pnpm install && pnpm check
```

在目标项目的 `opencode.json` 里注册：

```jsonc
{ "plugins": ["<clone 路径>"] }
```

> 注意：同一个项目不要同时注册 main 和 lite 的 checkout——两者的工具名相同，会互相覆盖。

## 使用

- `/work 修复登录页的竞态` —— 开新工单，worker session 自动启动
- `/work #t3 改用环境变量` —— 把后续说明直接送到工单 t3
- worker 通过 `superagent_report_ticket` 汇报；你（或主会话）可用 `superagent_tickets` 查看全部工单、`superagent_stop_ticket` 停止工单

插件 options：`workerLimit`（并发槽位，默认 3）。

## 领域词汇

- **Trigger/触发** —— 一条 `/work` 消息；不可变，disposition 是幂等单元
- **Eval/评估** —— lite 版只有显式 gate：操作者的直接指令即 accept
- **Mandate/授权** —— accept 授予的范围与强度，独立于工单持久保存
- **Ticket/工单** —— 一单位已授权的工作，自定义 open/ended 状态，不跟随 worker session
- **Report/报告** —— worker 的结构化汇报，是移动工单状态的唯一方式
- **Subscription/订阅** —— 工单与来源线程的关系；线程上的后续消息经它扇出，无需再评估

完整定义见 [dsh-superagent 原型文档 001-domain](https://github.com/ZephyrBD/opencode-superagent/blob/vanilla/docs/001-domain.md)。
