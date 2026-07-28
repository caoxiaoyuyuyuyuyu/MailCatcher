import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'mailcatcher-token-migration-'));
const DB_FILE = join(DATA_DIR, 'mailcatcher.db');
const firstToken = 'legacy_plaintext_one';
const secondToken = 'legacy_plaintext_two';

process.env.MAILCATCHER_DATA_DIR = DATA_DIR;
process.env.ENCRYPTION_KEY = 'token-migration-test-key';

const { hashToken } = await import('../src/services/crypto.js');
const legacy = new Database(DB_FILE);
legacy.exec(`
  CREATE TABLE emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE NOT NULL,
    token TEXT,
    token_hash TEXT,
    token_enc TEXT DEFAULT '',
    token_prefix TEXT DEFAULT '',
    password TEXT,
    password_enc TEXT DEFAULT ''
  )
`);
legacy.prepare(
  'INSERT INTO emails (address, token, token_hash) VALUES (?, ?, ?)',
).run('matched@example.test', firstToken, hashToken(firstToken));
legacy.prepare(
  'INSERT INTO emails (address, token) VALUES (?, ?)',
).run('unhashed@example.test', secondToken);
const unrecoverableHash = hashToken('already_lost');
legacy.prepare(
  'INSERT INTO emails (address, token, token_hash) VALUES (?, ?, ?)',
).run('unrecoverable@example.test', unrecoverableHash, unrecoverableHash);
legacy.close();

const { default: db, initDb } = await import('../src/db.js');
const { decrypt } = await import('../src/services/crypto.js');

test('legacy plaintext tokens migrate only when verifiable and are scrubbed', async t => {
  t.after(async () => {
    await db.destroy();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  await initDb();
  const rows = await db('emails')
    .select('address', 'token', 'token_hash', 'token_enc')
    .orderBy('id');

  assert.equal(rows[0].token_hash, hashToken(firstToken));
  assert.equal(decrypt(rows[0].token_enc), firstToken);
  assert.equal(rows[0].token, rows[0].token_hash);

  assert.equal(rows[1].token_hash, hashToken(secondToken));
  assert.equal(decrypt(rows[1].token_enc), secondToken);
  assert.equal(rows[1].token, rows[1].token_hash);

  assert.equal(rows[2].token_hash, unrecoverableHash);
  assert.equal(rows[2].token_enc, '');
  assert.equal(rows[2].token, unrecoverableHash);
  assert.ok(rows.every(row => row.token !== firstToken && row.token !== secondToken));
});
