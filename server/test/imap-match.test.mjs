// 单元测试：messageMatchesType / pickCredential —— 类型匹配 + 凭证提取，无需 DB/Redis
import { messageMatchesType, pickCredential, getMailboxSearchOrder, getMailboxSearchPaths } from '../src/services/imap.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log('## messageMatchesType');

// 1. 直收：发件人就是 OpenAI，命中 gpt
ok(messageMatchesType('gpt', { from: 'noreply@tm.openai.com', subject: 'Your code', body: 'code 123456' }),
  '直收 OpenAI 邮件命中 gpt');

// 2. 转发（核心修复）：外层 from 被改写成自己的 Outlook，但正文保留原始 From
const forwarded = {
  from: 'me@outlook.com', // 转发者，已不是 OpenAI
  subject: 'Fw: 你的验证码',
  body: '---------- Forwarded message ----------\nFrom: OpenAI <noreply@tm.openai.com>\nTo: me@outlook.com\nYour verification code is 654321',
};
ok(messageMatchesType('gpt', forwarded), '转发后外层发件人被改写，仍能靠正文原始发件人命中 gpt');

// 3. 转发的 Claude 邮件同理
const forwardedClaude = {
  from: 'me@outlook.com',
  subject: 'Fw: Sign in to Claude',
  body: 'From: Anthropic <no-reply@mail.anthropic.com>\nhttps://claude.ai/magic-link#abc',
};
ok(messageMatchesType('claude', forwardedClaude), '转发的 Claude 邮件靠正文命中 claude');

// 4. 不相关邮件不应命中（外层与正文都无匹配发件人、主题无关键词）
ok(!messageMatchesType('gpt', { from: 'newsletter@shop.com', subject: '限时促销', body: '买一送一' }),
  '无关邮件不命中 gpt');

// 5. gpt 的 Claude 发件人不应误判为 gpt（防止过度放宽）
ok(!messageMatchesType('gpt', { from: 'me@outlook.com', subject: 'Fw: hi', body: 'From: Anthropic <no-reply@mail.anthropic.com>' }),
  'Claude 发件人不会误命中 gpt');

// 6. type=all 命中一切
ok(messageMatchesType('all', { from: 'anyone@x.com', subject: '', body: '' }), 'type=all 命中一切');

// 7. 仅靠主题关键词也能命中（发件人不认识但主题含 verification）
ok(messageMatchesType('gpt', { from: 'unknown@x.com', subject: 'Your verification code', body: '123456' }),
  '主题含 verification 关键词命中 gpt');

console.log('\n## pickCredential');

console.log('\n## mailbox search order');

const onetFolders = [
  { path: 'Sent' },
  { path: 'INBOX' },
  { path: 'Społeczności' },
  { path: 'Junk' },
  { path: 'Powiadomienia' },
  { path: 'Trash' },
  { path: 'Archive' },
];
ok(JSON.stringify(getMailboxSearchOrder(onetFolders)) === JSON.stringify([
  'INBOX', 'Społeczności', 'Junk', 'Powiadomienia', 'Archive',
]), '优先扫描收件箱和 Onet 分类文件夹，跳过已发送/草稿/回收站');
ok(JSON.stringify(getMailboxSearchPaths('jhonlelojo@onet.pl', onetFolders)) === JSON.stringify([
  'INBOX', 'Społeczności', 'Junk', 'Powiadomienia', 'Archive',
]), '仅 Onet 账号扫描分类文件夹');
ok(JSON.stringify(getMailboxSearchPaths('user@gmail.com', onetFolders)) === JSON.stringify(['INBOX']),
  '非 Onet 账号仍只扫描 INBOX');

const sendgridLink = 'https://u20216706.ct.sendgrid.net/ls/click?upn=u001.abc';

// 1. 登录通知邮件（只有追踪链接、无数字码）→ gpt 应跳过（返回 null），不能把链接当码
ok(pickCredential('gpt', { subject: 'FW: New sign-in to your OpenAI account', body: `点击 ${sendgridLink}` }) === null,
  'gpt 跳过 New sign-in 登录通知（不返回追踪链接）');

// 2. 真正的验证码邮件 → 返回 6 位数字码
ok(pickCredential('gpt', { subject: 'FW: 你的临时 ChatGPT 登录代码', body: 'Your code is 419160' }) === '419160',
  'gpt 从登录代码邮件提取数字码');

// 3. gpt 邮件无数字码、只有普通链接 → 返回 null（数字码类型不拿链接兜底）
ok(pickCredential('gpt', { subject: 'ChatGPT verify', body: `open ${sendgridLink}` }) === null,
  'gpt 无数字码时不返回链接');

// 4. claude 是 magic-link 类型 → 无数字码时返回链接
const magic = 'https://claude.ai/magic-link#abc';
ok(pickCredential('claude', { subject: 'Sign in to Claude', body: `link: ${magic}` }) === magic,
  'claude 无数字码时返回 magic-link');

// 5. 「登录代码」主题不能被误判为通知而跳过
ok(pickCredential('gpt', { subject: '你的临时 ChatGPT 登录代码', body: '123456' }) === '123456',
  '「登录代码」主题不被当作通知跳过');

// 6. type=all 对通知邮件仍返回内容（原始调试视图）
ok(pickCredential('all', { subject: 'New sign-in', body: `x ${sendgridLink}` }) === sendgridLink,
  'type=all 通知邮件仍返回链接（不跳过）');

console.log(`\n=== UNIT RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
