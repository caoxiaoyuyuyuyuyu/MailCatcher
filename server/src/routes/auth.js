import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { generateApiToken, hashToken } from '../services/crypto.js';

const router = Router();

function ensureDefaultAdmin() {
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    db.prepare('INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, 1)')
      .run('admin', bcrypt.hashSync('admin123', 10), 'admin');
  }
  // 历史三级角色统一为 admin（去团队后只有 admin / member）
  db.prepare("UPDATE users SET role = 'admin' WHERE role IN ('super_admin', 'team_admin')").run();
}
ensureDefaultAdmin();

// 允许注册的邮箱后缀（可用环境变量覆盖，默认公司域名）
const ALLOWED_EMAIL_SUFFIX = (process.env.REGISTER_EMAIL_SUFFIX || '@apexin.ai').toLowerCase();

// 自助注册：邮箱(限定后缀) + 密码二次确认。注册即为 member，由管理员后续按需升级。
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
    db.prepare('INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, ?, 1)')
      .run(email, bcrypt.hashSync(password, 10), 'member');
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
  res.json({
    code: 200,
    data: { accessToken: generateToken(user), id: user.id, username: user.username, role: user.role },
    message: 'success',
  });
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, role, status, api_key_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.json({ code: 401, message: '用户不存在' });
  const { api_key_hash, ...safe } = user;
  res.json({ code: 200, data: { ...safe, has_api_key: !!api_key_hash }, message: 'success' });
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
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), user.id);
  res.json({ code: 200, message: 'success' });
});

export default router;
