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
