import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { authMiddleware, requireRole, isSuper } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('super_admin', 'team_admin')); // 成员无用户管理权限

const ROLES = ['super_admin', 'team_admin', 'member'];
const publicCols = 'id, username, role, team_id, status, created_at';

// team_admin 只能操作本团队的 member；super_admin 不受限
function canManageTarget(req, target) {
  if (isSuper(req)) return true;
  if (!target) return false;
  return target.team_id === req.user.team_id && target.role === 'member';
}

router.get('/list', (req, res) => {
  const { keyword = '' } = req.query;
  let where = '1=1';
  const params = [];
  if (!isSuper(req)) { where += ' AND team_id = ?'; params.push(req.user.team_id ?? -1); }
  if (keyword) { where += ' AND username LIKE ?'; params.push(`%${keyword}%`); }
  const rows = db.prepare(`SELECT ${publicCols}, (api_key_hash IS NOT NULL) AS has_api_key FROM users WHERE ${where} ORDER BY id`).all(...params);
  const teams = Object.fromEntries(db.prepare('SELECT id, name FROM teams').all().map(t => [t.id, t.name]));
  const list = rows.map(u => ({ ...u, team_name: u.team_id ? teams[u.team_id] || null : null }));
  res.json({ code: 200, data: { list, total: list.length } });
});

router.post('/create', (req, res) => {
  let { username, password, role = 'member', team_id } = req.body;
  if (!username || !password) return res.json({ code: 400, message: '用户名和密码不能为空' });
  if (!ROLES.includes(role)) return res.json({ code: 400, message: '非法角色' });

  if (!isSuper(req)) {
    // team_admin：只能在本团队创建 member
    if (role !== 'member') return res.json({ code: 403, message: '只能创建普通成员' });
    team_id = req.user.team_id;
  }
  if (role !== 'super_admin' && !team_id) return res.json({ code: 400, message: '请指定团队' });
  if (role === 'super_admin') team_id = null;

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, password_hash, role, team_id) VALUES (?, ?, ?, ?)')
      .run(username, hash, role, team_id ?? null);
    res.json({ code: 200, data: { id: info.lastInsertRowid }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '用户名已存在' });
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', (req, res) => {
  const { id, role, team_id, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.json({ code: 404, message: '用户不存在' });
  if (!canManageTarget(req, target)) return res.json({ code: 403, message: '无权操作该用户' });

  let nextRole = target.role, nextTeam = target.team_id, nextStatus = target.status;
  if (isSuper(req)) {
    if (role !== undefined) { if (!ROLES.includes(role)) return res.json({ code: 400, message: '非法角色' }); nextRole = role; }
    if (team_id !== undefined) nextTeam = team_id || null;
    if (nextRole === 'super_admin') nextTeam = null;
    else if (!nextTeam) return res.json({ code: 400, message: '请指定团队' });
  }
  if (status !== undefined) nextStatus = status ? 1 : 0;

  db.prepare('UPDATE users SET role = ?, team_id = ?, status = ? WHERE id = ?')
    .run(nextRole, nextTeam, nextStatus, id);
  res.json({ code: 200, message: 'success' });
});

router.post('/reset-password', (req, res) => {
  const { id, newPassword } = req.body;
  if (!id || !newPassword) return res.json({ code: 400, message: 'id 和新密码不能为空' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!canManageTarget(req, target)) return res.json({ code: 403, message: '无权操作该用户' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), id);
  res.json({ code: 200, message: 'success' });
});

router.delete('/delete/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.json({ code: 400, message: '不能删除自己' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!canManageTarget(req, target)) return res.json({ code: 403, message: '无权操作该用户' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ code: 200, message: 'success' });
});

export default router;
