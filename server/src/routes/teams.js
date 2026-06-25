import { Router } from 'express';
import db from '../db.js';
import { authMiddleware, requireRole, isSuper } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// 列表：super_admin 看全部；其他角色只看自己所在团队
router.get('/list', (req, res) => {
  let teams;
  if (isSuper(req)) {
    teams = db.prepare('SELECT * FROM teams ORDER BY id').all();
  } else {
    teams = db.prepare('SELECT * FROM teams WHERE id = ?').all(req.user.team_id ?? -1);
  }
  // 附带成员数与账号数
  const list = teams.map(t => ({
    ...t,
    member_count: db.prepare('SELECT COUNT(*) c FROM users WHERE team_id = ?').get(t.id).c,
    account_count: db.prepare('SELECT COUNT(*) c FROM emails WHERE team_id = ?').get(t.id).c,
  }));
  res.json({ code: 200, data: { list, total: list.length } });
});

router.post('/create', requireRole('super_admin'), (req, res) => {
  const { name, remark } = req.body;
  if (!name) return res.json({ code: 400, message: '团队名称不能为空' });
  try {
    const info = db.prepare('INSERT INTO teams (name, remark) VALUES (?, ?)').run(name, remark || '');
    res.json({ code: 200, data: { id: info.lastInsertRowid }, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '团队名称已存在' });
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', requireRole('super_admin'), (req, res) => {
  const { id, name, remark } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  try {
    db.prepare('UPDATE teams SET name = ?, remark = ? WHERE id = ?').run(name, remark || '', id);
    res.json({ code: 200, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '团队名称已存在' });
    res.json({ code: 500, message: err.message });
  }
});

router.delete('/delete/:id', requireRole('super_admin'), (req, res) => {
  const id = Number(req.params.id);
  const users = db.prepare('SELECT COUNT(*) c FROM users WHERE team_id = ?').get(id).c;
  const accounts = db.prepare('SELECT COUNT(*) c FROM emails WHERE team_id = ?').get(id).c;
  if (users > 0 || accounts > 0) {
    return res.json({ code: 400, message: `该团队下还有 ${users} 个成员、${accounts} 个账号，请先转移或删除` });
  }
  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  res.json({ code: 200, message: 'success' });
});

export default router;
