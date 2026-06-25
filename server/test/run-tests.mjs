// 自包含集成测试：内置 mock 171mail（确定性），用临时 DB 启动 app，跑全流程断言。
// 运行：npm test
import http from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MOCK_PORT = 3120;
const APP_PORT = 3119;
const BASE = `http://localhost:${APP_PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mailcatcher-test-'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } };

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  return (await fetch(BASE + path, opts)).json();
}

// 内置 mock 171mail
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/api/v1/message') {
    const type = u.searchParams.get('type');
    if (type === 'claude') return res.end(JSON.stringify({ code: 200, message: 'success', data: { from: 'no-reply@mail.anthropic.com', subject: 'Secure link to log in to Claude.ai', body: 'sign in', code: 'https://claude.ai/magic-link#MOCK123', Date: '2026-06-25T00:00:00+08:00' } }));
    if (type === 'gpt') return res.end(JSON.stringify({ code: 500, data: null, message: '获取邮件失败: MailList 收件箱为空或未匹配到邮件' }));
    return res.end(JSON.stringify({ code: 500, data: null, message: '邮箱服务器未配置: priest.com' }));
  }
  res.statusCode = 404; res.end('{}');
}).listen(MOCK_PORT);

const app = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: APP_PORT, MAILCATCHER_DATA_DIR: DATA_DIR, FORWARD_171_BASE: `http://localhost:${MOCK_PORT}`, ENCRYPTION_KEY: 'test-enc-key', JWT_SECRET: 'test-jwt-key' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

function teardown(code) {
  app.kill(); mock.close();
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await api('POST', '/api/admin/login', { username: 'admin', password: 'admin123' }); if (r.code) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app 未能启动');
}

try {
  // 纯单元：加密往返 / token hash
  const { encrypt, decrypt, hashToken, maskToken } = await import('../src/services/crypto.js');
  console.log('## 加密与 token 单元');
  ok(decrypt(encrypt('hello-密码')) === 'hello-密码', 'AES-GCM 加解密往返');
  ok(encrypt('x') !== encrypt('x'), '相同明文每次密文不同(随机 IV)');
  ok(hashToken('abc') === hashToken('abc') && hashToken('abc') !== hashToken('abd'), 'hashToken 稳定且区分');
  ok(maskToken('c6dbee8919a05bbe').includes('****'), 'maskToken 打码');

  await waitReady();

  console.log('## 登录与角色');
  const adminLogin = await api('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  ok(adminLogin.code === 200 && adminLogin.data.role === 'super_admin', 'admin 登录为 super_admin');
  const ADMIN = adminLogin.data.accessToken;

  console.log('## 团队与用户');
  const TA = (await api('POST', '/api/admin/team/create', { name: 'TeamA' }, ADMIN)).data.id;
  const TB = (await api('POST', '/api/admin/team/create', { name: 'TeamB' }, ADMIN)).data.id;
  ok(TA && TB, '创建 TeamA / TeamB');
  ok((await api('POST', '/api/admin/user/create', { username: 'alice', password: 'p', role: 'team_admin', team_id: TA }, ADMIN)).code === 200, '创建 alice(team_admin@TeamA)');
  ok((await api('POST', '/api/admin/user/create', { username: 'bob', password: 'p', role: 'member', team_id: TA }, ADMIN)).code === 200, '创建 bob(member@TeamA)');
  const aliceLogin = await api('POST', '/api/admin/login', { username: 'alice', password: 'p' });
  ok(aliceLogin.data.role === 'team_admin' && aliceLogin.data.team_id === TA, 'alice 登录正确');
  const ALICE = aliceLogin.data.accessToken;
  const BOB = (await api('POST', '/api/admin/login', { username: 'bob', password: 'p' })).data.accessToken;

  console.log('## forward 账号 + 转发取码');
  const acc = await api('POST', '/api/admin/email/create', { address: 'fwd@priest.com', source: 'forward', forward_provider: '171mail', forward_token: 'upstream-secret' }, ALICE);
  ok(acc.code === 200 && acc.data.token, '创建 forward 账号并返回明文 token(仅此一次)');
  const QTOKEN = acc.data.token;
  const fetchCode = await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`);
  ok(fetchCode.code === 200 && (fetchCode.data?.code || '').includes('magic-link'), '用我们的 token 转发取到 claude magic-link');
  const gptFetch = await api('GET', `/api/v1/message?token=${QTOKEN}&type=gpt`);
  ok(gptFetch.message === 'no new message', '空邮件归一为 no new message');

  console.log('## self 账号取码(本地)');
  const selfAcc = await api('POST', '/api/admin/email/create', { address: 'self@example.com', source: 'self', password: 'p' }, ALICE);
  const selfFetch = await api('GET', `/api/v1/message?token=${selfAcc.data.token}&type=claude`);
  ok(selfFetch.code === 500 || selfFetch.code === 200, 'self 账号走本地 IMAP 路径(无 mock，预期连接错误/无邮件)');

  console.log('## 列表脱敏');
  const row = (await api('GET', '/api/admin/email/list', null, ALICE)).data.list.find(r => r.address === 'fwd@priest.com');
  ok(row.token_prefix.includes('****') && !row.token_prefix.includes(QTOKEN), 'token 仅展示掩码');
  ok(row.forward_token_enc === undefined && row.password_enc === undefined, '列表不返回任何密文字段');

  console.log('## 状态机');
  await api('POST', '/api/admin/email/set-status', { id: row.id, health_status: 'banned', reason: 't' }, ALICE);
  ok((await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`)).code === 403, 'banned 状态取码被拒(403)');
  await api('POST', '/api/admin/email/set-status', { id: row.id, health_status: 'active' }, ALICE);
  ok((await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`)).code === 200, 'active 恢复后可取码');

  console.log('## token 轮换');
  const rot = await api('POST', '/api/admin/email/rotate-token', { id: row.id }, ALICE);
  ok(rot.data.token !== QTOKEN, '轮换得到新 token');
  ok((await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`)).code === 401, '旧 token 失效(401)');

  console.log('## 团队隔离');
  const aliceTeams = await api('GET', '/api/admin/team/list', null, ALICE);
  ok(aliceTeams.data.list.length === 1 && aliceTeams.data.list[0].id === TA, 'alice 只看到自己团队');
  await api('POST', '/api/admin/email/create', { address: 'other@priest.com', source: 'forward', forward_token: 'x', team_id: TB }, ADMIN);
  ok((await api('GET', '/api/admin/email/list', null, ALICE)).data.list.every(a => a.team_id === TA), 'alice 看不到 TeamB 账号');

  console.log('## 角色门禁');
  ok((await api('POST', '/api/admin/user/create', { username: 'x', password: 'p', role: 'member', team_id: TA }, BOB)).code === 403, 'member 无用户管理权(403)');
  ok((await api('POST', '/api/admin/email/clear', {}, BOB)).code === 403, 'member 无法 clear(403)');
  ok((await api('POST', '/api/v1/claude/send', { email: 'x@y.com' })).code === 401, 'claude/send 未登录被拒(401)');

  console.log('## stats 团队过滤');
  const aStats = await api('GET', '/api/admin/stats', null, ADMIN);
  const lStats = await api('GET', '/api/admin/stats', null, ALICE);
  ok(aStats.data.emails >= 3 && lStats.data.emails === 2, `stats 隔离 super=${aStats.data.emails} alice=${lStats.data.emails}`);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  teardown(fail ? 1 : 0);
} catch (err) {
  console.error('测试运行异常:', err);
  teardown(1);
}
