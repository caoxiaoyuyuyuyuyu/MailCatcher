# Gazeta/Onet Webmail 取码适配设计

## 目标

让平台能够把 `@gazeta.pl` 和 `@onet.pl` 邮箱作为 `source=self` 账号管理。平台保存加密后的邮箱密码并签发自己的查询 token；外部调用方只需通过现有 `GET /api/v1/message?token=...&type=...` 接口获取验证码。

本次不改变数据库结构、查询 token 格式、账号权限模型或对外接码 API。

## 方案

为 Gazeta 和 Onet 分别增加网页登录/收件适配器，并复用一组无状态 HTTP 工具。适配器优先使用 HTTP 请求复现网页登录、Cookie/OAuth 跳转、收件箱列表和邮件详情读取；不默认启动 Playwright。只有后续证据表明某一提供商必须执行浏览器 JavaScript 或通过浏览器挑战时，才单独设计浏览器兜底。

文件职责：

- `server/src/services/webmailHttp.js`：Cookie jar、带 Cookie 的 fetch、有限次数重定向、HTML 文本与链接提取等无提供商状态的工具。
- `server/src/services/gazeta.js`：处理 `oauth.gazeta.pl` 登录流程并读取 Gazeta 收件箱。
- `server/src/services/onet.js`：处理 Onet 登录流程并读取 Onet 收件箱。
- `server/src/services/imap.js`：识别邮箱域名，调用对应适配器，并继续复用现有邮件类型匹配和验证码提取逻辑。

若两个站点实际使用相同邮件后端，仍保留两个公开适配器模块；共享的协议细节下沉到公共工具或内部客户端，避免一个站点改版影响另一个站点的路由和错误信息。

## 数据流

1. 管理员或账号归属人添加 `source=self` 邮箱，平台加密保存邮箱密码并签发查询 token。
2. 外部调用方携带查询 token 调用现有接码接口。
3. 后端通过 token 哈希找到账号，解密该账号的邮箱密码。
4. `imap.js` 按实际收件邮箱域名路由：mail.com 系列走 `mailcom.js`，Gazeta 走 `gazeta.js`，Onet 走 `onet.js`，其他域名保持原有 IMAP 行为。
5. 提供商适配器登录并读取最近邮件，统一返回 `{ subject, from, body, links, date }`。
6. 现有 `messageMatchesType`、收件人过滤和 `pickCredential` 负责选出目标邮件及验证码或 magic link。
7. API 按现有响应结构返回结果并记录脱敏查询日志。

`fetch_address` 行为保持不变：若展示邮箱与实际收件邮箱不同，提供商路由依据 `fetch_address`，随后仍按展示邮箱地址过滤转发邮件正文中的原始收件人。

## 提供商边界

每个适配器只负责四件事：

1. 建立匿名会话并收集初始 Cookie/防跨站参数。
2. 提交邮箱地址和密码，完成允许范围内的 OAuth/重定向。
3. 定位 INBOX 并读取可配置数量的最近邮件。
4. 将邮件详情归一化为统一结构，不在适配器内判断邮件属于 GPT、Claude 或其他类型。

适配器不得记录邮箱密码、Cookie、OAuth 临时值或完整查询 token。测试夹具不得包含真实账号凭据。

## 错误处理

错误按以下类别给出稳定且可定位的中文信息：

- 凭据错误：`<provider> 登录失败：邮箱或密码错误`。
- 二步验证或挑战：`<provider> 登录需要额外验证，暂不支持自动取码`。
- 页面或接口结构变化：`<provider> 无法初始化邮箱会话` 或 `无法找到收件箱`。
- 网络错误和超时：保留提供商名称及请求阶段，不返回 Cookie、请求体或密码。
- 收件箱可访问但没有匹配邮件：返回现有的 `no new message`，不累计为登录失败。

现有连续失败健康状态逻辑保持不变。

## 测试策略

- 为公共 HTTP 工具测试 Cookie 更新、相对/绝对重定向、重定向上限和敏感信息不进入错误信息。
- 为 `gazeta.js` 与 `onet.js` 分别使用本地 mock HTTP 服务覆盖：登录成功、错误密码、OAuth/多跳重定向、收件箱为空、列表与详情解析。
- 为域名路由测试 `@gazeta.pl`、`@onet.pl`、mail.com 系列及普通 IMAP 域名。
- 扩展集成测试，证明创建 Gazeta/Onet `self` 账号后仍签发平台 token，并通过 token 查询走到对应适配器。
- 运行完整 `npm test` 防止 mail.com、IMAP、171mail、权限和 token 逻辑回归。
- 真实账号仅作部署后的宽容冒烟测试，不作为确定性测试门禁；真实 token 和密码通过运行时输入，不落盘、不输出。

## 文档与界面

README、TEST 和项目指南将增加 Gazeta/Onet 支持说明。账号表单仍使用现有 `self` 来源和“收件密码”字段，并提示这两个域名使用网页登录；不新增数据库字段或新的账号来源类型。

## 完成标准

- `@gazeta.pl` 和 `@onet.pl` 能由独立适配器完成网页登录与最近邮件读取。
- 外部调用方能继续只凭平台签发的 token 获取目标验证码。
- mail.com、普通 IMAP、171mail 转发及账号权限行为无回归。
- 自动化测试全部通过，服务可在本地启动供人工验证。
