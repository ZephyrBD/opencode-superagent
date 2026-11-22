# opencode-superagent

一个 OpenCode 插件：为你的 GitHub 仓库配一个常驻的编码智能体团队伙伴。它改编自 DeepSeek Harness 的 [dsh-superagent 原型](../README.md)，保留其领域模型与哲学：

> **尽可能少占用人的注意力，尽可能多地给出价值。**

它只在被请求时、或团队的书面规则允许时行动；只在人必须行动、或能使用结果时说话。

## 它做什么

- **Source**（GitHub Notifications 轮询）把 Issue/PR 的评论变成 Trigger
- **Eval** 两层判断：确定性的 gate（谁可以派活）+ 模型研判（这是不是要干活）
- 接单后创建 **Ticket + Mandate**（记录策略版本、范围、强度——授权与上下文分离，可审计）
- **Executor** 为每个工单开一个 worker session 和独立的 git worktree，worker 用结构化 Report 汇报（progress / waiting / ready / blocked / failed / dropped）
- 同一线程的后续讨论自动到达执行者，不需要再次 @
- 一个迷你面板（`http://127.0.0.1:4096`）只列出"等待人"的工单

## 安装

```bash
# 1. 构建本插件（在本仓库内）
cd plugin-opencode && pnpm install && pnpm check

# 2. 在使用它的项目里注册插件路径
#    opencode.json
{ "plugins": ["<本仓库的绝对路径>/plugin-opencode"] }

# 3. 常驻服务
opencode serve
```

## 最低配置

通过 `opencode.json` 的插件 options 或环境变量：

- `GITHUB_TOKEN` — 有该仓库 Notifications 读取与评论权限
- `repository` — 监听的仓库，`owner/name`
- `allowedActors` — 允许派活的人的 GitHub 登录名，默认为空

## Operator 责任

智能体以你的账号评论、开 PR、发消息，每一条都花同事的注意力，你要对它说的话负责：

- **Start narrow**：从短的 allowed list 开始，proactive 只记录不执行；看到它"本来会做的事"合理后再放宽。
- **调向更少噪音**：它吵了，就把 prompt 改短改严，或暂停它。不要用更多消息去解释噪音。
- **不要用它产出数量**：批量 PR、广播消息的代价大于价值。
- **对它说的话负责**：读它以你名义发的内容，错了就在 prompt 里纠正。

## Source

- **GitHub**：Notifications 轮询 + open PR 跟随（分支名末段 = 工单 ID），PR 关闭/合并驱动工单收尾
- **飞书（可选）**：通过 `lark-cli` 的 `pull/reply` 子命令轮询；配置 `feishu.chats`（每聊天 `mentions`/`all`）后启用；回复按 key 幂等，已删除会话的消息永久丢弃

## 词汇表

Trigger/触发、Thread/线程、Eval/评估、Mandate/授权、Ticket/工单、Subscription/订阅——完整定义见 [根文档 001-domain](../docs/001-domain.md)。

## 行为规范文件

- [prompts/assessor.md](prompts/assessor.md) — Eval 研判的行为规范
- [prompts/worker.md](prompts/worker.md) — worker session 的行为规范
- [prompts/shared.md](prompts/shared.md) — 所有 session 共享的原则
