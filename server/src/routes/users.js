import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/options', async (req, res) => {
  const list = await db('users').select('id', 'username').where('status', 1).orderBy('username');
  res.json({ code: 200, data: { list }, message: 'success' });
});

router.use(requireRole('admin'));

const ROLES = ['admin', 'member'];

router.get('/list', async (req, res) => {
  const { keyword = '' } = req.query;
  let query = db('users').select('id', 'username', 'role', 'status', 'created_at', db.raw('(api_key_hash IS NOT NULL) AS has_api_key'));
  if (keyword) query = query.where('username', 'like', `%${keyword}%`);
  const list = await query.orderBy('id');
  for (const r of list) r.has_api_key = !!r.has_api_key;
  res.json({ code: 200, data: { list, total: list.length } });
});

router.post('/create', async (req, res) => {
  const { username, password, role = 'member' } = req.body;
  if (!username || !password) return res.json({ code: 400, message: '用户名和密码不能为空' });
  if (!ROLES.includes(role)) return res.json({ code: 400, message: '非法角色' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const [inserted] = await db('users').insert({ username, password_hash: hash, role, status: 1 }).returning('id');
    const id = typeof inserted === 'object' ? inserted.id : inserted;
    res.json({ code: 200, data: { id }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.code === '23505') return res.json({ code: 400, message: '用户名已存在' });
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', async (req, res) => {
  const { id, role, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const target = await db('users').where('id', id).first();
  if (!target) return res.json({ code: 404, message: '用户不存在' });
  if (id === req.user.id) return res.json({ code: 400, message: '不能修改自己的角色或状态' });

  let nextRole = target.role, nextStatus = target.status;
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.json({ code: 400, message: '非法角色' });
    nextRole = role;
  }
  if (status !== undefined) nextStatus = status ? 1 : 0;
  await db('users').where('id', id).update({ role: nextRole, status: nextStatus });
  res.json({ code: 200, message: 'success' });
});

router.post('/reset-password', async (req, res) => {
  const { id, newPassword } = req.body;
  if (!id || !newPassword) return res.json({ code: 400, message: 'id 和新密码不能为空' });
  if (!await db('users').where('id', id).first()) return res.json({ code: 404, message: '用户不存在' });
  await db('users').where('id', id).update({ password_hash: bcrypt.hashSync(newPassword, 10) });
  res.json({ code: 200, message: 'success' });
});

router.delete('/delete/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.json({ code: 400, message: '不能删除自己' });
  if (!await db('users').where('id', id).first()) return res.json({ code: 404, message: '用户不存在' });
  await db('users').where('id', id).del();
  res.json({ code: 200, message: 'success' });
});

export default router;
