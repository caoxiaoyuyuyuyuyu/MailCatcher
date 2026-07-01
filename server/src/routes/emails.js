import { Router } from 'express';
import db, { hasLegacyTokenColumn } from '../db.js';
import { authMiddleware, requireRole, isAdmin } from '../middleware/auth.js';
import { testImapConnection } from '../services/imap.js';
import { encrypt, generateApiToken, hashToken, maskToken } from '../services/crypto.js';

const router = Router();
router.use(authMiddleware);

const adminOnly = requireRole('admin');
const HEALTH = ['active', 'error', 'banned', 'expired', 'disabled'];

let HAS_LEGACY_TOKEN = null;
async function checkLegacyToken() {
  if (HAS_LEGACY_TOKEN === null) HAS_LEGACY_TOKEN = await hasLegacyTokenColumn();
  return HAS_LEGACY_TOKEN;
}

const getAccount = (id) => db('emails').where('id', id).first();
const hasGrant = async (accountId, userId) => !!(await db('account_grants').where({ account_id: accountId, user_id: userId }).first());
function issueToken() { const token = generateApiToken(); return { token, token_hash: hashToken(token), token_prefix: maskToken(token) }; }

async function canUse(req, acc) { return isAdmin(req) || acc.created_by === req.user.id || await hasGrant(acc.id, req.user.id); }
async function canManage(req, acc) { return isAdmin(req) || acc.created_by === req.user.id; }

async function grantsOf(accountId) {
  return db('account_grants as g')
    .leftJoin('users as u', 'g.user_id', 'u.id')
    .where('g.account_id', accountId)
    .select('g.user_id', 'u.username')
    .orderBy('g.id');
}

async function grantTxn(accountId, userId, grantedBy, shared) {
  await db.transaction(async trx => {
    if (!shared) await trx('account_grants').where('account_id', accountId).del();
    await trx('account_grants').insert({ account_id: accountId, user_id: userId, granted_by: grantedBy }).onConflict(['account_id', 'user_id']).ignore();
  });
}

router.get('/list', async (req, res) => {
  const { page = 1, pageSize = 30, keyword = '', status = '', health = '', source = '', batch_no = '' } = req.query;
  const offset = (page - 1) * pageSize;

  let query = db('emails as e').leftJoin('users as u', 'e.created_by', 'u.id');
  let countQuery = db('emails as e');

  if (!isAdmin(req)) {
    const sub = db('account_grants').where('user_id', req.user.id).whereRaw('account_id = e.id').select(db.raw('1'));
    query = query.where(function () { this.where('e.created_by', req.user.id).orWhereExists(sub); });
    countQuery = countQuery.where(function () { this.where('e.created_by', req.user.id).orWhereExists(sub); });
  }
  if (keyword) { query = query.where('e.address', 'like', `%${keyword}%`); countQuery = countQuery.where('e.address', 'like', `%${keyword}%`); }
  if (source) { query = query.where('e.source', source); countQuery = countQuery.where('e.source', source); }
  if (health) { const hs = health.split(','); query = query.whereIn('e.health_status', hs); countQuery = countQuery.whereIn('e.health_status', hs); }
  if (status !== '') { const ss = String(status).split(',').map(Number); query = query.whereIn('e.status', ss); countQuery = countQuery.whereIn('e.status', ss); }
  if (batch_no) { query = query.where('e.batch_no', batch_no); countQuery = countQuery.where('e.batch_no', batch_no); }

  const [{ c: total }] = await countQuery.count('* as c');
  const list = await query
    .select(
      'e.id', 'e.address', 'e.source', 'e.appkey', 'e.token_prefix', 'e.health_status', 'e.status',
      'e.batch_no', 'e.fail_count', 'e.forward_provider', 'e.fetch_address', 'e.created_by', 'e.shared',
      'e.purchaser', 'e.invoiced', 'e.created_at', 'e.updated_at',
      db.raw("(e.password_enc != '') as has_password"),
      db.raw("(e.forward_token_enc != '') as has_forward_token"),
      'u.username as created_by_name'
    )
    .orderBy('e.id', 'desc')
    .limit(Number(pageSize))
    .offset(offset);

  for (const r of list) {
    r.has_password = !!r.has_password;
    r.has_forward_token = !!r.has_forward_token;
    r.grantees = await grantsOf(r.id);
    r.can_manage = await canManage(req, r);
  }
  res.json({ code: 200, data: { list, total: Number(total) } });
});

