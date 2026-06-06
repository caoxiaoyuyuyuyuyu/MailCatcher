# MailCatcher — 邮件接码平台

自建邮件验证码接收服务，通过 IMAP 协议自动获取邮箱中的验证码。

## 功能

- **在线接码** — 通过 Token + 类型查询邮箱中最近 10 分钟的验证码
- **邮箱管理** — 添加/导入/编辑/删除邮箱账号，自动生成查询令牌
- **服务配置** — 配置不同域名的 IMAP 服务器地址
- **查询日志** — 记录每次验证码查询的结果
- **管理后台** — Web UI 管理所有配置

## 快速开始

```bash
cd server
npm install
npm start
```

服务启动在 `http://localhost:3000`

### 默认管理员

- 用户名: `admin`
- 密码: `admin123`

## CLI 命令行工具

全局可用的命令行工具，适合 Agent 自动化或终端操作。

### 安装

CLI 已安装到 `/usr/local/bin/mailcatcher`，全局可用。

### 核心命令（无需认证）

```bash
# 获取验证码 — 直接输出 code 到 stdout，适合脚本和 Agent 使用
mailcatcher code <token> [type]

# 示例
mailcatcher code 864305e9eb314d05bed1793ebc386a88 claude
# → https://claude.ai/magic-link#1e87fa39...

# JSON 模式（含完整信息）
mailcatcher code <token> claude --json
```

### 管理命令（需要先 login）

```bash
# 登录（token 自动保存到 ~/.mailcatcher.json）
mailcatcher login admin admin123

# 查看统计
mailcatcher stats

# 邮箱管理
mailcatcher email list
mailcatcher email add user@mail.com password123
mailcatcher email delete 1
mailcatcher email import accounts.txt       # 文件：email----pass----appkey
echo "a@b.com----pass" | mailcatcher email import -  # stdin

# 服务器配置
mailcatcher server list
mailcatcher server add example.com imap.example.com --port 993

# 查询日志
mailcatcher log list
mailcatcher log clear
```

### 配置

```bash
mailcatcher config                          # 查看当前配置
mailcatcher config server http://localhost:3100  # 设置服务器地址
```

也可通过环境变量覆盖：`MAILCATCHER_SERVER`、`MAILCATCHER_TOKEN`

### 退出码

- `0` — 成功
- `1` — 错误（认证失败、参数错误等）
- `2` — 无新验证码（10 分钟内无新邮件）

## 使用流程

### 1. 配置邮件服务器（可选）

系统内置了主流邮箱服务商的 IMAP 配置（Gmail、Outlook、QQ、163 等）。如果需要添加自定义域名，在管理后台 → 服务配置中添加。

### 2. 添加邮箱

管理后台 → 邮箱管理 → 添加邮箱：
- 邮箱地址和密码（IMAP 密码/应用专用密码）
- 系统自动生成查询令牌（Token）

支持批量导入，格式：`邮箱----密码----应用密钥`（每行一个）

### 3. 获取验证码

**Web 界面**: 访问首页，输入令牌和项目类型，点击获取

**API 调用**:
```
GET /api/v1/message?token=YOUR_TOKEN&type=gpt
```

支持的类型：`gpt` / `claude` / `google` / `telegram` / `grok` / `all`

返回示例：
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "code": "123456",
    "subject": "Your verification code",
    "body": "...",
    "from": "noreply@openai.com",
    "date": "2026-06-06T10:00:00.000Z"
  }
}
```

## API 文档

### 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/message?token=&type=` | 获取验证码 |

### 管理接口（需要 Bearer Token）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/email/list` | 邮箱列表 |
| POST | `/api/admin/email/create` | 添加邮箱 |
| PUT | `/api/admin/email/update` | 编辑邮箱 |
| DELETE | `/api/admin/email/delete/:id` | 删除邮箱 |
| POST | `/api/admin/email/import` | 批量导入 |
| POST | `/api/admin/email/test-connection` | 测试 IMAP 连接 |
| GET | `/api/admin/mail-server/list` | 服务器列表 |
| POST | `/api/admin/mail-server/create` | 添加服务器 |
| PUT | `/api/admin/mail-server/update` | 编辑服务器 |
| DELETE | `/api/admin/mail-server/delete/:id` | 删除服务器 |
| GET | `/api/admin/logs/email` | 查询日志 |
| POST | `/api/admin/logs/email/clear` | 清空日志 |
| GET | `/api/admin/stats` | 统计数据 |

## 技术栈

- **后端**: Node.js + Express + better-sqlite3 + imapflow
- **前端**: Vue 3 + Element Plus (CDN 模式)
- **数据库**: SQLite

## 项目结构

```
cli/
└── mailcatcher              # CLI 工具（全局 /usr/local/bin/mailcatcher）
server/
├── package.json
├── data/                    # SQLite 数据库（自动创建）
├── public/
│   └── index.html           # 前端页面
└── src/
    ├── index.js             # Express 入口
    ├── db.js                # 数据库初始化
    ├── middleware/
    │   └── auth.js          # JWT 认证
    ├── routes/
    │   ├── auth.js          # 登录/改密
    │   ├── emails.js        # 邮箱管理
    │   ├── mailServers.js   # 服务器管理
    │   ├── message.js       # 验证码查询（核心）
    │   └── logs.js          # 日志管理
    └── services/
        ├── imap.js          # IMAP 连接与验证码提取
        └── mailcom.js       # mail.com Web API 抓取
```

## 注意事项

- **应用专用密码**: Gmail/Outlook 等需要使用应用专用密码而非登录密码
- **IMAP 访问**: 某些邮箱需要手动开启 IMAP 功能
- **10 分钟窗口**: 只查询最近 10 分钟的邮件，超时无效
- **生产部署**: 请修改 `JWT_SECRET` 环境变量和管理员密码
