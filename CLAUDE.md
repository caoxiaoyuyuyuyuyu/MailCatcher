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

- **后端**: Node.js + Express + Knex.js（支持 SQLite/PostgreSQL 双后端）+ imapflow + playwright-core
- **前端**: Vue 3 + Element Plus (CDN 模式，单 HTML 文件)
- **单团队 + 两级角色**: 一个服务一个团队；users 仅 `admin` / `member`。账号**按归属隔离**：任何登录用户都能自助添加账号（成为 `created_by` 归属人），只看到「自己添加的 + 被分配给自己的」；admin 看全部、管用户。管理员可升降级他人
- **账号归属/分配**: 每个账号有归属人 `created_by` 和共享标志 `shared`(0=独占,如 Claude 单人；1=共享,如 Codex 多人)。归属人或 admin 可把账号**分配**给其他用户(`account_grants` 表，独占账号再分配会替换原有单人，共享账号可多人)。能「使用」(浏览/取码)= admin/owner/被授予；能「管理」(改删/轮换/状态/分配)= admin/owner
- **采购信息**: 每个账号可记 `purchaser`(购买人) 与 `invoiced`(购买状态：0=未开发票 1=已开发票)，在创建/编辑账号时填，列表展示；owner 或 admin 可改
- **账号来源(source)**:
  - `self` — 自管邮箱，本地 IMAP/mailcom 取码（密码 AES-GCM 加密存）；可设 `fetch_address`(实际收件邮箱)与展示 `address` 分离——如 Codex 用 Outlook 订阅(展示)、验证码转发到公司 mail.com(收件)，取码时按转发邮件正文里的 `To:<原 Outlook>` 过滤区分
  - `forward` — 171mail 账号，转发到 `b.171mail.com/api/v1/message`（上游 token 加密存）
- **IMAP 批量巡检**: 登录用户可巡检有权查看的指定或全部账号（最多 200 个）；前端保持最多 5 个逐账号请求并实时显示已检查/剩余数量，后端验证 IMAP 登录与 `INBOX` 访问，统计正常/异常/跳过，错误脱敏且不自动修改健康状态。非 IMAP 收件路径标记为跳过
- **App Key（外部系统接入）**: 管理员可创建 App Key（`ak_xxx` + `sk_xxx`），外部系统通过 `Authorization: Bearer ak:sk` 调用 API 接码。每个 App Key 可配账号范围、状态(active/disabled)，支持轮换。`app_keys` 表存 hash，明文仅创建/轮换时返回一次
- **统一接码**: `GET /api/v1/message?token=&type=` 同步取码（兼容）；`POST /api/v1/message/async` 异步取码返回 `taskId`，`GET /api/v1/message/task/:taskId` 轮询结果。所有取码通过 BullMQ + Redis 队列处理，支持高并发和 worker 水平扩展
- **状态系统**: 健康轴 `health_status`(active/error/banned/expired/disabled) + 归属/分配轴(`created_by` + `account_grants`)，
  变更记 `account_status_logs`；连续取码失败自动标 error
- **核心流程**: 认证 → 查账号 → BullMQ 入队 → Worker 按 source 走本地/转发 → 提取验证码
- **启动**: `cd server && npm start` → `http://localhost:3000`
- **测试**: `cd server && npm test`
- **默认管理员**: admin / admin123（角色 `admin`）

### 关键路径

