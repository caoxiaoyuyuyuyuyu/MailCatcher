# Gazeta/Onet Webmail 取码适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@gazeta.pl` 与 `@onet.pl` self 账号通过受控浏览器登录网页邮箱并读取最近邮件，继续复用 MailCatcher 现有类型过滤、验证码提取、token 和权限流程。

**Architecture:** 新增一个无状态的浏览器会话工具，负责启动 Chromium、填写登录表单、识别挑战/套餐门槛并把页面上的消息行归一化；Gazeta 与 Onet 适配器只提供站点 URL、登录阶段选择器和站点错误文案。`imap.js` 仅按实际收件域名路由到适配器，邮件筛选仍由已有纯函数完成。生产真实账号只做人工冒烟，确定性测试使用本地 fixture 和注入的 fake page/browser。

**Tech Stack:** Node.js ESM, Playwright Core, Vitest-free Node test scripts, existing ImapFlow/MailParser pipeline, SQLite schema unchanged.

## Global Constraints

- 不新增数据库字段、账号来源类型或对外 API。
- 不在日志、异常、fixture 或提交中写入真实邮箱密码、Cookie、OAuth 临时值、完整查询 token 或真实验证码。
- Onet 需要用户先在官方页面完成免费套餐启用；适配器检测到套餐页时返回稳定中文门槛错误，绝不自动点击套餐或确认付费。
- 面向 CI 的测试不得访问 Gazeta、Onet、IMAP 或任何真实第三方服务。
- 现有 `messageMatchesType`、`matchesRecipient`、`pickCredential` 和健康状态累计逻辑保持不变。

---

### Task 1: 定义浏览器工具和安全解析契约

**Files:**
- Create: `server/src/services/webmailBrowser.js`
- Create: `server/test/webmail-browser.test.mjs`
- Modify: `server/package.json` (test script)

**Interfaces:**
- `createBrowserSession(options) -> Promise<{ browser, context, page, close() }>`
- `class WebmailError extends Error` with `kind` values `credentials`, `challenge`, `activation`, `structure`, `network`.
- `extractLinksAndText(html) -> { text, links }` strips scripts/styles and returns external links in source order.
- `parseMessageRows(html, baseUrl) -> Array<{ subject, from, body, links, date, href }>` handles table rows, list items and `data-*` message fixtures without provider-specific matching.
- `assertNoSensitiveDetails(error)` is internal and guarantees error messages never include password/Cookie/query token.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLinksAndText, parseMessageRows, WebmailError } from '../src/services/webmailBrowser.js';

test('extractLinksAndText removes scripts and keeps links', () => {
  const out = extractLinksAndText('<style>x</style><p>Code 123456</p><script>secret</script><a href="/m/1">open</a>');
  assert.equal(out.text, 'Code 123456 open');
  assert.deepEqual(out.links, ['/m/1']);
});

test('parseMessageRows normalizes fixture message rows', () => {
  const rows = parseMessageRows(`
    <ul><li data-message-id="1" data-date="2026-07-20T10:00:00Z">
      <a href="/mail/1"><span class="from">noreply@example.com</span>
      <span class="subject">Login code</span></a>
      <div class="body">Your verification code: 123456</div>
    </li></ul>`, 'https://mail.test/inbox');
  assert.deepEqual(rows, [{
    subject: 'Login code', from: 'noreply@example.com',
    body: 'Your verification code: 123456', links: ['https://mail.test/mail/1'],
    date: '2026-07-20T10:00:00.000Z', href: 'https://mail.test/mail/1',
  }]);
});

