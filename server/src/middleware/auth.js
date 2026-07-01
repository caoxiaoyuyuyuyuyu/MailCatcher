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

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ code: 403, message: '权限不足' });
    }
    next();
  };
}

export const isAdmin = (req) => req.user?.role === 'admin';

export async function resolvePrincipal(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const cred = h.slice(7);
  try {
    return jwt.verify(cred, JWT_SECRET);
  } catch {}
  const u = await db('users')
    .whereNotNull('api_key_hash')
    .where('api_key_hash', hashToken(cred))
    .first();
  if (u && u.status !== 0) return u;
  return null;
}

export async function resolveAppKey(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const cred = h.slice(7);
  if (!cred.includes(':')) return null;
  const [keyPart, secretPart] = cred.split(':', 2);
  if (!keyPart || !secretPart) return null;
  const ak = await db('app_keys').where('key_hash', hashToken(keyPart)).first();
  if (!ak || ak.status !== 'active') return null;
  if (ak.secret_hash !== hashToken(secretPart)) return null;
  return ak;
}

export async function resolveIdentity(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const cred = h.slice(7);
  if (cred.includes(':')) {
    const ak = await resolveAppKey(req);
    if (ak) { req.appKey = ak; return ak; }
  }
  try {
    const user = jwt.verify(cred, JWT_SECRET);
    req.user = user;
    return user;
  } catch {}
  const u = await db('users')
    .whereNotNull('api_key_hash')
    .where('api_key_hash', hashToken(cred))
    .first();
  if (u && u.status !== 0) { req.user = u; return u; }
  return null;
}