- `cli/mailcatcher` — CLI 工具（全局 `/usr/local/bin/mailcatcher`）
- `server/src/services/imap.js` — IMAP 连接和验证码提取核心（self 账号）
- `server/src/services/imapInspection.js` — IMAP 批量巡检（限并发、汇总、错误脱敏）
- `server/src/services/mailcom.js` — mail.com Web API 抓取（self 账号）
- `server/src/services/webmailBrowser.js` — Chromium 会话、通用网页邮箱 HTML/链接解析与安全错误
- `server/src/services/gazeta.js` / `server/src/services/onet.js` — Gazeta/Onet 网页登录与收件箱适配器
- `server/src/services/forward171.js` — 171mail 转发适配器（forward 账号）
- `server/src/services/crypto.js` — AES-256-GCM 加解密 + token hash（方案乙）
- `server/src/middleware/auth.js` — JWT + requireRole(admin/member) + resolvePrincipal + resolveAppKey + resolveIdentity
- `server/src/services/queue.js` — BullMQ 取码队列 + Worker（Redis 驱动，并发可配 `FETCH_CONCURRENCY`）
- `server/src/routes/message.js` — 接码 API：同步 `GET /message`、异步 `POST /message/async`、轮询 `GET /message/task/:id`
- `server/src/services/codexLogin.js` + `routes/codex.js` — 触发 OpenAI/Codex 邮箱 OTP 登录发码（`POST /api/v1/codex/send`）
- `server/src/routes/emails.js` — 账号 CRUD（source/状态机/归属/分配 grant·revoke/token 轮换/购买人 `purchaser`+发票状态 `invoiced`/批量 IMAP 巡检；列表和巡检均按归属过滤，增删改/分配限 owner 或 admin）
- `server/src/routes/users.js` — 用户管理（admin 升降级/重置/删除；防自锁）；`GET /options`(任何登录用户) 供分配下拉用
- `server/src/routes/appKeys.js` — App Key CRUD（admin 创建/编辑/轮换/删除，外部系统凭证管理）
- `server/src/routes/mailServers.js` — IMAP 服务器配置
- `server/src/db.js` — Knex 初始化 + schema 管理（支持 SQLite/PostgreSQL 双后端，`DB_BACKEND` 环境变量切换）
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
- IMAP/mail.com 查询默认回溯最近 30 分钟的邮件（转发有延迟，`FETCH_LOOKBACK_MINUTES` 可调）
- **转发发件人匹配**：转发邮件外层 `from` 会被改写成转发者地址，导致按发件人的类型过滤失效。`imap.js` 的 `messageMatchesType` 同时在 `from + subject + body` 里找已知发件地址（转发正文通常保留原始 `From:`），转发/直收都能命中
- **数据库**：默认 SQLite（`DB_BACKEND=sqlite`），可切换 PostgreSQL（`DB_BACKEND=postgres`）。PG 配置通过 `DATABASE_URL` 或 `PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE`
- **App Key 外部接入**：管理员在「App Key」页创建凭证；外部系统用 `Authorization: Bearer ak_xxx:sk_xxx` 调接码 API（`/api/v1/message?email=xxx&type=gpt`）。可配账号范围（全部/指定 ID），支持启用/禁用/轮换
- **环境变量**：生产必须设置 `ENCRYPTION_KEY`（加密 IMAP 密码/171mail token）与 `JWT_SECRET`；缺省会告警
- **账号来源**：`source=self` 走本地 IMAP/mailcom；Onet 默认使用 `imap.poczta.onet.pl:993`（SSL）；`source=forward` 转发到 171mail（密文存上游 token）
- **Gazeta/Onet self**：`@gazeta.pl` 走 Chromium 网页邮箱；`@onet.pl` 默认走官方 IMAP，可用 `ONET_ACCESS_MODE=webmail` 强制网页模式。Onet 必须先在官方页面完成服务启用；网页模式遇到验证码挑战/二步验证返回 challenge 错误，不自动绕过
- **IMAP 巡检口径**：`POST /api/admin/email/inspect-imap` 只验证 IMAP 登录并打开 `INBOX`，不发探测邮件、不自动改 `health_status`；默认并发 5、单账号超时 20 秒，单批最多 200 个
- **方案乙**：所有账号对外都用我方签发的 token（库内存 hash，创建/轮换时明文仅显示一次）
- **默认管理员**：admin / admin123，角色 `admin`（旧库 super_admin/team_admin 启动时自动迁移为 admin）
- **自助注册**：`POST /api/admin/register`（公开），邮箱须 `@apexin.ai` 后缀 + 密码二次确认（≥6 位）；注册即 `member`，登录后由管理员在用户管理升级为 admin。邮箱登录大小写不敏感
- **前端导航按角色显隐**：member 只见「在线接码 + 账号管理」（登录落地账号管理）；admin 另见控制台/用户管理/App Key/服务配置/查询日志/个人。账号页：任何人都能加账号/导入/删自己的；每行按 `can_manage` 显示编辑/状态/分配/删除按钮；「分配」弹窗按 `/api/admin/user/options` 选用户，调 `grant`/`revoke`
- **Codex 登录触发**：`POST /api/v1/codex/send`（需登录）用无头浏览器在 chatgpt.com 提交邮箱 → OpenAI 给该邮箱发「临时登录代码」（纯邮箱 OTP、无需密码、实测未遇验证码拦截）；再配合 self+`fetch_address` 转发收件箱把码取回。前端「在线接码」邮箱模式有「发送 Codex 登录码并自动取码」一键按钮。⚠ 依赖 OpenAI 登录页结构，可能随其改版/加强风控而失效
- **可配置**：`MAILCATCHER_DATA_DIR`（DB 目录）、`FORWARD_171_BASE`（171mail 地址，测试用）、`REGISTER_EMAIL_SUFFIX`（注册邮箱后缀，默认 `@apexin.ai`）、`DB_BACKEND`（`sqlite` 或 `postgres`）、`DATABASE_URL`（PostgreSQL 连接串）、`REDIS_URL`（Redis 地址，默认 `redis://127.0.0.1:6379`）、`FETCH_CONCURRENCY`（Worker 并发数，默认 20）、`FETCH_LOOKBACK_MINUTES`（取码回溯时间窗，默认 30）、`MAILCOM_SCAN_LIMIT`（mail.com 每次扫描邮件数，默认 15）、`CHROME_PATH`（网页邮箱 Chromium 路径，默认 `/usr/bin/google-chrome`）、`WEBMAIL_SCAN_LIMIT`（Gazeta/Onet 每次扫描邮件数，默认 15）、`ONET_ACCESS_MODE=webmail`（可选，强制 Onet 网页模式）、`IMAP_INSPECTION_CONCURRENCY`（巡检并发，默认 5、最高 10）、`IMAP_INSPECTION_TIMEOUT_MS`（单账号超时毫秒数，默认 20000）
