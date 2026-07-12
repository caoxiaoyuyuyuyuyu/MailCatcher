// E2E：用真实 mailparser 解析「Outlook 自动转发」的原始邮件，
// 复现 fetchViaImap 每封邮件的处理链：解析正文 → 类型匹配 → 提取验证码。
// 证明「外层发件人被改写、主题也没关键词」时，靠正文原始 From 仍能取到码。
import { simpleParser } from 'mailparser';
import { messageMatchesType, extractCode } from '../src/services/imap.js';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log('## 转发取码 E2E（真实 mailparser）');

// Outlook 规则转发后的真实形态：外层 From 是转发者，主题被本地化/改写成无关键词，
// 原始发件人和验证码都在正文的「转发块」里。
const rawForwarded = [
  'From: Zhang San <me@outlook.com>',
  'To: inbox@mail.com',
  'Subject: =?utf-8?B?6L2s5Y+R77ya6LSm5oi36YCa55+l?=', // "转发：账户通知"（无 code/verify 关键词）
  'Date: Sat, 12 Jul 2026 10:00:05 +0000',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  '________________________________',
  'From: OpenAI <noreply@tm.openai.com>',
  'Sent: Saturday, July 12, 2026 10:00 AM',
  'To: me@outlook.com',
  'Subject: Your ChatGPT code',
  '',
  'Your ChatGPT code is 705911. This code expires in 10 minutes.',
  '',
].join('\r\n');

const parsed = await simpleParser(Buffer.from(rawForwarded, 'utf-8'));
const outerFrom = (parsed.from?.value?.[0]?.address || '').toLowerCase();
const subject = parsed.subject || '';
const body = parsed.text || parsed.html || '';

ok(outerFrom === 'me@outlook.com', `解析出的外层发件人是转发者(${outerFrom})，已非 OpenAI`);
ok(/账户通知|转发/.test(subject), `主题被改写、不含 code/verify 关键词(${subject})`);
ok(body.includes('noreply@tm.openai.com'), '正文保留原始发件人地址');

// 复现旧逻辑：只看信封 from + 主题 → 应当漏掉（证明这确实是原 bug 场景）
const oldWouldMatch = messageMatchesType('gpt', { from: outerFrom, subject });
ok(oldWouldMatch === false, '旧逻辑(仅信封 from+主题)会漏掉这封 → 复现原 bug');

// 新逻辑：带上正文 → 命中
const newMatch = messageMatchesType('gpt', { from: outerFrom, subject, body });
ok(newMatch === true, '新逻辑(带正文原始 From)命中 gpt');

// 完整链路：命中后从正文提取验证码
const code = extractCode(body);
ok(code === '705911', `从转发正文提取到验证码(${code})`);

// 反向保证：Claude 类型不应命中这封 OpenAI 转发邮件
ok(messageMatchesType('claude', { from: outerFrom, subject, body }) === false,
  '这封 OpenAI 转发邮件不会误命中 claude');

console.log(`\n=== E2E RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
