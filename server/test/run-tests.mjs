// 自包含集成测试（单团队 admin/member 模型）：内置 mock 171mail，临时 DB 启动 app，跑全流程断言。
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
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  return (await fetch(BASE + path, opts)).json();
}

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/api/v1/message') {
    const type = u.searchParams.get('type');
    if (type === 'claude') return res.end(JSON.stringify({ code: 200, message: 'success', data: { from: 'no-reply@mail.anthropic.com', subject: 'Secure link', body: 'x', code: 'https://claude.ai/magic-link#MOCK123', Date: '2026-06-25T00:00:00+08:00' } }));
    if (type === 'gpt') return res.end(JSON.stringify({ code: 500, data: null, message: '获取邮件失败: MailList 收件箱为空或未匹配到邮件' }));
    return res.end(JSON.stringify({ code: 500, data: null, message: '邮箱服务器未配置' }));
  }
  res.statusCode = 404; res.end('{}');
}).listen(MOCK_PORT);

const app = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: APP_PORT, MAILCATCHER_DATA_DIR: DATA_DIR, FORWARD_171_BASE: `http://localhost:${MOCK_PORT}`, ENCRYPTION_KEY: 'test-enc-key', JWT_SECRET: 'test-jwt-key' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
function teardown(code) { app.kill(); mock.close(); try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {} process.exit(code); }
async function waitReady() {
  for (let i = 0; i < 50; i++) { try { const r = await api('POST', '/api/admin/login', { username: 'admin', password: 'admin123' }); if (r.code) return; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('app 未能启动');
}

try {
  const { encrypt, decrypt, hashToken, maskToken } = await import('../src/services/crypto.js');
  console.log('## 加密与 token 单元');
  ok(decrypt(encrypt('hi-密码')) === 'hi-密码', 'AES-GCM 往返');
  ok(encrypt('x') !== encrypt('x'), '随机 IV');
  ok(hashToken('a') === hashToken('a') && hashToken('a') !== hashToken('b'), 'hashToken 稳定且区分');
  ok(maskToken('c6dbee8919a05bbe').includes('****'), 'maskToken 打码');

  await waitReady();

  console.log('## 登录与角色（admin / member）');
  const adminLogin = await api('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  ok(adminLogin.code === 200 && adminLogin.data.role === 'admin', 'admin 登录为 admin（无 super_admin）');
  ok(adminLogin.data.team_id === undefined, '登录响应不含 team_id');
  const ADMIN = adminLogin.data.accessToken;

  console.log('## 自助注册');
  ok((await api('POST', '/api/admin/register', { email: 'm1@apexin.ai', password: 'secret1', confirmPassword: 'secret1' })).code === 200, '@apexin.ai 注册成功');
  ok((await api('POST', '/api/admin/register', { email: 'm1@apexin.ai', password: 'secret1', confirmPassword: 'secret1' })).code === 400, '重复邮箱被拒');
  ok((await api('POST', '/api/admin/register', { email: 'x@gmail.com', password: 'secret1', confirmPassword: 'secret1' })).code === 400, '非 @apexin.ai 被拒');
  ok((await api('POST', '/api/admin/register', { email: 'm2@apexin.ai', password: 'secret1', confirmPassword: 'nope' })).code === 400, '密码不一致被拒');
  const mLogin = await api('POST', '/api/admin/login', { username: 'M1@apexin.ai', password: 'secret1' });
  ok(mLogin.code === 200 && mLogin.data.role === 'member', '注册用户为 member（大小写不敏感登录）');
  const MEMBER = mLogin.data.accessToken;

  console.log('## 账号管理（管理员）');
  const acc = await api('POST', '/api/admin/email/create', { address: 'fwd@priest.com', source: 'forward', forward_token: 'up' }, ADMIN);
  ok(acc.code === 200 && acc.data.token, 'admin 创建 forward 账号并返回 token');
  const QTOKEN = acc.data.token;
  ok((await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`)).data?.code?.includes('magic-link'), 'token 转发取到 magic-link');
  ok((await api('GET', `/api/v1/message?token=${QTOKEN}&type=gpt`)).message === 'no new message', '空邮件归一');
  ok((await api('POST', '/api/admin/email/create', { address: 'self@x.com', source: 'self', password: 'p' }, ADMIN)).code === 200, 'admin 创建 self 账号');
  // 展示邮箱(outlook) 与 实际收件邮箱(mail.com) 分离
  await api('POST', '/api/admin/email/create', { address: 'codex@outlook.com', source: 'self', fetch_address: 'inbox@mail.com', password: 'p' }, ADMIN);
  const fwAcc = (await api('GET', '/api/admin/email/list?keyword=codex@outlook.com', null, ADMIN)).data.list[0];
  ok(fwAcc && fwAcc.address === 'codex@outlook.com' && fwAcc.fetch_address === 'inbox@mail.com', '账号支持「展示邮箱≠收件邮箱」(fetch_address 存取)');

  console.log('## 成员权限（归属 / 分配）');
  const memberId = (await api('GET', '/api/admin/user/list', null, ADMIN)).data.list.find(u => u.username === 'm1@apexin.ai').id;
  ok((await api('GET', '/api/admin/email/list', null, MEMBER)).data.total === 0, '成员默认看不到任何账号');
  const own = await api('POST', '/api/admin/email/create', { address: 'mine@priest.com', source: 'forward', forward_token: 'x' }, MEMBER);
  ok(own.code === 200 && own.data.token, '成员可自助添加账号(成为 owner)');
  ok((await api('GET', '/api/admin/email/list', null, MEMBER)).data.total === 1, '成员只看到自己添加的(1 个)');
  ok((await api('GET', '/api/v1/message?email=mine@priest.com&type=claude', null, MEMBER)).data?.code?.includes('magic-link'), '成员可取自己账号的码');
  ok((await api('GET', '/api/v1/message?email=fwd@priest.com&type=claude', null, MEMBER)).code === 403, '成员不能取未分配账号的码(403)');
  ok((await api('POST', '/api/admin/email/delete-batch', { ids: [1] }, MEMBER)).code === 400, '成员删不了别人的账号');
  ok((await api('GET', '/api/admin/user/list', null, MEMBER)).code === 403, '成员不能管理用户(403)');
  ok((await api('GET', '/api/admin/logs/email', null, MEMBER)).code === 403, '成员不能看日志(403)');
  const fwdId = (await api('GET', '/api/admin/email/list?keyword=fwd@priest.com', null, ADMIN)).data.list[0].id;
  ok((await api('POST', '/api/admin/email/grant', { id: fwdId, user_id: memberId }, ADMIN)).code === 200, 'admin 分配账号给成员');
  ok((await api('GET', '/api/v1/message?email=fwd@priest.com&type=claude', null, MEMBER)).data?.code?.includes('magic-link'), '分配后成员可取该账号的码');
  ok((await api('GET', '/api/admin/email/list', null, MEMBER)).data.total === 2, '分配后成员可见 2 个(自己+被分配)');
  ok((await api('POST', '/api/admin/email/grant', { id: fwdId, user_id: 1 }, MEMBER)).code === 403, '成员不能分配非自己的账号(403)');
  const ex = await api('POST', '/api/admin/email/create', { address: 'ex@priest.com', source: 'forward', forward_token: 'x' }, ADMIN);
  await api('POST', '/api/admin/email/grant', { id: ex.data.id, user_id: memberId }, ADMIN);
  await api('POST', '/api/admin/email/grant', { id: ex.data.id, user_id: 1 }, ADMIN);
  const exG = (await api('GET', '/api/admin/email/list?keyword=ex@priest.com', null, ADMIN)).data.list[0].grantees;
  ok(exG.length === 1 && exG[0].user_id === 1, '独占账号：分给第二人替换第一人(单人)');
  const sh = await api('POST', '/api/admin/email/create', { address: 'sh@priest.com', source: 'forward', forward_token: 'x', shared: 1 }, ADMIN);
  await api('POST', '/api/admin/email/grant', { id: sh.data.id, user_id: memberId }, ADMIN);
  await api('POST', '/api/admin/email/grant', { id: sh.data.id, user_id: 1 }, ADMIN);
  const shG = (await api('GET', '/api/admin/email/list?keyword=sh@priest.com', null, ADMIN)).data.list[0].grantees;
  ok(shG.length === 2, '共享账号：可分给多人');

  console.log('## 管理员升降级');
  ok((await api('PUT', '/api/admin/user/update', { id: memberId, role: 'admin' }, ADMIN)).code === 200, 'admin 把成员升级为 admin');
  const reLogin = await api('POST', '/api/admin/login', { username: 'm1@apexin.ai', password: 'secret1' });
  ok(reLogin.data.role === 'admin', '该用户重新登录已是 admin');
  ok((await api('GET', '/api/admin/user/list', null, reLogin.data.accessToken)).code === 200, '升级后可管理用户');
  ok((await api('PUT', '/api/admin/user/update', { id: adminLogin.data.id, role: 'member' }, ADMIN)).code === 400, 'admin 不能改自己的角色(防自锁)');

  console.log('## 状态机 / 轮换 / 删除(FK)');
  await api('POST', '/api/admin/email/set-status', { id: 1, health_status: 'banned' }, ADMIN);
  ok((await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`)).code === 403, 'banned 拒绝取码');
  await api('POST', '/api/admin/email/set-status', { id: 1, health_status: 'active' }, ADMIN);
  const rot = await api('POST', '/api/admin/email/rotate-token', { id: 1 }, ADMIN);
  ok(rot.data.token !== QTOKEN && (await api('GET', `/api/v1/message?token=${QTOKEN}&type=claude`)).code === 401, '轮换后旧 token 失效');
  const delAcc = await api('POST', '/api/admin/email/create', { address: 'del@priest.com', source: 'forward', forward_token: 'x' }, ADMIN);
  await api('GET', `/api/v1/message?token=${delAcc.data.token}&type=claude`); // 产生日志
  ok((await api('POST', '/api/admin/email/delete-batch', { ids: [delAcc.data.id] }, ADMIN)).data.deleted === 1, '删除有日志的账号成功(不再 FK 500)');

  console.log('## API Key + stats');
  const key = (await api('POST', '/api/admin/api-key', {}, ADMIN)).data.apiKey;
  ok((await api('GET', '/api/v1/message?email=fwd@priest.com&type=claude', null, key)).data?.code?.includes('magic-link'), 'API Key 按邮箱取码');
  ok((await api('POST', '/api/v1/codex/send', { email: 'x@y.com' })).code === 401, 'codex/send 未登录被拒(401)');
  const stats = await api('GET', '/api/admin/stats', null, ADMIN);
  ok(stats.data.emails >= 2 && stats.data.teams === undefined, 'stats 无 teams 字段');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  teardown(fail ? 1 : 0);
} catch (err) {
  console.error('测试运行异常:', err);
  teardown(1);
}
