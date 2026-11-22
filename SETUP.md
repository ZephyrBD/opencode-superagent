# SETUP.md — 安装剧本

> 本文件是给编码 Agent 照着执行的安装剧本。用户会说「带我安装 opencode-superagent」，Agent 按下面的步骤逐项确认后执行，**一次只问一个具体问题**，全部信息齐了再动手。

## 你（Agent）需要收集的信息

逐条问用户，每条问完再问下一条：

1. **监听哪个仓库？**（`owner/name`，例如 `ZephyrBD/my-project`）
2. **谁被允许派活？**（GitHub 登录名列表；建议先只放用户自己一个人）
3. **智能体用什么 GitHub 账号？**（该账号的登录名；它用这个账号评论、开 PR）
4. **机器人账号的 GitHub Token 是否已就绪？**（没有则指导用户生成，见下）
5. **安装范围：全局还是单个项目？**（全局 = 所有项目可用；单项目 = 只在该项目生效）

## 前置检查（安装前逐项运行并核对）

```bash
opencode --version          # 需要安装 opencode
git --version               # 需要可用的 git
pnpm --version || npm --version   # 需要一个包管理器
```

任何一项缺失，先停下并指导用户安装，再继续。

## 安装步骤

### 1. 克隆仓库并装依赖

```bash
git clone https://github.com/ZephyrBD/opencode-superagent.git <安装目录>
cd <安装目录>
pnpm install
```

推荐安装目录：`C:\Users\<用户>\.agents\opencode-superagent`（全局）或项目旁的 `tools/` 目录（单项目）。`<安装目录>` 由第 5 条回答决定。

### 2. 注册插件

- **全局**：编辑 `~/.config/opencode/opencode.json`，在 `plugins` 数组追加：

```jsonc
{
  "package": "<安装目录>",
  "options": {
    "repository": "<第 1 条回答>",
    "allowedActors": ["<第 2 条回答>"],
    "agentLogin": "<第 3 条回答>"
  }
}
```

- **单项目**：同样的对象写进该项目的 `opencode.json`。

已有字符串形式的本地路径条目时，替换为上面的对象形式（对象形式才能带 options）。

### 3. 配置 GITHUB_TOKEN

指导用户生成：GitHub → Settings → Developer settings → Personal access tokens。

- 经典 token：勾选 `repo` 与 `notifications` scope
- 或 fine-grained：对目标仓库授予 Contents、Issues、Pull requests、Notifications 读写

Token 必须属于**第 3 条回答的机器人账号**。设置方式（择一，向用户说明安全差异）：

- **更稳妥**：只在常驻 `opencode serve` 的终端里设置会话级变量：
  ```powershell
  $env:GITHUB_TOKEN = "ghp_xxx"   # PowerShell
  export GITHUB_TOKEN="ghp_xxx"   # bash
  ```
- **更省事**：设为 Windows 用户级环境变量（`setx GITHUB_TOKEN "ghp_xxx"`，重开终端生效）。注意机器上所有进程都能读到。

### 4. 常驻运行

```bash
opencode serve
```

必须在设置了 `GITHUB_TOKEN` 的终端里启动。一个常驻 serve 实例服务所有项目。

### 5. 验证

依次核对，每项通过再做下一项：

1. 日志出现加载记录：`grep "loading plugin" ~/.local/share/opencode/log/opencode.log | tail -1`
2. 面板应答：`curl http://127.0.0.1:4096/api/state` 返回 `{"attention":[],...}`
3. 在目标仓库开一个 Issue，@机器人账号说一句「请修复 xxx」，确认机器人回复并出现工单
4. 面板 `attention` 列表出现对应条目

## 故障排查

| 现象 | 处置 |
| --- | --- |
| 日志无 loading plugin | 检查 opencode.json 的路径拼写与 `pnpm install` 是否成功 |
| `git dep preparation failed`（仅 `opencode plugin add` 时出现） | 已知 bug：npm 全局安装的编译版 opencode 会用自身解释内嵌 npm。改用本文件的克隆方式，或用 node 直接跑 opencode 的 JS 入口 |
| 面板 4096 无响应 | 插件未加载或 setup 报错，查日志 `grep -i error ~/.local/share/opencode/log/opencode.log \| tail` |
| 收不到派单 | 核对 `allowedActors` 是否含发话人、消息是否 @了机器人账号、token 是否有 notifications 权限 |
| 它不该动的工单动了 | 收窄 allowedActors，或把 `proactive` 保持默认 `record` |

## 首次运行的默认行为（转告用户）

- allowed list 为空时无人能派活；`proactive` 默认 `record`——智能体只记录"本来会做什么"，不执行
- 面板 `http://127.0.0.1:4096` 只列出等待人的工单；健康状态不占版面
- 智能体只在被 @ 时行动；后续讨论在同一 Issue/聊天里进行，无需反复 @