router.post('/create', async (req, res) => {
  const { address, source = 'self', appkey, batch_no, password, fetch_address, shared = 0, purchaser, invoiced = 0, forward_provider = '171mail', forward_token } = req.body;
  if (!address) return res.json({ code: 400, message: '邮箱地址不能为空' });
  if (!['self', 'forward'].includes(source)) return res.json({ code: 400, message: '非法来源' });
  if (source === 'forward' && !forward_token) return res.json({ code: 400, message: 'forward 账号必须提供上游 token' });

  const { token, token_hash, token_prefix } = issueToken();
  try {
    const row = {
      address, source, appkey: appkey || '', batch_no: batch_no || '',
      password_enc: source === 'self' ? encrypt(password || '') : '',
      fetch_address: source === 'self' ? (fetch_address || '') : '',
      forward_provider: source === 'forward' ? forward_provider : '',
      forward_token_enc: source === 'forward' ? encrypt(forward_token) : '',
      token_hash, token_prefix, created_by: req.user.id, shared: shared ? 1 : 0,
      purchaser: purchaser || '', invoiced: invoiced ? 1 : 0,
      health_status: 'active', status: 1,
    };
    if (await checkLegacyToken()) row.token = token_hash;
    const [inserted] = await db('emails').insert(row).returning('id');
    const id = typeof inserted === 'object' ? inserted.id : inserted;
    res.json({ code: 200, data: { id, token }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.code === '23505') return res.json({ code: 400, message: '邮箱地址已存在' });
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', async (req, res) => {
  const { id, address, appkey, batch_no, status, password, fetch_address, shared, purchaser, invoiced, forward_token } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = await getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!await canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });

  const newPasswordEnc = (acc.source === 'self' && password) ? encrypt(password) : acc.password_enc;
  const newForwardEnc = (acc.source === 'forward' && forward_token) ? encrypt(forward_token) : acc.forward_token_enc;
  const newFetch = acc.source === 'self' ? (fetch_address ?? acc.fetch_address) : acc.fetch_address;
  const newShared = shared === undefined ? acc.shared : (shared ? 1 : 0);
  const newPurchaser = purchaser === undefined ? acc.purchaser : (purchaser || '');
  const newInvoiced = invoiced === undefined ? acc.invoiced : (invoiced ? 1 : 0);
  await db('emails').where('id', id).update({
    address: address ?? acc.address,
    appkey: appkey ?? acc.appkey,
    batch_no: batch_no ?? acc.batch_no,
    status: status ?? acc.status,
    password_enc: newPasswordEnc,
    fetch_address: newFetch,
    forward_token_enc: newForwardEnc,
    shared: newShared,
    purchaser: newPurchaser,
    invoiced: newInvoiced,
    updated_at: db.fn.now(),
  });
  if (!newShared) {
    const gs = await grantsOf(id);
    if (gs.length > 1) await db('account_grants').where('account_id', id).whereNot('user_id', gs[0].user_id).del();
  }
  res.json({ code: 200, message: 'success' });
});

router.post('/set-status', async (req, res) => {
  const { id, health_status, reason } = req.body;
  if (!id || !health_status) return res.json({ code: 400, message: 'id 和状态不能为空' });
  if (!HEALTH.includes(health_status)) return res.json({ code: 400, message: '非法状态' });
  const acc = await getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!await canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });
  if (acc.health_status === health_status) return res.json({ code: 200, message: 'success' });

  const updates = { health_status, updated_at: db.fn.now() };
  if (health_status === 'active') updates.fail_count = 0;
  await db('emails').where('id', id).update(updates);
  await db('account_status_logs').insert({
    account_id: id, from_status: acc.health_status, to_status: health_status,
    changed_by: req.user.id, reason: reason || '',
  });
  res.json({ code: 200, message: 'success' });
});

