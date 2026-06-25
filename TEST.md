# MailCatcher 测试指南

## 自动化测试（首选）

```bash
cd server
npm install
npm test        # 内置 mock 171mail，确定性运行；当前 31 项断言全绿
```

覆盖：加密往返 / token hash、登录与三级角色、团队与用户 CRUD、forward 转发取码、
**邮箱接码 + 用户 API Key**、列表脱敏、健康状态机、token 轮换、团队隔离、角色门禁、stats 过滤。

测试通过环境变量隔离：`MAILCATCHER_DATA_DIR`（临时库）、`FORWARD_171_BASE`（指向内置 mock）。

## 启动服务（手动测试）

```bash
cd server
ENCRYPTION_KEY=your-secret JWT_SECRET=your-jwt npm start   # http://localhost:3000
```

## API 测试

### 1. 登录（默认 super_admin）

```bash
curl -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
# → { code:200, data:{ accessToken, id, role:"super_admin", team_id, team_name } }
```

### 2. 团队与用户

```bash
# 建团队
curl -X POST http://localhost:3000/api/admin/team/create \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"研发一组"}'
# 建用户（team_admin / member）
curl -X POST http://localhost:3000/api/admin/user/create \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"pass","role":"team_admin","team_id":2}'
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
- 按邮箱无身份: `{code:401}`；跨团队: `{code:403}`

### 5. 个人 API Key

```bash
curl -X POST http://localhost:3000/api/admin/api-key -H "Authorization: Bearer $TOKEN"
# → { data:{ apiKey } }（仅此一次）；之后可用 apiKey 按邮箱接码
```

### 6. 状态机 / 领用 / 轮换

```bash
curl -X POST http://localhost:3000/api/admin/email/set-status \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":1,"health_status":"banned","reason":"被封"}'      # 记入审计
curl -X POST http://localhost:3000/api/admin/email/assign \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":1,"assignee_id":3}'
curl -X POST http://localhost:3000/api/admin/email/rotate-token \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"id":1}'
```

## CLI 测试

```bash
mailcatcher login admin admin123
mailcatcher apikey                                  # 生成个人 API Key
mailcatcher email add x@priest.com --source forward --forward-token <t>
mailcatcher code <token> claude                     # 按令牌
mailcatcher code x@priest.com claude                # 按邮箱（用 API Key）
mailcatcher email list / team list / user list
mailcatcher email status 1 banned / email rotate 1
```

## Web 界面测试

1. 打开 http://localhost:3000 → 「在线接码」：登录后可"按邮箱"选账号取码；或"按令牌"。
2. 「管理登录」admin / admin123。
3. 账号管理：来源(self/forward)切换、状态变更、领用/释放、token 轮换、批量导入(self)。
4. 团队管理（super_admin）、用户管理（admin）、个人(API Key/改密)、服务配置、查询日志。
5. 验证隔离：team_admin/member 登录后只能看到本团队账号与日志。
