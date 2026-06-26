import { Router } from 'express';
import db from '../db.js';
import { authMiddleware, requireRole, isAdmin } from '../middleware/auth.js';
import { testImapConnection } from '../services/imap.js';
import { encrypt, generateApiToken, hashToken, maskToken } from '../services/crypto.js';

const router = Router();
router.use(authMiddleware);

const adminOnly = requireRole('admin');
const HEALTH = ['active', 'error', 'banned', 'expired', 'disabled'];
// 兼容旧库遗留的 `token`(UNIQUE NOT NULL) 列：仍存在时写 token_hash(非明文)以满足约束
const HAS_LEGACY_TOKEN = db.prepare('PRAGMA table_info(emails)').all().some(c => c.name === 'token');

const getAccount = (id) => db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
const hasGrant = (accountId, userId) => !!db.prepare('SELECT 1 FROM account_grants WHERE account_id = ? AND user_id = ?').get(accountId, userId);
function issueToken() { const token = generateApiToken(); return { token, token_hash: hashToken(token), token_prefix: maskToken(token) }; }

// 能"使用"(浏览/取码)：admin / 自己添加(owner) / 被授予(grant)
function canUse(req, acc) { return isAdmin(req) || acc.created_by === req.user.id || hasGrant(acc.id, req.user.id); }
// 能"管理"(改/删/轮换/状态/分配)：admin / owner
function canManage(req, acc) { return isAdmin(req) || acc.created_by === req.user.id; }

function grantsOf(accountId) {
  return db.prepare(
    'SELECT g.user_id, u.username FROM account_grants g LEFT JOIN users u ON g.user_id = u.id WHERE g.account_id = ? ORDER BY g.id'
  ).all(accountId);
}
// 授予：独占(shared=0)账号先清空已有授权(单人)，再加；共享(shared=1)可多人
const grantTxn = db.transaction((accountId, userId, grantedBy, shared) => {
  if (!shared) db.prepare('DELETE FROM account_grants WHERE account_id = ?').run(accountId);
  db.prepare('INSERT OR IGNORE INTO account_grants (account_id, user_id, granted_by) VALUES (?, ?, ?)').run(accountId, userId, grantedBy);
});

