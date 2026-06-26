import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { encrypt, hashToken, maskToken } from './services/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAILCATCHER_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'mailcatcher.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    remark TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    team_id INTEGER,
    status INTEGER DEFAULT 1,
    api_key_hash TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mail_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 993,
    use_ssl INTEGER DEFAULT 1,
    use_proxy INTEGER DEFAULT 0,
    status INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
  );

  -- emails = 账号表（账号管理系统的核心实体）
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    source TEXT DEFAULT 'self',            -- self（自管，本地 IMAP/mailcom）| forward（171mail 转发）
    team_id INTEGER,                       -- 归属团队
    assignee_id INTEGER,                   -- 领用者（null=空闲）
    password_enc TEXT DEFAULT '',          -- 加密的 IMAP 密码（source=self）
    appkey TEXT DEFAULT '',
    forward_provider TEXT DEFAULT '',      -- 转发上游标识，如 171mail（source=forward）
    forward_token_enc TEXT DEFAULT '',     -- 加密的上游 token（source=forward）
    token_hash TEXT,                       -- 我们签发的查询令牌的 SHA-256（方案乙）
    token_prefix TEXT DEFAULT '',          -- 令牌掩码，仅用于后台展示
    health_status TEXT DEFAULT 'active',   -- active | error | banned | expired | disabled
    fail_count INTEGER DEFAULT 0,          -- 连续失败次数（用于自动标记 error）
    status INTEGER DEFAULT 1,              -- 启用开关（1 启用 / 0 停用）
    batch_no TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS account_status_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    from_status TEXT,
    to_status TEXT,
    changed_by INTEGER,                    -- user id；0/null 表示系统自动
    reason TEXT DEFAULT '',
    created_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER,
    email_address TEXT,
    team_id INTEGER,
    requested_by INTEGER,
    query_type TEXT,
    query_token TEXT,                      -- 仅存掩码，不存明文令牌
    subject TEXT,
    code TEXT,
    raw_body TEXT,
    success INTEGER DEFAULT 0,
    error_msg TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (email_id) REFERENCES emails(id)
  );
`);

// ── 幂等迁移：为已存在的旧库补齐新列 ─────────────────────
function addColumnIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

for (const [col, def] of [
  ['role', "TEXT DEFAULT 'member'"],
  ['team_id', 'INTEGER'],
  ['status', 'INTEGER DEFAULT 1'],
  ['api_key_hash', 'TEXT'],
]) addColumnIfMissing('users', col, def);

for (const [col, def] of [
  ['source', "TEXT DEFAULT 'self'"],
  ['team_id', 'INTEGER'],
  ['assignee_id', 'INTEGER'],
  ['password_enc', "TEXT DEFAULT ''"],
  ['fetch_address', "TEXT DEFAULT ''"],
  ['forward_provider', "TEXT DEFAULT ''"],
  ['forward_token_enc', "TEXT DEFAULT ''"],
  ['token_hash', 'TEXT'],
  ['token_prefix', "TEXT DEFAULT ''"],
  ['health_status', "TEXT DEFAULT 'active'"],
  ['fail_count', 'INTEGER DEFAULT 0'],
]) addColumnIfMissing('emails', col, def);

for (const [col, def] of [
  ['team_id', 'INTEGER'],
  ['requested_by', 'INTEGER'],
]) addColumnIfMissing('email_logs', col, def);

// 索引：必须在补齐新列之后创建（旧库升级路径下列才存在）
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_emails_token_hash ON emails(token_hash);
  CREATE INDEX IF NOT EXISTS idx_emails_team ON emails(team_id);
  CREATE INDEX IF NOT EXISTS idx_logs_team ON email_logs(team_id);
`);

// ── 一次性回填：把旧版明文 token/password 迁移到 token_hash/password_enc ──
// 幂等：仅处理新字段为空、且旧列存在且有值的行；让升级前已有账号原样继续可用。
(function backfillLegacyAccounts() {
  const cols = db.prepare('PRAGMA table_info(emails)').all().map(c => c.name);
  const hasLegacyToken = cols.includes('token');
  const hasLegacyPass = cols.includes('password');
  if (!hasLegacyToken && !hasLegacyPass) return;

  const sel = `SELECT id, token_hash, password_enc,
                 ${hasLegacyToken ? 'token' : "'' AS token"},
                 ${hasLegacyPass ? 'password' : "'' AS password"}
               FROM emails`;
  const updTok = db.prepare("UPDATE emails SET token_hash = ?, token_prefix = ? WHERE id = ?");
  const updPwd = db.prepare("UPDATE emails SET password_enc = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of db.prepare(sel).all()) {
      if (!r.token_hash && r.token) updTok.run(hashToken(r.token), maskToken(r.token), r.id);
      if ((!r.password_enc || r.password_enc === '') && r.password) updPwd.run(encrypt(r.password), r.id);
    }
  });
  tx();
})();

// ── 种子：默认团队 ───────────────────────────────────────
const hasTeam = db.prepare('SELECT id FROM teams LIMIT 1').get();
if (!hasTeam) {
  db.prepare('INSERT INTO teams (name, remark) VALUES (?, ?)').run('默认团队', '系统默认团队');
}

export default db;
