import { Router } from 'express';
import db from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { testImapConnection } from '../services/imap.js';
import { encrypt, generateApiToken, hashToken, maskToken } from '../services/crypto.js';

const router = Router();
router.use(authMiddleware);

const adminOnly = requireRole('admin'); // 账号管理（增删改/导入/状态/轮换）仅管理员
const HEALTH = ['active', 'error', 'banned', 'expired', 'disabled'];

const getAccount = (id) => db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
function issueToken() {
  const token = generateApiToken();
  return { token, token_hash: hashToken(token), token_prefix: maskToken(token) };
}

// ── 列表（所有登录用户：单团队，共享一个账号池）──────────
router.get('/list', (req, res) => {
  const { page = 1, pageSize = 30, keyword = '', status = '', health = '', source = '', batch_no = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];
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
            e.batch_no, e.assignee_id, e.fail_count, e.forward_provider, e.fetch_address, e.created_at, e.updated_at,
            (e.password_enc != '') AS has_password,
            (e.forward_token_enc != '') AS has_forward_token,
            u.username AS assignee_name
     FROM emails e
     LEFT JOIN users u ON e.assignee_id = u.id
     WHERE ${where} ORDER BY e.id DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), offset);

  res.json({ code: 200, data: { list, total } });
});

// ── 创建（管理员）────────────────────────────────────────
router.post('/create', adminOnly, (req, res) => {
  const { address, source = 'self', appkey, batch_no, password, fetch_address, forward_provider = '171mail', forward_token } = req.body;
  if (!address) return res.json({ code: 400, message: '邮箱地址不能为空' });
  if (!['self', 'forward'].includes(source)) return res.json({ code: 400, message: '非法来源' });
  if (source === 'forward' && !forward_token) return res.json({ code: 400, message: 'forward 账号必须提供上游 token' });

  const { token, token_hash, token_prefix } = issueToken();
  try {
    const info = db.prepare(
      `INSERT INTO emails
         (address, source, appkey, batch_no, password_enc, fetch_address, forward_provider, forward_token_enc,
          token_hash, token_prefix, health_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`
    ).run(
      address, source, appkey || '', batch_no || '',
      source === 'self' ? encrypt(password || '') : '',
      source === 'self' ? (fetch_address || '') : '',
      source === 'forward' ? forward_provider : '',
      source === 'forward' ? encrypt(forward_token) : '',
      token_hash, token_prefix
    );
    res.json({ code: 200, data: { id: info.lastInsertRowid, token }, message: 'success' }); // token 仅此一次
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '邮箱地址已存在' });
    res.json({ code: 500, message: err.message });
  }
});

// ── 更新（管理员；不改 source/token，密码与上游 token 仅在传入时更新）──
router.put('/update', adminOnly, (req, res) => {
  const { id, address, appkey, batch_no, status, password, fetch_address, forward_token } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });

  const newPasswordEnc = (acc.source === 'self' && password) ? encrypt(password) : acc.password_enc;
  const newForwardEnc = (acc.source === 'forward' && forward_token) ? encrypt(forward_token) : acc.forward_token_enc;
  const newFetch = acc.source === 'self' ? (fetch_address ?? acc.fetch_address) : acc.fetch_address;
  db.prepare(
    `UPDATE emails SET address = ?, appkey = ?, batch_no = ?, status = ?,
       password_enc = ?, fetch_address = ?, forward_token_enc = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    address ?? acc.address, appkey ?? acc.appkey, batch_no ?? acc.batch_no,
    status ?? acc.status, newPasswordEnc, newFetch, newForwardEnc, id
  );
  res.json({ code: 200, message: 'success' });
});

// ── 健康状态变更（管理员，带审计）────────────────────────
router.post('/set-status', adminOnly, (req, res) => {
  const { id, health_status, reason } = req.body;
  if (!id || !health_status) return res.json({ code: 400, message: 'id 和状态不能为空' });
  if (!HEALTH.includes(health_status)) return res.json({ code: 400, message: '非法状态' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
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

// ── 领用 / 释放（所有登录用户：自助领用；指派他人需管理员）──
router.post('/assign', (req, res) => {
  const { id, assignee_id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });

  const target = assignee_id ?? null;
  if (target && target !== req.user.id && req.user.role !== 'admin') {
    return res.json({ code: 403, message: '只能领用给自己；指派他人需管理员' });
  }
  if (target && !db.prepare('SELECT id FROM users WHERE id = ?').get(target)) {
    return res.json({ code: 400, message: '指派的用户不存在' });
  }
  db.prepare("UPDATE emails SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?").run(target, id);
  res.json({ code: 200, message: 'success' });
});

// ── 轮换查询 token（管理员）──────────────────────────────
router.post('/rotate-token', adminOnly, (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  if (!getAccount(id)) return res.json({ code: 404, message: '账号不存在' });
  const { token, token_hash, token_prefix } = issueToken();
  db.prepare("UPDATE emails SET token_hash = ?, token_prefix = ?, updated_at = datetime('now') WHERE id = ?")
    .run(token_hash, token_prefix, id);
  res.json({ code: 200, data: { token }, message: 'success' });
});

// ── 删除（管理员）。账号被 email_logs.email_id 外键引用，需先解依赖再删 ──
const deleteAccountsTxn = db.transaction((ids) => {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`UPDATE email_logs SET email_id = NULL WHERE email_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM account_status_logs WHERE account_id IN (${ph})`).run(...ids);
  return db.prepare(`DELETE FROM emails WHERE id IN (${ph})`).run(...ids).changes;
});

router.delete('/delete/:id', adminOnly, (req, res) => {
  if (!getAccount(Number(req.params.id))) return res.json({ code: 404, message: '账号不存在' });
  deleteAccountsTxn([Number(req.params.id)]);
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', adminOnly, (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的账号' });
  const deleted = deleteAccountsTxn(ids.map(Number));
  res.json({ code: 200, data: { deleted }, message: 'success' });
});

// ── 批量导入（管理员，仅 self）：每行 address----password----appkey ──
router.post('/import', adminOnly, (req, res) => {
  const { emails } = req.body;
  if (!emails?.length) return res.json({ code: 400, message: '导入数据为空' });
  const batch_no = `batch_${Date.now()}`;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO emails
       (address, source, password_enc, appkey, batch_no, token_hash, token_prefix, health_status, status)
     VALUES (?, 'self', ?, ?, ?, ?, ?, 'active', 1)`
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
      const r = insert.run(address, encrypt(password), appkey, batch_no, token_hash, token_prefix);
      if (r.changes > 0) results.push({ address, token });
    }
  })();
  res.json({ code: 200, data: { imported: results.length, batch_no, tokens: results }, message: `成功导入 ${results.length} 个账号` });
});

// ── 测试 IMAP 连接（管理员，self）────────────────────────
router.post('/test-connection', adminOnly, async (req, res) => {
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
    db.prepare('DELETE FROM emails').run();
  })();
  res.json({ code: 200, message: 'success' });
});

export default router;
