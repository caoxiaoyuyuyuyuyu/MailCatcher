import { Router } from 'express';
import db from '../db.js';
import { authMiddleware, requireRole, isSuper, teamScope } from '../middleware/auth.js';
import { testImapConnection } from '../services/imap.js';
import { encrypt, generateApiToken, hashToken, maskToken } from '../services/crypto.js';

const router = Router();
router.use(authMiddleware);

const HEALTH = ['active', 'error', 'banned', 'expired', 'disabled'];

// 解析创建/更新时账号应归属的团队
function resolveTeamId(req, bodyTeamId) {
  if (isSuper(req)) return bodyTeamId || req.user.team_id || null;
  return req.user.team_id; // 非 super 强制本团队
}

// 取出账号并校验当前用户可见（团队隔离）
function getVisibleAccount(req, id) {
  const acc = db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
  if (!acc) return null;
  if (!isSuper(req) && acc.team_id !== req.user.team_id) return null;
  return acc;
}

function issueToken() {
  const token = generateApiToken();
  return { token, token_hash: hashToken(token), token_prefix: maskToken(token) };
}

// ── 列表 ────────────────────────────────────────────────
router.get('/list', (req, res) => {
  const { page = 1, pageSize = 30, keyword = '', status = '', health = '', source = '', batch_no = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];

  const scope = teamScope(req, 'e.team_id');
  where += scope.clause; params.push(...scope.params);

  if (keyword) { where += ' AND e.address LIKE ?'; params.push(`%${keyword}%`); }
  if (source) { where += ' AND e.source = ?'; params.push(source); }
  if (health) {
    const hs = health.split(',');
    where += ` AND e.health_status IN (${hs.map(() => '?').join(',')})`;
    params.push(...hs);
  }
  if (status !== '') {
    const ss = String(status).split(',').map(Number);
    where += ` AND e.status IN (${ss.map(() => '?').join(',')})`;
    params.push(...ss);
  }
  if (batch_no) { where += ' AND e.batch_no = ?'; params.push(batch_no); }

  const total = db.prepare(`SELECT COUNT(*) c FROM emails e WHERE ${where}`).get(...params).c;
  const list = db.prepare(
    `SELECT e.id, e.address, e.source, e.appkey, e.token_prefix, e.health_status, e.status,
            e.batch_no, e.team_id, e.assignee_id, e.fail_count, e.forward_provider,
            e.created_at, e.updated_at,
            (e.password_enc != '') AS has_password,
            (e.forward_token_enc != '') AS has_forward_token,
            t.name AS team_name, u.username AS assignee_name
     FROM emails e
     LEFT JOIN teams t ON e.team_id = t.id
     LEFT JOIN users u ON e.assignee_id = u.id
     WHERE ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), offset);

  res.json({ code: 200, data: { list, total } });
});

// ── 创建 ────────────────────────────────────────────────
// self：自管邮箱，系统签发 token，本地 IMAP/mailcom 取码
// forward：171mail 账号，手填上游 token（加密存），系统仍签发自己的查询 token（方案乙）
router.post('/create', (req, res) => {
  const { address, source = 'self', appkey, batch_no, password, forward_provider = '171mail', forward_token } = req.body;
  if (!address) return res.json({ code: 400, message: '邮箱地址不能为空' });
  if (!['self', 'forward'].includes(source)) return res.json({ code: 400, message: '非法来源' });
  if (source === 'forward' && !forward_token) return res.json({ code: 400, message: 'forward 账号必须提供上游 token' });

  const team_id = resolveTeamId(req, req.body.team_id);
  const { token, token_hash, token_prefix } = issueToken();

  try {
    const info = db.prepare(
      `INSERT INTO emails
         (address, source, team_id, appkey, batch_no, password_enc, forward_provider, forward_token_enc,
          token_hash, token_prefix, health_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`
    ).run(
      address, source, team_id, appkey || '', batch_no || '',
      source === 'self' ? encrypt(password || '') : '',
      source === 'forward' ? forward_provider : '',
      source === 'forward' ? encrypt(forward_token) : '',
      token_hash, token_prefix
    );
    // token 明文仅此一次返回
    res.json({ code: 200, data: { id: info.lastInsertRowid, token }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '邮箱地址已存在' });
    res.json({ code: 500, message: err.message });
  }
});

// ── 更新（不改 source / token，密码与上游 token 仅在传入时更新）─────
router.put('/update', (req, res) => {
  const { id, address, appkey, batch_no, status, password, forward_token } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getVisibleAccount(req, id);
  if (!acc) return res.json({ code: 404, message: '账号不存在或无权操作' });

  const newPasswordEnc = (acc.source === 'self' && password) ? encrypt(password) : acc.password_enc;
  const newForwardEnc = (acc.source === 'forward' && forward_token) ? encrypt(forward_token) : acc.forward_token_enc;
  const team_id = isSuper(req) && req.body.team_id !== undefined ? (req.body.team_id || null) : acc.team_id;

  db.prepare(
    `UPDATE emails SET address = ?, appkey = ?, batch_no = ?, status = ?,
       password_enc = ?, forward_token_enc = ?, team_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    address ?? acc.address, appkey ?? acc.appkey, batch_no ?? acc.batch_no,
    status ?? acc.status, newPasswordEnc, newForwardEnc, team_id, id
  );
  res.json({ code: 200, message: 'success' });
});

// ── 健康状态变更（带审计）────────────────────────────────
router.post('/set-status', (req, res) => {
  const { id, health_status, reason } = req.body;
  if (!id || !health_status) return res.json({ code: 400, message: 'id 和状态不能为空' });
  if (!HEALTH.includes(health_status)) return res.json({ code: 400, message: '非法状态' });
  const acc = getVisibleAccount(req, id);
  if (!acc) return res.json({ code: 404, message: '账号不存在或无权操作' });
  if (acc.health_status === health_status) return res.json({ code: 200, message: 'success' });

  const resetFail = health_status === 'active' ? ', fail_count = 0' : '';
  db.prepare(`UPDATE emails SET health_status = ?${resetFail}, updated_at = datetime('now') WHERE id = ?`)
    .run(health_status, id);
  db.prepare(
    `INSERT INTO account_status_logs (account_id, from_status, to_status, changed_by, reason)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, acc.health_status, health_status, req.user.id, reason || '');
  res.json({ code: 200, message: 'success' });
});

// ── 领用 / 释放 ─────────────────────────────────────────
// assignee_id = null 释放；指派给他人需 team_admin/super_admin
router.post('/assign', (req, res) => {
  const { id, assignee_id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getVisibleAccount(req, id);
  if (!acc) return res.json({ code: 404, message: '账号不存在或无权操作' });

  const target = assignee_id ?? null;
  const assigningOther = target && target !== req.user.id;
  if (assigningOther && !['super_admin', 'team_admin'].includes(req.user.role)) {
    return res.json({ code: 403, message: '只能领用给自己；指派他人需管理员' });
  }
  if (target) {
    const u = db.prepare('SELECT id, team_id FROM users WHERE id = ?').get(target);
    if (!u) return res.json({ code: 400, message: '指派的用户不存在' });
    if (!isSuper(req) && u.team_id !== acc.team_id) return res.json({ code: 400, message: '只能指派给本团队成员' });
  }
  db.prepare("UPDATE emails SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?").run(target, id);
  res.json({ code: 200, message: 'success' });
});

// ── 重置查询 token（轮换）────────────────────────────────
router.post('/rotate-token', (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getVisibleAccount(req, id);
  if (!acc) return res.json({ code: 404, message: '账号不存在或无权操作' });
  const { token, token_hash, token_prefix } = issueToken();
  db.prepare("UPDATE emails SET token_hash = ?, token_prefix = ?, updated_at = datetime('now') WHERE id = ?")
    .run(token_hash, token_prefix, id);
  res.json({ code: 200, data: { token }, message: 'success' });
});

// ── 删除 ────────────────────────────────────────────────
router.delete('/delete/:id', (req, res) => {
  const acc = getVisibleAccount(req, Number(req.params.id));
  if (!acc) return res.json({ code: 404, message: '账号不存在或无权操作' });
  db.prepare('DELETE FROM emails WHERE id = ?').run(acc.id);
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的账号' });
  const visible = ids.map(id => getVisibleAccount(req, id)).filter(Boolean).map(a => a.id);
  if (!visible.length) return res.json({ code: 400, message: '无可删除的账号' });
  db.prepare(`DELETE FROM emails WHERE id IN (${visible.map(() => '?').join(',')})`).run(...visible);
  res.json({ code: 200, data: { deleted: visible.length }, message: 'success' });
});

// ── 批量导入（仅 self）：每行 address----password----appkey ──
router.post('/import', (req, res) => {
  const { emails } = req.body;
  if (!emails?.length) return res.json({ code: 400, message: '导入数据为空' });
  const team_id = resolveTeamId(req, req.body.team_id);
  const batch_no = `batch_${Date.now()}`;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO emails
       (address, source, team_id, password_enc, appkey, batch_no, token_hash, token_prefix, health_status, status)
     VALUES (?, 'self', ?, ?, ?, ?, ?, ?, 'active', 1)`
  );
  const results = [];

  const txn = db.transaction(() => {
    for (const item of emails) {
      let address, password, appkey;
      if (typeof item === 'string') {
        const parts = item.split('----');
        address = parts[0]?.trim(); password = parts[1]?.trim() || ''; appkey = parts[2]?.trim() || '';
      } else {
        ({ address, password = '', appkey = '' } = item);
      }
      if (!address) continue;
      const { token, token_hash, token_prefix } = issueToken();
      const r = insert.run(address, team_id, encrypt(password), appkey, batch_no, token_hash, token_prefix);
      if (r.changes > 0) results.push({ address, token }); // token 仅此一次返回
    }
  });
  txn();

  res.json({ code: 200, data: { imported: results.length, batch_no, tokens: results }, message: `成功导入 ${results.length} 个账号` });
});

// ── 测试 IMAP 连接（self）────────────────────────────────
router.post('/test-connection', async (req, res) => {
  const { address, password } = req.body;
  if (!address || !password) return res.json({ code: 400, message: '请提供邮箱地址和密码' });
  try {
    const result = await testImapConnection(address, password);
    res.json({ code: 200, data: result, message: 'IMAP 连接成功' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

// ── 清空（仅 super_admin）────────────────────────────────
router.post('/clear', requireRole('super_admin'), (req, res) => {
  db.prepare('DELETE FROM emails').run();
  res.json({ code: 200, message: 'success' });
});

export default router;
