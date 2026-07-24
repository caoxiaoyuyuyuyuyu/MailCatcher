# MailCatcher 测试指南

## 自动化测试（首选）

```bash
cd server
npm install
npm test        # 运行 IMAP/网页邮箱单元测试、页面静态测试和集成测试，均无需真实邮箱
```

覆盖：加密往返 / token hash、登录与双角色(admin/member)、自助注册、forward 转发取码、
**邮箱接码 + 用户 API Key**、成员权限隔离、管理员升降级(防自锁)、健康状态机、token 轮换、删除外键、
**类型匹配 `messageMatchesType`（含转发外层发件人被改写、靠正文原始 `From:` 命中的场景）**，
以及 IMAP 批量巡检的并发上限、成功/异常/跳过统计、`fetch_address`、密码脱敏、权限隔离与页面脚本语法。

新增 `server/test/webmail-*.test.mjs` 覆盖 Gazeta/Onet 网页邮箱的 HTML 解析、登录错误分类、
Onet activation 套餐门槛和域名路由；这些测试只使用本地 fixture，不访问真实邮箱。

测试通过环境变量隔离：`MAILCATCHER_DATA_DIR`（临时库）、`FORWARD_171_BASE`（指向内置 mock）。

## 启动服务（手动测试）

```bash
cd server
ENCRYPTION_KEY=your-secret JWT_SECRET=your-jwt npm start   # http://localhost:3000
```

### Gazeta/Onet 真实账号只读冒烟

`@gazeta.pl` 的 `self` 账号通过 Chromium 网页邮箱取码；`@onet.pl` 默认通过官方 IMAP
`imap.poczta.onet.pl:993`（SSL）取码，不依赖网页 reCAPTCHA。需要网页模式时设置
`ONET_ACCESS_MODE=webmail`，并保证运行环境有 Chrome（或设置 `CHROME_PATH`）；可用
`WEBMAIL_SCAN_LIMIT` 调整扫描数量，默认 15。Onet 账号若停在 “Wybierz plan” 套餐页，先由账号持有人
完成免费的邮箱服务启用；自动化不会替你同意营销授权、选择套餐或付费。验证码挑战/二步验证会返回稳定的
“需要额外验证，暂不支持自动取码”错误。

真实冒烟只在本地手动执行：运行时输入账号密码，确认返回邮件或 `activation`/`challenge`/`credentials`
错误即可；不要把密码、Cookie、完整响应或真实验证码保存到仓库。真实账号不可作为 `npm test` 的依赖。

## API 测试

### 0. 自助注册（公开，邮箱须 @apexin.ai）

```bash
curl -X POST http://localhost:3000/api/admin/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@apexin.ai","password":"secret1","confirmPassword":"secret1"}'
# 成功 → { code:200 }；非 @apexin.ai / 两次密码不一致 / 重复邮箱 / 密码<6位 → { code:400 }
# 注册即 member；注册后可用该邮箱登录（大小写不敏感）
```

### 1. 登录（默认管理员）

```bash
curl -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# → { code:200, data:{ accessToken, id, role:"admin" } }
```

### 2. 用户管理（仅 admin）

```bash
# 把注册用户升级为管理员（或降级，状态停用）；不能改自己
curl -X PUT http://localhost:3000/api/admin/user/update \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":2,"role":"admin"}'
# 重置密码 / 删除
curl -X POST http://localhost:3000/api/admin/user/reset-password \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":2,"newPassword":"newpass"}'
```

### 3. 添加账号（两种来源）

```bash
# self：自管邮箱（密码加密存）
curl -X POST http://localhost:3000/api/admin/email/create \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"address":"test@example.com","source":"self","password":"app-password"}'
# forward：171mail 账号（上游 token 加密存）
curl -X POST http://localhost:3000/api/admin/email/create \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"address":"x@priest.com","source":"forward","forward_token":"<171mail token>"}'
# → 返回 { data:{ id, token } }，token 明文仅此一次！
```

### 4. 接码（两种方式）

```bash
# 方式一：账号令牌（无需认证）
curl "http://localhost:3000/api/v1/message?token=OUR_TOKEN&type=claude"

# 方式二：邮箱 + 身份（登录 JWT 或个人 API Key）
curl -H "Authorization: Bearer $TOKEN_OR_APIKEY" \
  "http://localhost:3000/api/v1/message?email=x@priest.com&type=claude"
```

预期：
- 成功: `{code:200, message:"success", data:{code, subject, from, date}}`
- 无新邮件: `{code:200, message:"no new message"}`
- 令牌无效: `{code:401}`；账号封禁/停用: `{code:403}`
- 按邮箱无身份: `{code:401}`；账号封禁/停用: `{code:403}`

### 5. 个人 API Key

```bash
curl -X POST http://localhost:3000/api/admin/api-key -H "Authorization: Bearer $TOKEN"
# → { data:{ apiKey } }（仅此一次）；之后可用 apiKey 按邮箱接码
```

### 6. 状态机 / 分配 / 轮换

```bash
curl -X POST http://localhost:3000/api/admin/email/set-status \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":1,"health_status":"banned","reason":"被封"}'      # 记入审计
# 分配账号给用户(owner 或 admin)：独占号替换单人，共享号(shared=1)可多人
curl -X POST http://localhost:3000/api/admin/email/grant \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":1,"user_id":3}'
curl -X POST http://localhost:3000/api/admin/email/revoke \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":1,"user_id":3}'
curl -X POST http://localhost:3000/api/admin/email/rotate-token \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":1}'
```

### 7. IMAP 批量巡检

```bash
# 只巡检指定账号
curl -X POST http://localhost:3000/api/admin/email/inspect-imap \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ids":[1,2]}'

# 巡检当前用户有权查看的全部账号（单次最多 200 个）
curl -X POST http://localhost:3000/api/admin/email/inspect-imap \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

预期：返回 `total/success/failed/skipped/duration_ms/results`。`success` 表示可以登录 IMAP 并打开
`INBOX`；错误项不得包含明文密码或数据库密文。`forward`、未配密码和通过 Webmail/API 收件的账号应为
`skipped`。member 只能得到自己拥有或被分配账号的巡检结果。巡检不发送邮件，也不修改健康状态。

## CLI 测试

```bash
mailcatcher login admin admin123
mailcatcher apikey                                  # 生成个人 API Key
mailcatcher email add x@priest.com --source forward --forward-token <t>
mailcatcher code <token> claude                     # 按令牌
mailcatcher code x@priest.com claude                # 按邮箱（用 API Key）
mailcatcher email list / user list
mailcatcher email status 1 banned / email rotate 1
```

## Web 界面测试

1. 打开 http://localhost:3000 → 「在线接码」：登录后可"按邮箱"选账号取码；或"按令牌"。
2. 「管理登录」admin / admin123。
3. 账号管理：来源(self/forward)切换、独占/共享(shared)切换、状态变更、分配/收回(grant/revoke)、token 轮换、批量导入(self)。
4. IMAP 巡检：勾选 1–2 个 self 账号后巡检，再清空勾选巡检全部；核对正常/异常/跳过之和等于总计，失败账号显示脱敏原因，账号健康状态保持不变。
5. 用户管理（admin：升降级角色/重置密码/删除）、个人(API Key/改密)、服务配置、查询日志。
6. 验证归属：member 登录后只见「在线接码 + 账号管理」，账号页只看到「自己添加 + 被分配给自己」的账号，可对自己的账号增删改/分配，看不到别人的，不能访问用户/日志接口。
