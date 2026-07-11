# PROGRESS — 经验教训沉淀

> 每条记录：遇到什么问题 / 如何解决 / 如何避免 / commit ID。同样的问题不要犯两次。

## 账号管理系统改造（task-account-mgmt）

### 1. 两类 token 的存储方式必须区分（commit a0fbaef）
- **问题**：一开始想「所有 token 都存 hash」，但 forward 账号的 171mail token 是要拿去**重放给上游**的，hash 后无法还原。
- **解决**：分两类——我方签发的查询 token 存 SHA-256 hash（只验证）；上游 token（171mail）和 IMAP 密码用 AES-256-GCM **可逆加密**（要还原）。
- **避免**：判断一个密钥要不要可逆，看「是否需要原样再用」。需要重放/外发 → 加密；只需校验 → hash。

### 2. 171mail 上游错误归类（commit 873d7ae）
- **问题**：171mail 把多种**临时故障**都返回为 `{code:500, message:"获取邮件失败: ..."}`，文案多变（"网络或代理请求失败"、"未能提取到应用配置(请稍后重试)" 等）。最初用窄正则 `请求失败` 匹配，漏掉了"请求**处理**失败"，导致被当成硬错误**不重试**，重试逻辑形同虚设。
- **解决**：改为按前缀判定——`获取邮件失败:` 前缀（且非"收件箱为空"）一律视为 transient 重试；硬错误（如"邮箱服务器未配置"）不带此前缀，直接抛。重试 4 次 + 退避。
- **避免**：对接第三方时，先**抓全错误样本**再定分类规则；优先用稳定前缀而非易变细节匹配。

### 3. 集成测试不要赌第三方实时可用（commit 873d7ae）
- **问题**：用真实 171mail 做断言，撞上它的抖动期 → 测试假阳性失败（代码其实没问题）。
- **解决**：`forward171.js` 的上游地址做成 `FORWARD_171_BASE` 可配；测试用内置 mock 跑确定性套件（`npm test`，25 项）。真实上游另做宽容冒烟，不进门禁。
- **避免**：外部依赖一律可注入/可 mock；CI 断言只针对自己的逻辑。

### 4. SQLite WAL 跨进程可见性时序
- **问题**：测试里「种子进程写入」与「server 进程启动」并发，server 偶发读不到刚写的行（首次 401）。
- **解决**：确保 seed 进程**退出后**再起 server；测试用 `MAILCATCHER_DATA_DIR` 临时库 + 就绪轮询。
- **避免**：跨进程共享 SQLite 时，注意写入提交与读取连接的先后；测试用独立临时库隔离。

### 5. 删除账号触发外键约束失败（生产 500）（commit 2a78574）
- **问题**：`email_logs.email_id` 外键引用 `emails(id)` 且 `foreign_keys=ON`。删除**有查询日志的账号**时 `DELETE FROM emails` 触发 `FOREIGN KEY constraint failed` → 500。测试只删了无日志的新账号，漏掉；生产 1913 条日志全引用账号，一删就炸。
- **解决**：删除走事务——先 `UPDATE email_logs SET email_id=NULL`（保留审计、解除关联）+ 清 `account_status_logs`，再删账号；单删/批删/清空统一。补回归测试（删带日志账号）。
- **避免**：删除有外键被引用的行前，先处理依赖（置空/级联/先删子表）；测试数据要**覆盖被引用的场景**，不能只测「干净」数据。已上线需 `systemctl restart`（后端改动，非静态文件）。

### 6. 旧库遗留 `token` NOT NULL 列挡住新建账号（生产）
- **问题**：新 schema 用 `token_hash`，但**生产旧表仍保留 `token TEXT UNIQUE NOT NULL`**（ALTER 只能增列，删不掉带约束的旧列）。新建账号不写 `token` → `NOT NULL constraint failed: emails.token`。`npm test` 用全新干净库（无此列）所以一直没暴露——又是「测试没覆盖旧库形态」。
- **解决**：emails.js 启动时探测是否有遗留 `token` 列，有则在 create/import 给它写 `token_hash`（满足 NOT NULL+UNIQUE，非明文）。用**生产库副本**实测建账号通过。
- **避免**：凡涉及"旧库升级路径"的改动，务必拿**生产库副本**跑一遍，别只信全新库测试。彻底根治需重建表删掉遗留明文列（带 FK + UNIQUE，需谨慎，留作后续）。

