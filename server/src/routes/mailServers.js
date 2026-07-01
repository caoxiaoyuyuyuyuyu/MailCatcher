import { Router } from 'express';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/list', async (req, res) => {
  const { page = 1, pageSize = 30, keyword = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let query = db('mail_servers');
  let countQuery = db('mail_servers');
  if (keyword) {
    query = query.where(function () { this.where('domain', 'like', `%${keyword}%`).orWhere('host', 'like', `%${keyword}%`); });
    countQuery = countQuery.where(function () { this.where('domain', 'like', `%${keyword}%`).orWhere('host', 'like', `%${keyword}%`); });
  }
  const [{ c: total }] = await countQuery.count('* as c');
  const list = await query.select('*').orderBy('id', 'desc').limit(Number(pageSize)).offset(offset);
  res.json({ code: 200, data: { list, total: Number(total) } });
});

router.post('/create', async (req, res) => {
  const { domain, host, port = 993, use_ssl = 1, use_proxy = 0, status = 1 } = req.body;
  if (!domain || !host) return res.json({ code: 400, message: '域名和服务器地址不能为空' });
  try {
    await db('mail_servers').insert({ domain, host, port, use_ssl, use_proxy, status });
    res.json({ code: 200, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.code === '23505') return res.json({ code: 400, message: '该域名已存在' });
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', async (req, res) => {
  const { id, domain, host, port, use_ssl, use_proxy, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  await db('mail_servers').where('id', id).update({
    domain, host, port, use_ssl: use_ssl ?? 1, use_proxy: use_proxy ?? 0,
    status: status ?? 1, updated_at: db.fn.now(),
  });
  res.json({ code: 200, message: 'success' });
});

router.delete('/delete/:id', async (req, res) => {
  await db('mail_servers').where('id', req.params.id).del();
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的服务' });
  await db('mail_servers').whereIn('id', ids).del();
  res.json({ code: 200, message: 'success' });
});

router.post('/clear', async (req, res) => {
  await db('mail_servers').del();
  res.json({ code: 200, message: 'success' });
});

export default router;