// ── 列表（member 只见 自己添加 + 被分配；admin 见全部）────
router.get('/list', (req, res) => {
  const { page = 1, pageSize = 30, keyword = '', status = '', health = '', source = '', batch_no = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];
  if (!isAdmin(req)) {
    where += ' AND (e.created_by = ? OR EXISTS (SELECT 1 FROM account_grants g WHERE g.account_id = e.id AND g.user_id = ?))';
    params.push(req.user.id, req.user.id);
  }
  if (keyword) { where += ' AND e.address LIKE ?'; params.push(`%${keyword}%`); }
  if (source) { where += ' AND e.source = ?'; params.push(source); }
  if (health) { const hs = health.split(','); where += ` AND e.health_status IN (${hs.map(() => '?').join(',')})`; params.push(...hs); }
  if (status !== '') { const ss = String(status).split(',').map(Number); where += ` AND e.status IN (${ss.map(() => '?').join(',')})`; params.push(...ss); }
  if (batch_no) { where += ' AND e.batch_no = ?'; params.push(batch_no); }

  const total = db.prepare(`SELECT COUNT(*) c FROM emails e WHERE ${where}`).get(...params).c;
  const list = db.prepare(
    `SELECT e.id, e.address, e.source, e.appkey, e.token_prefix, e.health_status, e.status,
            e.batch_no, e.fail_count, e.forward_provider, e.fetch_address, e.created_by, e.shared,
            e.created_at, e.updated_at,
            (e.password_enc != '') AS has_password, (e.forward_token_enc != '') AS has_forward_token,
            u.username AS created_by_name
     FROM emails e LEFT JOIN users u ON e.created_by = u.id
     WHERE ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), offset);
  for (const r of list) { r.grantees = grantsOf(r.id); r.can_manage = canManage(req, r); }
  res.json({ code: 200, data: { list, total } });
});

// ── 创建（任何登录用户：成为 owner，自动获授权）────────────
router.post('/create', (req, res) => {
  const { address, source = 'self', appkey, batch_no, password, fetch_address, shared = 0, forward_provider = '171mail', forward_token } = req.body;
  if (!address) return res.json({ code: 400, message: '邮箱地址不能为空' });
  if (!['self', 'forward'].includes(source)) return res.json({ code: 400, message: '非法来源' });
  if (source === 'forward' && !forward_token) return res.json({ code: 400, message: 'forward 账号必须提供上游 token' });

  const { token, token_hash, token_prefix } = issueToken();
  try {
    const cols = ['address', 'source', 'appkey', 'batch_no', 'password_enc', 'fetch_address',
      'forward_provider', 'forward_token_enc', 'token_hash', 'token_prefix', 'created_by', 'shared'];
    const args = [
      address, source, appkey || '', batch_no || '',
      source === 'self' ? encrypt(password || '') : '',
      source === 'self' ? (fetch_address || '') : '',
      source === 'forward' ? forward_provider : '',
      source === 'forward' ? encrypt(forward_token) : '',
      token_hash, token_prefix, req.user.id, shared ? 1 : 0,
    ];
    if (HAS_LEGACY_TOKEN) { cols.push('token'); args.push(token_hash); }
    const ph = args.map(() => '?').join(', ');
    const info = db.prepare(`INSERT INTO emails (${cols.join(', ')}, health_status, status) VALUES (${ph}, 'active', 1)`).run(...args);
    // owner 通过 created_by 即拥有访问权，不进 grants 表；grants 仅记"分配给的其他人"
    res.json({ code: 200, data: { id: info.lastInsertRowid, token }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '邮箱地址已存在' });
    res.json({ code: 500, message: err.message });
  }
});

// ── 更新（owner 或 admin）────────────────────────────────
router.put('/update', (req, res) => {
  const { id, address, appkey, batch_no, status, password, fetch_address, shared, forward_token } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });

  const newPasswordEnc = (acc.source === 'self' && password) ? encrypt(password) : acc.password_enc;
  const newForwardEnc = (acc.source === 'forward' && forward_token) ? encrypt(forward_token) : acc.forward_token_enc;
  const newFetch = acc.source === 'self' ? (fetch_address ?? acc.fetch_address) : acc.fetch_address;
  const newShared = shared === undefined ? acc.shared : (shared ? 1 : 0);
  db.prepare(
    `UPDATE emails SET address = ?, appkey = ?, batch_no = ?, status = ?,
       password_enc = ?, fetch_address = ?, forward_token_enc = ?, shared = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(address ?? acc.address, appkey ?? acc.appkey, batch_no ?? acc.batch_no, status ?? acc.status, newPasswordEnc, newFetch, newForwardEnc, newShared, id);
  // 改为独占且当前授权多于 1 人时，仅保留最早的一个
  if (!newShared) { const gs = grantsOf(id); if (gs.length > 1) db.prepare('DELETE FROM account_grants WHERE account_id = ? AND user_id != ?').run(id, gs[0].user_id); }
  res.json({ code: 200, message: 'success' });
});

// ── 健康状态变更（owner 或 admin，带审计）────────────────
router.post('/set-status', (req, res) => {
  const { id, health_status, reason } = req.body;
  if (!id || !health_status) return res.json({ code: 400, message: 'id 和状态不能为空' });
  if (!HEALTH.includes(health_status)) return res.json({ code: 400, message: '非法状态' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });
  if (acc.health_status === health_status) return res.json({ code: 200, message: 'success' });

  const resetFail = health_status === 'active' ? ', fail_count = 0' : '';
  db.prepare(`UPDATE emails SET health_status = ?${resetFail}, updated_at = datetime('now') WHERE id = ?`).run(health_status, id);
  db.prepare('INSERT INTO account_status_logs (account_id, from_status, to_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
    .run(id, acc.health_status, health_status, req.user.id, reason || '');
  res.json({ code: 200, message: 'success' });
});

// ── 分配 / 收回（owner 或 admin）。独占=替换为单人，共享=可多人 ──
router.post('/grant', (req, res) => {
  const { id, user_id } = req.body;
  if (!id || !user_id) return res.json({ code: 400, message: 'id 和 user_id 不能为空' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!canManage(req, acc)) return res.json({ code: 403, message: '无权分配该账号' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)) return res.json({ code: 400, message: '用户不存在' });
  grantTxn(id, user_id, req.user.id, acc.shared);
  res.json({ code: 200, message: 'success' });
});

router.post('/revoke', (req, res) => {
  const { id, user_id } = req.body;
  if (!id || !user_id) return res.json({ code: 400, message: 'id 和 user_id 不能为空' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });
  db.prepare('DELETE FROM account_grants WHERE account_id = ? AND user_id = ?').run(id, user_id);
  res.json({ code: 200, message: 'success' });
});

// ── 轮换查询 token（owner 或 admin）──────────────────────
router.post('/rotate-token', (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });
  const { token, token_hash, token_prefix } = issueToken();
  const sql = HAS_LEGACY_TOKEN
    ? "UPDATE emails SET token_hash = ?, token_prefix = ?, token = ?, updated_at = datetime('now') WHERE id = ?"
    : "UPDATE emails SET token_hash = ?, token_prefix = ?, updated_at = datetime('now') WHERE id = ?";
  db.prepare(sql).run(...(HAS_LEGACY_TOKEN ? [token_hash, token_prefix, token_hash, id] : [token_hash, token_prefix, id]));
  res.json({ code: 200, data: { token }, message: 'success' });
});

// ── 删除（owner 或 admin）────────────────────────────────
const deleteAccountsTxn = db.transaction((ids) => {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`UPDATE email_logs SET email_id = NULL WHERE email_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM account_status_logs WHERE account_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM account_grants WHERE account_id IN (${ph})`).run(...ids);
  return db.prepare(`DELETE FROM emails WHERE id IN (${ph})`).run(...ids).changes;
});

