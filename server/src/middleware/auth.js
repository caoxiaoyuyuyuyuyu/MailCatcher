import jwt from 'jsonwebtoken';
import db from '../db.js';
import { hashToken } from '../services/crypto.js';

const JWT_SECRET = process.env.JWT_SECRET || 'mailcatcher-secret-key-change-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] ⚠ 未设置 JWT_SECRET，使用默认值。生产环境务必设置！');
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, team_id: user.team_id ?? null },
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

// 角色门禁：requireRole('super_admin') / requireRole('super_admin','team_admin')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ code: 403, message: '权限不足' });
    }
    next();
  };
}

export const isSuper = (req) => req.user?.role === 'super_admin';

// 团队隔离辅助：super_admin 不受限；其余仅限本团队。
// 返回 { clause, params }，用于拼接到 WHERE 后（clause 形如 "AND team_id = ?"）。
export function teamScope(req, column = 'team_id') {
  if (isSuper(req)) return { clause: '', params: [] };
  return { clause: ` AND ${column} = ?`, params: [req.user.team_id ?? -1] };
}

// 解析调用者身份：Bearer 既可是登录 JWT，也可是用户 API Key（按邮箱接码用）。
// 返回 { id, username, role, team_id } 或 null。
export function resolvePrincipal(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const cred = h.slice(7);
  try {
    return jwt.verify(cred, JWT_SECRET);
  } catch {}
  const u = db.prepare(
    'SELECT id, username, role, team_id, status FROM users WHERE api_key_hash IS NOT NULL AND api_key_hash = ?'
  ).get(hashToken(cred));
  if (u && u.status !== 0) return u;
  return null;
}
