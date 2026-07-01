import crypto from 'crypto';

// ── 主密钥 ──────────────────────────────────────────────
// 生产环境必须通过环境变量 ENCRYPTION_KEY 提供（任意长度字符串，内部派生 32 字节）
const RAW_KEY = process.env.ENCRYPTION_KEY || 'mailcatcher-default-encryption-key-change-me';
if (!process.env.ENCRYPTION_KEY) {
  console.warn('[crypto] ⚠ 未设置 ENCRYPTION_KEY，使用默认密钥。生产环境务必设置，否则密文不安全！');
}
const KEY = crypto.createHash('sha256').update(RAW_KEY).digest(); // 32 bytes

// ── 可逆加密：AES-256-GCM ───────────────────────────────
// 用于必须还原的密钥（IMAP 密码、171mail 转发 token）
// 输出格式：base64( iv[12] | authTag[16] | ciphertext )
export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('解密失败（ENCRYPTION_KEY 可能已变更或数据损坏）');
  }
}

// ── 不可逆 token：用于我们自己签发的查询令牌 / API Key ──
// 方案乙：所有账号对外都用我们签发的 token，库里只存 hash，创建时明文仅显示一次
export function generateApiToken() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function generateAppKey() {
  return 'ak_' + crypto.randomBytes(20).toString('hex');
}

export function generateAppSecret() {
  return 'sk_' + crypto.randomBytes(32).toString('hex');
}

export function maskToken(token) {
  if (!token) return '';
  const t = String(token);
  if (t.length <= 8) return t.slice(0, 2) + '****';
  return t.slice(0, 4) + '****' + t.slice(-4);
}