router.delete('/delete/:id', (req, res) => {
  const acc = getAccount(Number(req.params.id));
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!canManage(req, acc)) return res.json({ code: 403, message: '无权删除该账号' });
  deleteAccountsTxn([acc.id]);
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的账号' });
  const allowed = ids.map(getAccount).filter(a => a && canManage(req, a)).map(a => a.id);
  if (!allowed.length) return res.json({ code: 400, message: '无可删除的账号' });
  const deleted = deleteAccountsTxn(allowed);
  res.json({ code: 200, data: { deleted }, message: 'success' });
});

// ── 批量导入（任何登录用户，self；created_by=自己）────────
router.post('/import', (req, res) => {
  const { emails } = req.body;
  if (!emails?.length) return res.json({ code: 400, message: '导入数据为空' });
  const batch_no = `batch_${Date.now()}`;
  const icols = ['address', 'password_enc', 'appkey', 'batch_no', 'token_hash', 'token_prefix', 'created_by'];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO emails (source, ${icols.join(', ')}${HAS_LEGACY_TOKEN ? ', token' : ''}, health_status, status)
     VALUES ('self', ${icols.map(() => '?').join(', ')}${HAS_LEGACY_TOKEN ? ', ?' : ''}, 'active', 1)`
  );
  const results = [];
  db.transaction(() => {
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
      const a = [address, encrypt(password), appkey, batch_no, token_hash, token_prefix, req.user.id];
      if (HAS_LEGACY_TOKEN) a.push(token_hash);
      const r = insert.run(...a);
      if (r.changes > 0) results.push({ address, token });
    }
  })();
  res.json({ code: 200, data: { imported: results.length, batch_no, tokens: results }, message: `成功导入 ${results.length} 个账号` });
});

// ── 测试 IMAP 连接（任何登录用户）──────────────────────────
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

// ── 清空（管理员）────────────────────────────────────────
router.post('/clear', adminOnly, (req, res) => {
  db.transaction(() => {
    db.prepare('UPDATE email_logs SET email_id = NULL').run();
    db.prepare('DELETE FROM account_status_logs').run();
    db.prepare('DELETE FROM account_grants').run();
    db.prepare('DELETE FROM emails').run();
  })();
  res.json({ code: 200, message: 'success' });
});

export default router;
