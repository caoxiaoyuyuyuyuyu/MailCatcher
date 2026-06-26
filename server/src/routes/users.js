import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// 用户选项（仅 id+用户名）：供"分配账号"下拉用，任何登录用户可读（owner 也能分配自己的账号）
router.get('/options', (req, res) => {
  const list = db.prepare('SELECT id, username FROM users WHERE status = 1 ORDER BY username').all();
  res.json({ code: 200, data: { list }, message: 'success' });
});

router.use(requireRole('admin')); // 以下：仅管理员可管理用户

const ROLES = ['admin', 'member'];

router.get('/list', (req, res) => {
  const { keyword = '' } = req.query;
  let where = '1=1';
  const params = [];
  if (keyword) { where += ' AND username LIKE ?'; params.push(`%${keyword}%`); }
  const list = db.prepare(
    `SELECT id, username, role, status, created_at, (api_key_hash IS NOT NULL) AS has_api_key
     FROM users WHERE ${where} ORDER BY id`
  ).all(...params);
  res.json({ code: 200, data: { list, total: list.length } });
});

// 保留创建端点（前端入口已移除，主要供脚本/测试用）
router.post('/create', (req, res) => {
  const { username, password, role = 'member' } = req.body;
  if (!username || !password) return res.json({ code: 400, message: '用户名和密码不能为空' });
  if (!ROLES.includes(role)) return res.json({ code: 400, message: '非法角色' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, 1)')
      .run(username, hash, role);
    res.json({ code: 200, data: { id: info.lastInsertRowid }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '用户名已存在' });
    res.json({ code: 500, message: err.message });
  }
});

// 管理员可设置他人角色(admin/member)与启用状态；不可改自己（防自锁）
router.put('/update', (req, res) => {
  const { id, role, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.json({ code: 404, message: '用户不存在' });
  if (id === req.user.id) return res.json({ code: 400, message: '不能修改自己的角色或状态' });

  let nextRole = target.role, nextStatus = target.status;
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.json({ code: 400, message: '非法角色' });
    nextRole = role;
  }
  if (status !== undefined) nextStatus = status ? 1 : 0;
  db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run(nextRole, nextStatus, id);
  res.json({ code: 200, message: 'success' });
});

router.post('/reset-password', (req, res) => {
  const { id, newPassword } = req.body;
  if (!id || !newPassword) return res.json({ code: 400, message: 'id 和新密码不能为空' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return res.json({ code: 404, message: '用户不存在' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), id);
  res.json({ code: 200, message: 'success' });
});

router.delete('/delete/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.json({ code: 400, message: '不能删除自己' });
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return res.json({ code: 404, message: '用户不存在' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ code: 200, message: 'success' });
});

export default router;
