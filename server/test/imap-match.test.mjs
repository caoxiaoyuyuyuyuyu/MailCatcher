// 单元测试：messageMatchesType —— 类型匹配（含转发发件人被改写场景），无需 DB/Redis
import { messageMatchesType } from '../src/services/imap.js';

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

console.log(`\n=== UNIT RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
