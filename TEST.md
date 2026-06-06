# MailCatcher 测试指南

## 启动服务

```bash
cd server
npm install
npm start
```

## API 测试

### 1. 管理员登录

```bash
curl -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

预期：返回 `code: 200` 和 `accessToken`

### 2. 添加邮件服务器

```bash
curl -X POST http://localhost:3000/api/admin/mail-server/create \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"domain":"priest.com","host":"imap.mail.com","port":993,"use_ssl":1}'
```

### 3. 添加邮箱

```bash
curl -X POST http://localhost:3000/api/admin/email/create \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"address":"test@example.com","password":"password123"}'
```

### 4. 获取验证码

```bash
curl "http://localhost:3000/api/v1/message?token=YOUR_TOKEN&type=gpt"
```

预期结果：
- 成功: `{code: 200, data: {code: "123456", ...}}`
- 无新邮件: `{code: 200, message: "no new message"}`
- 令牌无效: `{code: 401, message: "无效的令牌"}`
- IMAP 认证失败: `{code: 500, message: "IMAP 认证失败..."}`

### 5. 测试 IMAP 连接

```bash
curl -X POST http://localhost:3000/api/admin/email/test-connection \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"address":"test@example.com","password":"password123"}'
```

### 6. 批量导入

```bash
curl -X POST http://localhost:3000/api/admin/email/import \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"emails":["user1@mail.com----pass1","user2@mail.com----pass2"]}'
```

## Web 界面测试

1. 打开 http://localhost:3000
2. 首页：输入令牌 → 选类型 → 获取验证码
3. 点击"管理登录" → admin / admin123
4. 控制台：查看统计数据
5. 邮箱管理：添加/编辑/删除/导入/测试连接
6. 服务配置：添加/编辑/删除 IMAP 服务器
7. 查询日志：查看历史查询记录