## 账号归属与分配（task-account-ownership）

### 7. 接手停滞任务：先验证基线再判断「做到哪」（commit fd3b150）
- **问题**：上一个任务（CCM #766）做账号归属/分配功能，prompt 太长进程退出停滞，worktree 留下未提交改动。直接看 diff 行数会误判「已完成」——后端+测试确实全绿(40 passed)，但**前端只改了模板没补脚本**：`index.html` 表格调 `showAssign(row)`，但 `<script>` 里仍是旧的 `claim/release`，没有 `showAssign`/分配弹窗/`grant·revoke` 调用。
- **解决**：先跑 `npm test`(基线全绿) + `grep` 模板引用的方法在脚本里是否定义，定位到「前端 rewrite 中途断」。补齐 `showAssign`+分配弹窗+`/user/options` 下拉+`doGrant/doRevoke`，删死掉的 `claim/release` 及其 return 导出，抽出内联 `<script>` 跑 `node --check` 验证语法，再起服务冒烟。
- **避免**：接手别人的半成品，不要只数 diff 行数。① 先跑测试确认基线；② 模板里每个 `@click`/绑定都 `grep` 一遍脚本是否有对应实现（前端无编译，缺方法不报错只在运行时炸）；③ 抽内联脚本 `node --check` + 起服务冒烟兜底。

### 8. worktree 的 node_modules 符号链接差点被提交（commit fd3b150）
- **问题**：CCM 建 worktree 时把 `server/node_modules` 做成**符号链接**指向主仓库（共享依赖省空间）。`.gitignore` 写的是 `node_modules/`（带斜杠只匹配目录），**符号链接不匹配**，于是 `git add server/` 把这个 link 当普通文件提交了（mode 120000）。
- **解决**：`git rm --cached server/node_modules` + 在 `.gitignore` 追加不带斜杠的 `server/node_modules`，`git commit --amend`。
- **避免**：提交前看 `git status --short`，出现 `node_modules`/`.venv` 等依赖目录立刻警觉；`.gitignore` 对「可能是符号链接」的路径别只写带斜杠的目录形式。`git ls-files | grep node_modules` 可快速自查是否误track。

## 转发取码稳定性（task-forward-sender）

### 9. 转发邮件外层发件人被改写，击穿按发件人的类型过滤（commit 待填）
- **问题**：用户反馈 Outlook 等邮箱「转发方式接码不稳、时灵时不灵」。根因：邮件被转发到 mail.com/其他收件箱后，那封转发邮件的外层 `from` 变成**转发者地址**（如你的 Outlook），不再是 OpenAI/Anthropic。而 `imap.js` 的类型过滤 `TYPE_FILTERS` 按发件人匹配，`fromMatch` 恒 false，只能靠主题硬撑；主题不含 verify/code 关键词就整封被跳过 → 漏码。另外时间窗只有 10 分钟（转发有延迟易落窗外）、mail.com 只扫最新 5 封（共用箱一刷屏就挤掉目标）。
- **解决**：抽出纯函数 `messageMatchesType(type,{from,subject,body})`，发件人匹配同时在 `from + subject + body` 里找已知发件地址——转发正文通常保留原始 `From: xxx@openai.com`，转发/直收都命中。IMAP 路径改为「信封快速判断不中→解析正文重试」（懒解析省开销）。回溯窗 10→30 分钟(`FETCH_LOOKBACK_MINUTES`)、mail.com 扫描 5→15 封(`MAILCOM_SCAN_LIMIT`)，均可配。补 7 条单元测试（`test/imap-match.test.mjs`，含转发场景，无需 DB/Redis），`npm test` 先跑单测再跑集成。
- **避免**：凡「转发/中转」链路，别假设外层信封头还是原始值——发件人、收件人都可能被改写或丢失，匹配要落到**正文里保留的原始头**。纯匹配逻辑抽成可单测函数，别埋在 IMAP 循环里（否则只能起真实邮箱才能验证）。
