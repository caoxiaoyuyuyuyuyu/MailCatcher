import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';
import { hashToken, maskToken } from '../services/crypto.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('admin'));

function generateAppKey() {
  return 'ak_' + crypto.randomBytes(20).toString('hex');
}

function generateAppSecret() {
  return 'sk_' + crypto.randomBytes(32).toString('hex');
}

router.get('/list', async (req, res) => {
  const list = await db('app_keys')
    .select('id', 'name', 'key_prefix', 'permissions', 'rate_limit', 'allowed_accounts', 'status', 'created_by', 'created_at', 'updated_at')
    .orderBy('id', 'desc');
  for (const r of list) {
    r.permissions = typeof r.permissions === 'string' ? JSON.parse(r.permissions || '{}') : (r.permissions || {});
    r.rate_limit = typeof r.rate_limit === 'string' ? JSON.parse(r.rate_limit || '{}') : (r.rate_limit || {});
    r.allowed_accounts = typeof r.allowed_accounts === 'string' ? JSON.parse(r.allowed_accounts || '{}') : (r.allowed_accounts || {});
  }
  res.json({ code: 200, data: { list }, message: 'success' });
});

router.post('/create', async (req, res) => {
  const { name, permissions = {}, rate_limit = {}, allowed_accounts = {} } = req.body;
  if (!name) return res.json({ code: 400, message: '名称不能为空' });

  const appKey = generateAppKey();
  const appSecret = generateAppSecret();

  await db('app_keys').insert({
    name,
    key_hash: hashToken(appKey),
    secret_hash: hashToken(appSecret),
    key_prefix: maskToken(appKey),
    permissions: JSON.stringify(permissions),
    rate_limit: JSON.stringify(rate_limit),
    allowed_accounts: JSON.stringify(allowed_accounts),
    status: 'active',
    created_by: req.user.id,
  });

  res.json({
    code: 200,
    data: { appKey, appSecret },
    message: 'App Key 创建成功。请妥善保管，Secret 仅显示一次。',
  });
});

router.put('/update', async (req, res) => {
  const { id, name, permissions, rate_limit, allowed_accounts, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const ak = await db('app_keys').where('id', id).first();
  if (!ak) return res.json({ code: 404, message: 'App Key 不存在' });

  const updates = { updated_at: db.fn.now() };
  if (name !== undefined) updates.name = name;
  if (permissions !== undefined) updates.permissions = JSON.stringify(permissions);
  if (rate_limit !== undefined) updates.rate_limit = JSON.stringify(rate_limit);
  if (allowed_accounts !== undefined) updates.allowed_accounts = JSON.stringify(allowed_accounts);
  if (status !== undefined) updates.status = status;
  await db('app_keys').where('id', id).update(updates);
  res.json({ code: 200, message: 'success' });
});

router.post('/rotate', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const ak = await db('app_keys').where('id', id).first();
  if (!ak) return res.json({ code: 404, message: 'App Key 不存在' });

  const newKey = generateAppKey();
  const newSecret = generateAppSecret();
  await db('app_keys').where('id', id).update({
    key_hash: hashToken(newKey),
    secret_hash: hashToken(newSecret),
    key_prefix: maskToken(newKey),
    updated_at: db.fn.now(),
  });
  res.json({
    code: 200,
    data: { appKey: newKey, appSecret: newSecret },
    message: 'App Key 已轮换。请妥善保管新凭证。',
  });
});

router.delete('/delete/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!await db('app_keys').where('id', id).first()) return res.json({ code: 404, message: 'App Key 不存在' });
  await db('app_keys').where('id', id).del();
  res.json({ code: 200, message: 'success' });
});

export default router;
