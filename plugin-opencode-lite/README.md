# opencode-superagent-lite

[完整版](../plugin-opencode)的 lite 版：去掉 GitHub 与飞书 Source，用 **OpenCode 本会话消息**作为唯一 Source，用最少的代码展示 super agent 的核心思想。

> 尽可能少占用人的注意力，尽可能多地给出价值——同一哲学，没有外部依赖。

## 保留了什么

- **Trigger**：`/work <任务>` 命令把消息变成不可变触发，内容 hash 做幂等（同一条消息重复提交不会重复开单）
- **Eval（显式 gate）**：会话操作者的直接指令总是 `explicit` 强度，gate 即 Decision，记录可审计的 Decision
- **Ticket + Mandate**：接单原子创建工单与授权（范围、强度、发起者），授权与上下文分离
- **Executor**：每个工单一个 worker session 和一个独立 worktree 目录，最多 `workerLimit` 个并发槽位，超出排队
- **Subscription 扇出**：同一线程的后续消息直接送达执行者，不需再次指派；`/work #t3 <说明>` 精确路由到工单
- **Resume**：人的消息可以在同一 Mandate 下恢复已结束（未被停止）的工单
- **Report**：worker 用结构化报告推进工单（progress / waiting / ready / blocked / failed / dropped），`ready`/`dropped` 结束工单，`blocked` 挂起等待人

## 去掉了什么

GitHub/飞书 Source 与 Channel、模型研判层（inferred）、Outbox 回执与重试、Effects 队列、策略版本化通知、面板。Lite 版信任本机会话，可靠性以"简单"换。

## 安装

```bash
cd plugin-opencode-lite && pnpm install && pnpm check
```

在目标项目的 `opencode.json` 里注册：

```jsonc
{ "plugins": ["<本仓库路径>/plugin-opencode-lite"] }
```

## 使用

- `/work 修复登录页的竞态` —— 开新工单，worker session 自动启动
- `/work #t3 改用环境变量` —— 把后续说明直接送到工单 t3
- worker 通过 `superagent_report_ticket` 汇报；你（或主会话）可用 `superagent_tickets` 查看全部工单、`superagent_stop_ticket` 停止工单

插件 options：`workerLimit`（并发槽位，默认 3）。

## 领域词汇

Trigger/触发、Mandate/授权、Ticket/工单、Report/报告——完整定义见[根文档 001-domain](../docs/001-domain.md)。
