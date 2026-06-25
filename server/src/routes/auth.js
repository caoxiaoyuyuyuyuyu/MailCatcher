import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';

const router = Router();

function ensureDefaultAdmin() {
  const admin = db.prepare('SELECT id, role FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run('admin', hash, 'super_admin');
  } else if (admin.role === 'admin') {
    // 旧库：把历史 admin 角色升级为 super_admin
    db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(admin.id);
  }
}
ensureDefaultAdmin();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.json({ code: 400, message: '请输入用户名和密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.json({ code: 401, message: '用户名或密码错误' });
  }
  if (user.status === 0) {
    return res.json({ code: 403, message: '该账号已被停用' });
  }
  const token = generateToken(user);
  const team = user.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(user.team_id) : null;
  res.json({
    code: 200,
    data: {
      accessToken: token,
      username: user.username,
      role: user.role,
      team_id: user.team_id ?? null,
      team_name: team?.name ?? null,
    },
    message: 'success',
  });
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, role, team_id, status FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.json({ code: 401, message: '用户不存在' });
  const team = user.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(user.team_id) : null;
  res.json({ code: 200, data: { ...user, team_name: team?.name ?? null }, message: 'success' });
});

router.post('/change-password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.json({ code: 400, message: '原密码错误' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ code: 200, message: 'success' });
});

export default router;
