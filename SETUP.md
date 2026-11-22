# SETUP.md — 安装剧本（lite 分支）

> 本文件是给编码 Agent 照着执行的安装剧本。用户会说「带我安装 opencode-superagent-lite」（完整提示词见本仓库 README：克隆仓库、切换到 lite 分支、阅读本文件），Agent 按下面的步骤逐项确认后执行，**一次只问一个具体问题**，全部信息齐了再动手。

## 你（Agent）需要收集的信息

逐条问用户，每条问完再问下一条：

1. **安装范围：全局还是单个项目？**（全局 = 所有项目可用；单项目 = 只在该项目生效）
2. **并发槽位 `workerLimit` 用默认 3 还是调整？**（同时运行的 worker session 上限；不确定就用默认，此项可跳过）

lite 分支没有其他配置：Source 就是本会话，无需 GitHub Token、无需监听仓库。

## 前置检查（安装前逐项运行并核对）

```bash
opencode --version          # 需要安装 opencode
git --version               # 需要可用的 git
pnpm --version || npm --version   # 需要一个包管理器
```

任何一项缺失，先停下并指导用户安装，再继续。

## 安装步骤

### 1. 克隆仓库并切到 lite 分支

```bash
git clone https://github.com/ZephyrBD/opencode-superagent.git <安装目录>
cd <安装目录>
git switch lite
pnpm install
```

推荐安装目录：`C:\Users\<用户>\.agents\opencode-superagent`（全局）或项目旁的 `tools/` 目录（单项目）。`<安装目录>` 由第 1 条回答决定。

可选验证：`pnpm check`（typecheck + 17 个测试）。

### 2. 注册插件

- **全局**：编辑 `~/.config/opencode/opencode.json`，在 `plugins` 数组追加：

```jsonc
{
  "package": "<安装目录>",
  "options": { "workerLimit": 3 }
}
```

- **单项目**：同样的对象写进该项目的 `opencode.json`。
- 不需要 `workerLimit` 调整时，直接用字符串形式 `{ "plugins": ["<安装目录>"] }` 即可。

已有指向本仓库的字符串条目时，替换为对象形式（对象形式才能带 options）。

### 3. 重启服务

```bash
opencode service restart
```

插件加载不需要常驻 `opencode serve`：lite 的 Source 是用户自己的会话，在普通 TUI 会话里即可使用。

## 验证

依次核对，每项通过再做下一项：

1. 日志出现加载记录：`grep "loading plugin" ~/.local/share/opencode/log/opencode.log | tail -1`
2. 在 OpenCode 会话输入 `/work 在当前目录创建 hello.txt，内容为 hello`——出现一个 worker session（标题 `worker-t1`）开始执行
3. worker 完成后用 `superagent_tickets` 查询，工单 `t1` 应为 `ended (completed)`
4. 输入 `/work #t1 再把内容改成 world`——说明直接送达工单 t1 的 worker，不产生新工单

## 故障排查

| 现象 | 处置 |
| --- | --- |
| 日志无 loading plugin | 检查 opencode.json 的路径拼写、是否忘了 `git switch lite`、`pnpm install` 是否成功 |
| `/work` 无反应 | 插件未加载：查日志 `grep -i error ~/.local/share/opencode/log/opencode.log | tail`，并确认重启过服务 |
| worker 一直不动 | 并发槽位满了（默认 3）：用 `superagent_stop_ticket` 停掉不需要的工单，或在 options 调大 `workerLimit` |
| `#t3` 开了新工单 | 该工单不存在或已被停止；引用必须指向未 stopped 的工单 |

## 首次运行的默认行为（转告用户）

- 操作者的 `/work` 指令总是 explicit 接单——lite 没有 inferred/主动工作，不会做任何没被请求的事
- 每个工单有独立 worker session 和 git worktree；`blocked` 报告会挂起工单等待人的回答
- 停止工单（`superagent_stop_ticket`）后它不可被 resume
