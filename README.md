# opencode-superagent

一个 OpenCode 插件：为你的 GitHub 仓库配一个常驻的编码智能体团队伙伴。它改编自 DeepSeek Harness 的 [dsh-superagent 原型](https://github.com/ZephyrBD/superagent-prototype-for-opencode/blob/vanilla/README.md)，保留其领域模型与哲学：

> **尽可能少占用人的注意力，尽可能多地给出价值。**

它只在被请求时、或团队的书面规则允许时行动；只在人必须行动、或能使用结果时说话。

## 它做什么

- **Source**（GitHub Notifications 轮询）把 Issue/PR 的评论变成 Trigger
- **Eval** 两层判断：确定性的 gate（谁可以派活）+ 模型研判（这是不是要干活）
- 接单后创建 **Ticket + Mandate**（记录策略版本、范围、强度——授权与上下文分离，可审计）
- **Executor** 为每个工单开一个 worker session 和独立的 git worktree，worker 用结构化 Report 汇报（progress / waiting / ready / blocked / failed / dropped）
- 同一线程的后续讨论自动到达执行者，不需要再次 @
- 一个迷你面板（`http://127.0.0.1:4096`）只列出"等待人"的工单

## 安装（自然语言法）

对你的编码 Agent 说：

> 阅读本仓库的 SETUP.md，带我安装 opencode-superagent。

Agent 会按剧本逐条问你（监听仓库、允许派活的人、机器人账号、Token、安装范围），一次一个问题，然后自动完成注册、Token 配置和验证。也可以手动安装，见 [SETUP.md](SETUP.md)。

手动安装的核心步骤：

```bash
# 1. 克隆仓库并安装依赖
git clone https://github.com/ZephyrBD/superagent-prototype-for-opencode.git
cd superagent-prototype-for-opencode
pnpm install

# 2. 常驻运行（插件挂在 serve 进程里）
opencode serve
```

在你的项目（或全局 `~/.config/opencode/opencode.json`）注册插件：

```jsonc
{ "plugins": ["<上一步克隆出的仓库路径>"] }
```

> 备注：`opencode plugin add github:ZephyrBD/superagent-prototype-for-opencode#main` 在大多数机器上可用，但 npm 全局安装的编译版 opencode 存在一个已知 bug（git 依赖的 prepare 阶段错误地用 opencode 自身解释内嵌 npm），会报 `git dep preparation failed`。遇到该报错时请使用上面的克隆方式。发布 npm 包后此备注将失效。

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

Trigger/触发、Thread/线程、Eval/评估、Mandate/授权、Ticket/工单、Subscription/订阅——完整定义见 [原型文档 001-domain](https://github.com/ZephyrBD/superagent-prototype-for-opencode/blob/vanilla/docs/001-domain.md)。

## 行为规范文件

- [prompts/assessor.md](prompts/assessor.md) — Eval 研判的行为规范
- [prompts/worker.md](prompts/worker.md) — worker session 的行为规范
- [prompts/shared.md](prompts/shared.md) — 所有 session 共享的原则
