# MailCatcher — 项目指南

> **重要：Claude 必须自主维护本文件。** 架构或约定变化时更新，保持简洁。

## Git 信息

- Remote: `origin` → github.com/caoxiaoyuyuyuyuyu/MailCatcher.git
- 默认分支: main
- 有 remote，按任务生命周期「有 remote」分支执行（merge/push 前需经用户 review）

## 任务生命周期

你收到任务后，按以下 9 步流程自主完成：

1. **领取任务** — 你已被分配任务，阅读本文件和项目代码理解上下文
2. **创建工作区**:
   - `git fetch origin`（如有 remote）
   - `git worktree add -b task-<简短描述> .claude-manager/worktrees/task-<简短描述> origin/main`
   - 进入 worktree 目录工作（后续所有操作在 worktree 中）
   - 如果 worktree 创建失败，直接在当前分支工作
3. **实现功能** — 编写代码，确保可运行
4. **提交代码** — `git add` + `git commit`，commit message 简洁描述改动
5. **Merge + 测试**:
   - `git fetch origin && git merge origin/main`（集成最新代码，如有 remote）
   - 运行测试（如有测试命令）
6. **自动合并到 main**（如有 remote）:
   - `git fetch origin main`
   - `git rebase origin/main`，如果冲突则自行 resolve
   - 如果成功：`git checkout main && git merge <task-branch> && git push origin main`
   - 如果这一步有任何失败，退回到步骤 5 重试
   - （纯本地项目跳过本步）
7. **标记完成** — 更新文档（必须在清理之前，防止进程被杀时状态丢失）
8. **清理** — 回到项目根目录:
   - `git worktree remove .claude-manager/worktrees/<worktree名>`
   - `git branch -D <task-branch>`
   - 如有 remote: `git push origin --delete <task-branch>`
9. **经验沉淀** — 在 PROGRESS.md 记录经验教训（可选）

### 冲突处理

rebase 发生冲突时：
1. 查看冲突文件: `git diff --name-only --diff-filter=U`
2. 逐个解决冲突
3. `git add <resolved-files> && git rebase --continue`
4. 如果无法解决: `git rebase --abort`，退回步骤 5

### 状态判断

- 通过 `git remote -v` 判断是否有 remote
- 有 remote → 必须完成步骤 6（merge + push）
- 无 remote → 跳过步骤 5 的 fetch、步骤 6 和步骤 8 的远程分支删除

## 文件维护规则

> **以下文件都由 Claude Code 自主维护，每次功能变更后必须同步更新。**

- **CLAUDE.md**（本文件）：架构、约定、关键路径变化时更新，只改变化的部分，保持简洁
- **README.md**：面向用户的文档，功能、使用流程变化时同步更新，保持与实际代码一致
- **TEST.md**：测试指南，新增功能时同步添加测试用例和文档
- **PROGRESS.md**：见下方「经验教训沉淀」

## 测试规范

**开发时必须主动使用测试，不是事后补充！**

- **改代码前**：先跑测试，确认基线全绿
- **改代码后**：再跑一遍确认无回归
- **新增功能**：同步新增测试用例，更新 TEST.md
- **修 bug**：先写复现 bug 的测试（红），修复后确认变绿

## 经验教训沉淀

每次遇到问题或完成重要改动后，要在 PROGRESS.md 中记录：
- 遇到了什么问题
- 如何解决的
- 以后如何避免
- **必须附上 git commit ID**

**同样的问题不要犯两次！**

## 架构概览

MailCatcher 已从「纯接码工具」演进为「**多租户账号管理 + 统一接码网关**」。

- **后端**: Node.js + Express + SQLite (better-sqlite3) + imapflow + playwright-core
- **前端**: Vue 3 + Element Plus (CDN 模式，单 HTML 文件)
- **单团队 + 两级角色**: 一个服务一个团队；users 仅 `admin` / `member`。账号池全局共享（无团队隔离），管理员管账号/用户，成员只浏览+取码+(独占)自助领用；管理员可升降级他人
- **账号来源(source)**:
  - `self` — 自管邮箱，本地 IMAP/mailcom 取码（密码 AES-GCM 加密存）
  - `forward` — 171mail 账号，转发到 `b.171mail.com/api/v1/message`（上游 token 加密存）
