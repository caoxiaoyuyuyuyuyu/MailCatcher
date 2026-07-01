import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { generateApiToken, hashToken } from '../services/crypto.js';

const router = Router();

export async function ensureDefaultAdmin() {
  const admin = await db('users').where('username', 'admin').first();
  if (!admin) {
    await db('users').insert({
      username: 'admin',
      password_hash: bcrypt.hashSync('admin123', 10),
      role: 'admin',
      status: 1,
    });
  }
  await db('users').whereIn('role', ['super_admin', 'team_admin']).update({ role: 'admin' });
}

const ALLOWED_EMAIL_SUFFIX = (process.env.REGISTER_EMAIL_SUFFIX || '@apexin.ai').toLowerCase();

router.post('/register', async (req, res) => {
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
    await db('users').insert({
      username: email,
      password_hash: bcrypt.hashSync(password, 10),
      role: 'member',
      status: 1,
    });
    res.json({ code: 200, message: '注册成功，请登录' });
  } catch (err) {
    if (err.message.includes('UNIQUE') || err.code === '23505') return res.json({ code: 400, message: '该邮箱已注册' });
    res.json({ code: 500, message: err.message });
  }
});

router.post('/login', async (req, res) => {
  let { username, password } = req.body;
  if (!username || !password) {
    return res.json({ code: 400, message: '请输入用户名和密码' });
  }
  username = username.trim();
  if (username.includes('@')) username = username.toLowerCase();
  const user = await db('users').where('username', username).first();
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

router.get('/me', authMiddleware, async (req, res) => {
  const user = await db('users').select('id', 'username', 'role', 'status', 'api_key_hash').where('id', req.user.id).first();
  if (!user) return res.json({ code: 401, message: '用户不存在' });
  const { api_key_hash, ...safe } = user;
  res.json({ code: 200, data: { ...safe, has_api_key: !!api_key_hash }, message: 'success' });
});

router.post('/api-key', authMiddleware, async (req, res) => {
  const key = generateApiToken();
  await db('users').where('id', req.user.id).update({ api_key_hash: hashToken(key) });
  res.json({ code: 200, data: { apiKey: key }, message: 'success' });
});

router.post('/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const user = await db('users').where('id', req.user.id).first();
  if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.json({ code: 400, message: '原密码错误' });
  }
  await db('users').where('id', user.id).update({ password_hash: bcrypt.hashSync(newPassword, 10) });
  res.json({ code: 200, message: 'success' });
});

export default router;
