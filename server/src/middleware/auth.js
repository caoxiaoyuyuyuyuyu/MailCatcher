import jwt from 'jsonwebtoken';
import db from '../db.js';
import { hashToken } from '../services/crypto.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mailcatcher-secret-key-change-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] ⚠ 未设置 JWT_SECRET，使用默认值。生产环境务必设置！');
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }
}

// 角色门禁。单团队模型只有两种角色：admin / member
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ code: 403, message: '权限不足' });
    }
    next();
  };
}

export const isAdmin = (req) => req.user?.role === 'admin';

// 解析调用者身份：Bearer 既可是登录 JWT，也可是用户 API Key（按邮箱接码用）。
export function resolvePrincipal(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const cred = h.slice(7);
  try {
    return jwt.verify(cred, JWT_SECRET);
  } catch {}
  const u = db.prepare(
    'SELECT id, username, role, status FROM users WHERE api_key_hash IS NOT NULL AND api_key_hash = ?'
  ).get(hashToken(cred));
  if (u && u.status !== 0) return u;
  return null;
}
