# MailCatcher — 账号管理 & 统一接码平台

自建的**账号管理 + 验证码接收**平台。统一管理公司大量 Claude / Codex 等账号，
并作为统一接码网关：自管邮箱走本地 IMAP，171mail 托管账号自动转发，团队在同一处接码。

## 功能

- **统一接码** — 一个入口 `/api/v1/message`，按账号来源自动分发（本地 IMAP / mail.com / 171mail 转发）
- **角色与归属** — 单服务一个团队，两级角色（admin / member）；账号按归属隔离，谁添加谁拥有，可分配给他人共用
- **自助注册** — 用 `@apexin.ai` 邮箱注册（密码二次确认），注册后即可登录，管理员再升级为 admin
- **账号来源（source）** — `self`（自管邮箱，本地取码）/ `forward`（171mail 账号，API 转发取码）
- **账号归属/分配** — 每个账号有归属人(谁添加谁拥有) + 独占/共享标志；归属人或 admin 可把账号分配给其他用户（独占号单人、共享号如 Codex 多人）
- **采购信息** — 每个账号可记购买人 + 购买状态（是否已开发票），创建/编辑时填写、列表展示
- **账号状态系统** — 健康状态（正常/异常/封禁/到期/停用）+ 状态变更审计
- **安全** — IMAP 密码与上游 token AES-256-GCM 加密存储；查询令牌存 hash、明文仅显示一次；日志脱敏
- **两种接码方式** — 账号令牌（免认证，适合 Agent）/ 邮箱 + 个人 API Key（直观，适合人工）
- **管理后台** — Web UI 管理用户、账号、服务、日志

## 快速开始

```bash
cd server
npm install
ENCRYPTION_KEY=请设置随机密钥 JWT_SECRET=请设置随机密钥 npm start
```

服务启动在 `http://localhost:3000`。**生产务必设置 `ENCRYPTION_KEY` 与 `JWT_SECRET`**（缺省会告警且不安全）。

### 默认管理员

- 用户名 `admin` / 密码 `admin123`，角色 `admin`

## 角色（单服务一个团队，账号按归属隔离）

| 角色 | 权限 |
|------|------|
| `admin` | 看/管全部账号（增删改/导入/状态/轮换/分配）、管用户（升降级 admin/member、重置密码、删除）、看日志/服务/控制台 |
| `member` | 自助添加账号(成为归属人) + 管理/取码/分配自己的账号 + 取被分配账号的码；只看到「自己添加 + 被分配给自己」的账号；不能管用户/看日志 |

注册即 `member`；管理员可在用户管理把成员升级为 `admin`（也能降级，但不能改自己以防自锁）。

## 账号来源

| source | 说明 | token | 接码路径 |
|--------|------|-------|----------|
| `self` | 自管邮箱（密码加密存） | 系统自动签发 | 本地 IMAP / mail.com Web API |
| `forward` | 171mail 账号（上游 token 加密存） | 系统自动签发 | 转发到 `b.171mail.com/api/v1/message` |

> **展示邮箱 ≠ 收件邮箱**：`self` 账号可设「收件邮箱」`fetch_address`。用于 Codex 这类——用 Outlook 邮箱订阅（展示用 Outlook），验证码转发到公司 mail.com（实际从 mail.com 取码）。多个 Outlook 共用一个 mail.com 收件箱时，按转发邮件里保留的原始 `To:` 自动区分。「收件密码」填收件邮箱的密码。

> 不论哪种来源，对外都用 **MailCatcher 自己签发的查询令牌**（库内存 hash）；171mail 的上游 token 仅作内部加密凭证。

## 接码（两种方式）

```bash
# 方式一：账号令牌（无需认证，适合脚本 / Agent）
GET /api/v1/message?token=YOUR_TOKEN&type=claude

# 方式二：邮箱 + 身份（登录 JWT 或个人 API Key，适合人工）
GET /api/v1/message?email=user@priest.com&type=claude
  Authorization: Bearer <JWT 或 API Key>
```

支持的类型：`gpt` / `claude` / `google` / `telegram` / `grok` / `chipper` / `all`。

返回示例：
```json
{ "code":200, "message":"success",
  "data":{ "code":"https://claude.ai/magic-link#...", "subject":"...", "from":"...", "date":"..." } }
```

## CLI 命令行工具

全局命令 `/usr/local/bin/mailcatcher`，适合 Agent 自动化或终端操作。

```bash
# 接码（两种）
mailcatcher code <token> claude            # 按令牌（免认证）
mailcatcher apikey                         # 先生成个人 API Key，然后：
mailcatcher code user@priest.com claude    # 按邮箱

# 管理（需 login）
mailcatcher login admin admin123
mailcatcher email add user@mail.com mypass                              # self
mailcatcher email add x@priest.com --source forward --forward-token <t> # forward
mailcatcher email list / status <id> <state> / rotate <id> / delete <id>
mailcatcher email import accounts.txt          # 文件：email----pass----appkey
mailcatcher user list / server list / log list / stats
```

