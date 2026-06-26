import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { generateApiToken, hashToken } from '../services/crypto.js';

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

// 允许注册的邮箱后缀（可用环境变量覆盖，默认公司域名）
const ALLOWED_EMAIL_SUFFIX = (process.env.REGISTER_EMAIL_SUFFIX || '@apexin.ai').toLowerCase();

// 自助注册：邮箱(限定后缀) + 密码二次确认。注册即为 member，团队由管理员后续在用户管理中分配。
router.post('/register', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const { password, confirmPassword } = req.body;
  if (!email || !password) return res.json({ code: 400, message: '请输入邮箱和密码' });
  if (!email.endsWith(ALLOWED_EMAIL_SUFFIX)) {
    return res.json({ code: 400, message: `邮箱必须使用 ${ALLOWED_EMAIL_SUFFIX} 后缀` });
  }
  if (confirmPassword !== undefined && password !== confirmPassword) {
    return res.json({ code: 400, message: '两次输入的密码不一致' });
  }
  if (String(password).length < 6) return res.json({ code: 400, message: '密码至少 6 位' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash, role, team_id, status) VALUES (?, ?, ?, NULL, 1)')
      .run(email, hash, 'member');
    res.json({ code: 200, message: '注册成功，请登录' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.json({ code: 400, message: '该邮箱已注册' });
    res.json({ code: 500, message: err.message });
  }
});

router.post('/login', (req, res) => {
  let { username, password } = req.body;
  if (!username || !password) {
    return res.json({ code: 400, message: '请输入用户名和密码' });
  }
  username = username.trim();
  if (username.includes('@')) username = username.toLowerCase(); // 邮箱登录大小写不敏感
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
      id: user.id,
      username: user.username,
      role: user.role,
      team_id: user.team_id ?? null,
      team_name: team?.name ?? null,
    },
    message: 'success',
  });
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, role, team_id, status, api_key_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.json({ code: 401, message: '用户不存在' });
  const team = user.team_id ? db.prepare('SELECT name FROM teams WHERE id = ?').get(user.team_id) : null;
  const { api_key_hash, ...safe } = user;
  res.json({ code: 200, data: { ...safe, team_name: team?.name ?? null, has_api_key: !!api_key_hash }, message: 'success' });
});

// 自助生成/重置个人 API Key（用于 CLI/Agent 按邮箱取码）；明文仅此一次返回
router.post('/api-key', authMiddleware, (req, res) => {
  const key = generateApiToken();
  db.prepare('UPDATE users SET api_key_hash = ? WHERE id = ?').run(hashToken(key), req.user.id);
  res.json({ code: 200, data: { apiKey: key }, message: 'success' });
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