- **统一接码**: `GET /api/v1/message?token=&type=` 按 source 分发；对外只认我方签发 token(存 hash)
- **状态系统**: 健康轴 `health_status`(active/error/banned/expired/disabled) + 占用轴 `assignee_id`，
  变更记 `account_status_logs`；连续取码失败自动标 error
- **核心流程**: 我方 token → token_hash 查账号 → 按 source 走本地/转发 → 提取验证码
- **启动**: `cd server && npm start` → `http://localhost:3000`
- **测试**: `cd server && npm test`
- **默认管理员**: admin / admin123（角色 `admin`）

### 关键路径

- `cli/mailcatcher` — CLI 工具（全局 `/usr/local/bin/mailcatcher`）
- `server/src/services/imap.js` — IMAP 连接和验证码提取核心（self 账号）
- `server/src/services/mailcom.js` — mail.com Web API 抓取（self 账号）
- `server/src/services/forward171.js` — 171mail 转发适配器（forward 账号）
- `server/src/services/crypto.js` — AES-256-GCM 加解密 + token hash（方案乙）
- `server/src/middleware/auth.js` — JWT + requireRole(admin/member) + resolvePrincipal
- `server/src/routes/message.js` — 接码 API (`/api/v1/message`)，按 source 分发本地/转发
- `server/src/routes/emails.js` — 账号 CRUD（source/状态机/领用/token 轮换；增删改仅 admin）
- `server/src/routes/users.js` — 用户管理（admin 升降级/重置/删除；防自锁）
- `server/src/routes/mailServers.js` — IMAP 服务器配置
- `server/src/db.js` — SQLite schema（账号来源 + 状态系统）
- `server/test/run-tests.mjs` — 集成测试（内置 mock171），`npm test`
- `server/public/index.html` — 完整前端 UI

### CLI 使用

```bash
mailcatcher code <token> [type]         # 获取验证码（无需认证）
mailcatcher login admin admin123        # 管理员登录
mailcatcher email list / add / delete   # 邮箱管理
mailcatcher server list / add / delete  # 服务器配置
mailcatcher log list / clear            # 日志管理
```

配置存储在 `~/.mailcatcher.json`，支持 `MAILCATCHER_SERVER` / `MAILCATCHER_TOKEN` 环境变量。

## 注意事项

- 在 worktree 中工作时，不要切换到其他分支
- 完成任务后确保代码可运行、测试通过（`cd server && npm test`）
- Gmail/Outlook 等需要应用专用密码，不能用登录密码
- IMAP 查询只搜索最近 10 分钟的邮件
- **环境变量**：生产必须设置 `ENCRYPTION_KEY`（加密 IMAP 密码/171mail token）与 `JWT_SECRET`；缺省会告警
- **账号来源**：`source=self` 走本地 IMAP/mailcom；`source=forward` 转发到 171mail（密文存上游 token）
- **方案乙**：所有账号对外都用我方签发的 token（库内存 hash，创建/轮换时明文仅显示一次）
- **默认管理员**：admin / admin123，角色 `admin`（旧库 super_admin/team_admin 启动时自动迁移为 admin）
- **自助注册**：`POST /api/admin/register`（公开），邮箱须 `@apexin.ai` 后缀 + 密码二次确认（≥6 位）；注册即 `member`，登录后由管理员在用户管理升级为 admin。邮箱登录大小写不敏感
- **前端导航按角色显隐**：member 只见「在线接码 + 账号管理」（登录落地账号管理，且账号页无增删改按钮）；admin 另见控制台/用户管理/服务配置/查询日志/个人
- **可配置**：`MAILCATCHER_DATA_DIR`（DB 目录）、`FORWARD_171_BASE`（171mail 地址，测试用）、`REGISTER_EMAIL_SUFFIX`（注册邮箱后缀，默认 `@apexin.ai`）