配置存储在 `~/.mailcatcher.json`，支持 `MAILCATCHER_SERVER` / `MAILCATCHER_TOKEN` / `MAILCATCHER_API_KEY` 环境变量。

退出码：`0` 成功 / `1` 错误 / `2` 无新验证码。

## 使用流程

1. **注册账号**：首页「注册」→ 用 `@apexin.ai` 邮箱 + 密码二次确认完成注册，注册后即可登录（默认 `member`）。
2. **升级管理员**（admin）：在用户管理里把需要的成员升级为 admin。
3. **添加账号**：账号管理 → 添加账号，选来源 self/forward；创建后**一次性**显示查询令牌。
4. **接码**：网页登录后「在线接码」按邮箱选账号取码；或脚本用令牌/API Key 取码。

## API 文档

### 公开 / 接码

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/message?token=&type=` | 按令牌接码（免认证） |
| GET | `/api/v1/message?email=&type=` | 按邮箱接码（需 Bearer：JWT 或 API Key） |
| POST | `/api/v1/codex/send` | 触发 OpenAI/Codex 给邮箱发登录码（需登录），随后用上面接口取码 |

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/register` | 自助注册（公开，邮箱须 @apexin.ai + 密码二次确认） |
| POST | `/api/admin/login` | 登录（邮箱/用户名，大小写不敏感） |
| GET | `/api/admin/me` | 当前用户信息 |
| POST | `/api/admin/change-password` | 改密 |
| POST | `/api/admin/api-key` | 生成个人 API Key（仅显示一次） |

### 用户（仅 admin）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/user/list` | 用户列表 |
| PUT | `/api/admin/user/update` | 设角色(admin/member)/状态（不能改自己） |
| POST | `/api/admin/user/reset-password` | 重置密码 |
| DELETE | `/api/admin/user/delete/:id` | 删除用户 |

### 账号

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/email/list` | 账号列表（令牌掩码） |
| POST | `/api/admin/email/create` | 添加账号（self/forward，返回一次性令牌） |
| PUT | `/api/admin/email/update` | 编辑账号 |
| POST | `/api/admin/email/set-status` | 变更健康状态（审计） |
| POST | `/api/admin/email/grant` | 分配账号给用户（owner/admin；独占替换、共享多人） |
| POST | `/api/admin/email/revoke` | 收回某用户的分配 |
| GET | `/api/admin/user/options` | 用户下拉(id+名)，供分配用 |
| POST | `/api/admin/email/rotate-token` | 轮换查询令牌 |
| POST | `/api/admin/email/import` | 批量导入（self） |
| DELETE | `/api/admin/email/delete/:id` | 删除 |
| GET | `/api/admin/logs/email` | 查询日志（仅 admin） |
| GET | `/api/admin/stats` | 统计 |

## 技术栈

- **后端**: Node.js + Express + better-sqlite3 + imapflow + playwright-core
- **前端**: Vue 3 + Element Plus (CDN 模式，单 HTML 文件)
- **数据库**: SQLite（账号来源 + 状态系统）
- **测试**: `npm test`（内置 mock 171mail）

## 项目结构

```
cli/mailcatcher                 # CLI 工具
server/src/
├── index.js                    # Express 入口
├── db.js                       # SQLite schema（users/emails/account_status_logs/email_logs）
├── middleware/auth.js          # JWT + requireRole(admin/member) + resolvePrincipal
├── routes/                     # auth / users / emails(账号) / mailServers / message / logs / claude
└── services/
    ├── imap.js                 # 本地 IMAP/mailcom 取码（self）
    ├── mailcom.js              # mail.com Web API
    ├── forward171.js           # 171mail 转发适配器（forward）
    └── crypto.js               # AES-256-GCM 加解密 + token hash
server/test/run-tests.mjs       # 集成测试
server/public/index.html        # 完整前端 UI
```

## 注意事项

- **环境变量**: 生产必须设置 `ENCRYPTION_KEY`、`JWT_SECRET`；可选 `MAILCATCHER_DATA_DIR`、`FORWARD_171_BASE`
- **令牌一次性**: 查询令牌 / API Key 创建或轮换时明文仅显示一次，库内只存 hash
- **应用专用密码**: Gmail/Outlook 等 self 账号需使用应用专用密码
- **10 分钟窗口**: 本地 IMAP 只查询最近 10 分钟邮件
- **171mail 上游**: 偶有抖动，转发适配器已内置重试与"无邮件"归一化