test('WebmailError exposes stable kind without sensitive input', () => {
  const err = new WebmailError('onet', 'credentials', '邮箱或密码错误');
  assert.equal(err.kind, 'credentials');
  assert.equal(err.message, 'Onet 登录失败：邮箱或密码错误');
  assert.equal(err.message.includes('password'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/webmail-browser.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `webmailBrowser.js`.

- [ ] **Step 3: Write minimal implementation**

Implement the exported parser and error class, plus a browser factory that uses `chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] })`, creates a context with a stable desktop user agent, and always closes browser/context in `close()`. Parser selectors must be generic (`[data-message-id]`, `[role=row]`, `tr`, `li`) and deduplicate by href/subject/date.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/webmail-browser.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/webmailBrowser.js server/test/webmail-browser.test.mjs server/package.json
git commit -m "test: define webmail browser parsing contract"
```

### Task 2: Implement Gazeta adapter

**Files:**
- Create: `server/src/services/gazeta.js`
- Create: `server/test/gazeta.test.mjs`

**Interfaces:**
- `fetchGazetaEmails(email, password, options = {}) -> Promise<Email[]>`
- `parseGazetaMessages(html, baseUrl) -> Email[]` delegates to generic row parser and detail text parser.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGazetaMessages } from '../src/services/gazeta.js';

test('Gazeta parser returns normalized message details', () => {
  const [mail] = parseGazetaMessages(`<div data-message-id="42" data-date="2026-07-20T10:00:00Z">
    <a href="/message/42"><span class="sender">noreply@openai.com</span>
    <span class="subject">Your verification code</span></a>
    <p class="message-body">Use code 654321</p></div>`, 'https://poczta.gazeta.pl');
  assert.equal(mail.from, 'noreply@openai.com');
  assert.equal(mail.subject, 'Your verification code');
  assert.match(mail.body, /654321/);
});

test('Gazeta login fixture reports bad credentials without leaking password', async () => {
  const fake = { loginPage: { body: 'Nieprawidłowe dane logowania' } };
  await assert.rejects(
    () => import('../src/services/gazeta.js').then(({ loginGazeta }) => loginGazeta('a@gazeta.pl', 'secret', { fake })),
    err => err.kind === 'credentials' && !err.message.includes('secret'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/gazeta.test.mjs`
Expected: FAIL because `gazeta.js` is absent.

- [ ] **Step 3: Write minimal implementation**

Use `https://oauth.gazeta.pl/poczta/auth` as login URL. Fill the first email/login input and password input, submit the visible login button, wait for `https://poczta.gazeta.pl` navigation. Detect Polish credential text (`nieprawidł`, `błędne hasło`), two-factor/challenge text (`kod awaryjny`, `captcha`, `weryfikac`) and missing inbox landmarks as the corresponding `WebmailError`. After login, collect up to `WEBMAIL_SCAN_LIMIT` (default 15) message rows, opening same-origin hrefs in a new page when the row contains no body. Return only `{subject, from, body, links, date}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/gazeta.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/gazeta.js server/test/gazeta.test.mjs
git commit -m "feat: add Gazeta webmail adapter"
```

### Task 3: Implement Onet adapter and activation/challenge handling

**Files:**
- Create: `server/src/services/onet.js`
- Create: `server/test/onet.test.mjs`

**Interfaces:**
- `fetchOnetEmails(email, password, options = {}) -> Promise<Email[]>`
- `parseOnetMessages(html, baseUrl) -> Email[]`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOnetMessages, classifyOnetPage } from '../src/services/onet.js';

test('Onet parser normalizes inbox message fixture', () => {
  const [mail] = parseOnetMessages(`<article data-message-id="m1" data-date="2026-07-20T10:01:00Z">
    <a href="/mail/m1"><span data-field="from">noreply@openai.com</span>
    <span data-field="subject">Sign-in code</span></a>
    <div data-field="body">Verification code: 112233</div></article>`, 'https://poczta.onet.pl');
  assert.equal(mail.code, undefined);
  assert.equal(mail.subject, 'Sign-in code');
  assert.match(mail.body, /112233/);
});

test('Onet plan page is an activation error, not a credential error', () => {
  assert.equal(classifyOnetPage('Wybierz plan odpowiedni dla Ciebie'), 'activation');
  assert.equal(classifyOnetPage('Nieprawidłowe hasło'), 'credentials');
  assert.equal(classifyOnetPage('captcha recaptcha'), 'challenge');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/onet.test.mjs`
Expected: FAIL because `onet.js` is absent.

- [ ] **Step 3: Write minimal implementation**

Navigate to `https://poczta.onet.pl/`; complete Onet's two-stage email → password form, waiting after each submit. Use `classifyOnetPage` before and after navigation: Polish plan/offer markers (`Wybierz plan`, `Poczta Basic`, `Wybór planu`) map to `activation`; captcha/one-time-code markers map to `challenge`; wrong-password markers map to `credentials`; otherwise missing inbox landmarks map to `structure`. Never click plan choices. Collect and normalize recent messages with the generic browser utility.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/onet.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/onet.js server/test/onet.test.mjs
git commit -m "feat: add Onet webmail adapter"
```

### Task 4: Route domains and preserve existing extraction behavior

**Files:**
- Modify: `server/src/services/imap.js`
- Create: `server/test/webmail-routing.test.mjs`

**Interfaces:**
- `fetchVerificationCode` routes `@gazeta.pl` to Gazeta, `@onet.pl` to Onet, mail.com domains to existing `mailcom.js`, and all other domains to IMAP.
- Existing adapter results remain `{ code, subject, body, from, date }` after `pickCredential`.

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { getWebmailProvider } from '../src/services/imap.js';

test('webmail domains route independently from mail.com and IMAP', () => {
  assert.equal(getWebmailProvider('a@gazeta.pl'), 'gazeta');
  assert.equal(getWebmailProvider('a@onet.pl'), 'onet');
  assert.equal(getWebmailProvider('a@mail.com'), null);
  assert.equal(getWebmailProvider('a@example.com'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/webmail-routing.test.mjs`
Expected: FAIL because `getWebmailProvider` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add `getWebmailProvider`, import the two adapters lazily inside `fetchVerificationCode`, and keep mail.com detection first. Route based on `fetch_address` already supplied by the queue. Let `WebmailError` bubble through existing queue logging so failed logins increment health status while empty normalized results do not.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/webmail-routing.test.mjs && npm test`
Expected: routing test and all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/imap.js server/test/webmail-routing.test.mjs
git commit -m "feat: route Gazeta and Onet self mailboxes"
```

### Task 5: Update operational documentation and run live read-only smoke test

**Files:**
- Modify: `README.md`
- Modify: `TEST.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-20-gazeta-onet-webmail-design.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Write the failing test**

Add a documentation assertion to the existing Node test runner that scans README/TEST for `gazeta.pl`, `onet.pl`, `activation` and `WEBMAIL_SCAN_LIMIT`; run it once to show the old docs fail. This is a docs-only guard and does not include credentials or live output.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/docs-webmail.test.mjs`
Expected: FAIL until support notes are added.

- [ ] **Step 3: Write minimal implementation**

Document that both domains use webmail, Onet free-plan activation must be completed manually, challenges are reported as unsupported, `WEBMAIL_SCAN_LIMIT`/`CHROME_PATH` are configurable, and live smoke tests are read-only and never part of `npm test`. Amend the design spec to reflect the browser-first Onet evidence.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/docs-webmail.test.mjs && npm test`
Expected: PASS with no third-party network dependency.

- [ ] **Step 5: Live smoke test**

With the user-provided account entered at runtime only, run the adapter against a manually activated account. Confirm either a normalized recent-message array or a stable `activation`/`challenge`/`credentials` error. Do not store screenshots, cookies, response bodies, or credentials.

- [ ] **Step 6: Commit**

```bash
git add README.md TEST.md CLAUDE.md PROGRESS.md docs/superpowers/specs/2026-07-20-gazeta-onet-webmail-design.md server/test/docs-webmail.test.mjs
git commit -m "docs: document Gazeta and Onet webmail support"
```