router.post('/grant', async (req, res) => {
  const { id, user_id } = req.body;
  if (!id || !user_id) return res.json({ code: 400, message: 'id 和 user_id 不能为空' });
  const acc = await getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!await canManage(req, acc)) return res.json({ code: 403, message: '无权分配该账号' });
  if (!await db('users').where('id', user_id).first()) return res.json({ code: 400, message: '用户不存在' });
  await grantTxn(id, user_id, req.user.id, acc.shared);
  res.json({ code: 200, message: 'success' });
});

router.post('/revoke', async (req, res) => {
  const { id, user_id } = req.body;
  if (!id || !user_id) return res.json({ code: 400, message: 'id 和 user_id 不能为空' });
  const acc = await getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!await canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });
  await db('account_grants').where({ account_id: id, user_id }).del();
  res.json({ code: 200, message: 'success' });
});

router.post('/rotate-token', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const acc = await getAccount(id);
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!await canManage(req, acc)) return res.json({ code: 403, message: '无权操作该账号' });
  const { token, token_hash, token_prefix } = issueToken();
  const updates = { token_hash, token_prefix, updated_at: db.fn.now() };
  if (await checkLegacyToken()) updates.token = token_hash;
  await db('emails').where('id', id).update(updates);
  res.json({ code: 200, data: { token }, message: 'success' });
});

async function deleteAccountsTxn(ids) {
  if (!ids.length) return 0;
  return db.transaction(async trx => {
    await trx('email_logs').whereIn('email_id', ids).update({ email_id: null });
    await trx('account_status_logs').whereIn('account_id', ids).del();
    await trx('account_grants').whereIn('account_id', ids).del();
    return trx('emails').whereIn('id', ids).del();
  });
}

router.delete('/delete/:id', async (req, res) => {
  const acc = await getAccount(Number(req.params.id));
  if (!acc) return res.json({ code: 404, message: '账号不存在' });
  if (!await canManage(req, acc)) return res.json({ code: 403, message: '无权删除该账号' });
  await deleteAccountsTxn([acc.id]);
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的账号' });
  const accounts = await Promise.all(ids.map(getAccount));
  const allowed = [];
  for (const a of accounts) {
    if (a && await canManage(req, a)) allowed.push(a.id);
  }
  if (!allowed.length) return res.json({ code: 400, message: '无可删除的账号' });
  const deleted = await deleteAccountsTxn(allowed);
  res.json({ code: 200, data: { deleted }, message: 'success' });
});

router.post('/import', async (req, res) => {
  const { emails } = req.body;
  if (!emails?.length) return res.json({ code: 400, message: '导入数据为空' });
  const batch_no = `batch_${Date.now()}`;
  const legacy = await checkLegacyToken();
  const results = [];

  await db.transaction(async trx => {
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
      const row = {
        source: 'self', address, password_enc: encrypt(password), appkey, batch_no,
        token_hash, token_prefix, created_by: req.user.id, health_status: 'active', status: 1,
      };
      if (legacy) row.token = token_hash;
      try {
        await trx('emails').insert(row);
        results.push({ address, token });
      } catch { /* skip duplicates */ }
    }
  });
  res.json({ code: 200, data: { imported: results.length, batch_no, tokens: results }, message: `成功导入 ${results.length} 个账号` });
});

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

router.post('/clear', adminOnly, async (req, res) => {
  await db.transaction(async trx => {
    await trx('email_logs').update({ email_id: null });
    await trx('account_status_logs').del();
    await trx('account_grants').del();
    await trx('emails').del();
  });
  res.json({ code: 200, message: 'success' });
});

export default router;
