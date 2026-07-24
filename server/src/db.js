import Knex from 'knex';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { encrypt, hashToken, maskToken } from './services/crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAILCATCHER_DATA_DIR || join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const DB_BACKEND = process.env.DB_BACKEND || 'sqlite';

const knexConfig = DB_BACKEND === 'postgres' ? {
  client: 'pg',
  connection: process.env.DATABASE_URL || {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'mailcatcher',
    password: process.env.PG_PASSWORD || '',
    database: process.env.PG_DATABASE || 'mailcatcher',
  },
  pool: { min: 2, max: 20 },
} : {
  client: 'better-sqlite3',
  connection: { filename: join(DATA_DIR, 'mailcatcher.db') },
  useNullAsDefault: true,
};

const db = Knex(knexConfig);

async function ensureSchema() {
  if (DB_BACKEND === 'sqlite') {
    await db.raw('PRAGMA journal_mode = WAL');
    await db.raw('PRAGMA foreign_keys = ON');
  }

  if (!await db.schema.hasTable('teams')) {
    await db.schema.createTable('teams', t => {
      t.increments('id');
      t.string('name').unique().notNullable();
      t.text('remark').defaultTo('');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  if (!await db.schema.hasTable('users')) {
    await db.schema.createTable('users', t => {
      t.increments('id');
      t.string('username').unique().notNullable();
      t.text('password_hash').notNullable();
      t.string('role', 20).defaultTo('member');
      t.integer('team_id');
      t.integer('status').defaultTo(1);
      t.text('api_key_hash');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  if (!await db.schema.hasTable('mail_servers')) {
    await db.schema.createTable('mail_servers', t => {
      t.increments('id');
      t.string('domain').unique().notNullable();
      t.string('host').notNullable();
      t.integer('port').defaultTo(993);
      t.integer('use_ssl').defaultTo(1);
      t.integer('use_proxy').defaultTo(0);
      t.integer('status').defaultTo(1);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!await db.schema.hasTable('emails')) {
    await db.schema.createTable('emails', t => {
      t.increments('id');
      t.string('address').unique().notNullable();
      t.string('source', 20).defaultTo('self');
      t.integer('team_id');
      t.integer('assignee_id');
      t.text('password_enc').defaultTo('');
      t.string('appkey').defaultTo('');
      t.string('forward_provider').defaultTo('');
      t.text('forward_token_enc').defaultTo('');
      t.text('token_hash');
      t.text('token_enc').defaultTo('');
      t.string('token_prefix').defaultTo('');
      t.string('health_status', 20).defaultTo('active');
      t.integer('fail_count').defaultTo(0);
      t.integer('status').defaultTo(1);
      t.string('batch_no').defaultTo('');
      t.text('fetch_address').defaultTo('');
      t.integer('created_by');
      t.integer('shared').defaultTo(0);
      t.string('purchaser').defaultTo('');
      t.integer('invoiced').defaultTo(0);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!await db.schema.hasTable('account_status_logs')) {
    await db.schema.createTable('account_status_logs', t => {
      t.increments('id');
      t.integer('account_id');
      t.string('from_status', 20);
      t.string('to_status', 20);
      t.integer('changed_by');
      t.text('reason').defaultTo('');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  if (!await db.schema.hasTable('email_logs')) {
    await db.schema.createTable('email_logs', t => {
      t.increments('id');
      t.integer('email_id').references('id').inTable('emails');
      t.string('email_address');
      t.integer('team_id');
      t.integer('requested_by');
      t.string('query_type');
      t.text('query_token');
      t.text('subject');
      t.text('code');
      t.text('raw_body');
      t.integer('success').defaultTo(0);
      t.text('error_msg');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  if (!await db.schema.hasTable('account_grants')) {
    await db.schema.createTable('account_grants', t => {
      t.increments('id');
      t.integer('account_id').notNullable();
      t.integer('user_id').notNullable();
      t.integer('granted_by');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.unique(['account_id', 'user_id']);
    });
  }

  if (!await db.schema.hasTable('app_keys')) {
    await db.schema.createTable('app_keys', t => {
      t.increments('id');
      t.string('name').notNullable();
      t.text('key_hash').notNullable().unique();
      t.text('secret_hash').notNullable();
      t.string('key_prefix', 30).defaultTo('');
      t.json('permissions').defaultTo('{}');
      t.json('rate_limit').defaultTo('{}');
      t.json('allowed_accounts').defaultTo('{}');
      t.string('status', 20).defaultTo('active');
      t.integer('created_by').references('id').inTable('users');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  // Add columns if missing (for upgrades from older versions)
  const addCol = async (table, col, builder) => {
    if (!await db.schema.hasColumn(table, col)) {
      await db.schema.alterTable(table, t => builder(t));
    }
  };
  for (const [col, fn] of [
    ['role', t => t.string('role', 20).defaultTo('member')],
    ['team_id', t => t.integer('team_id')],
    ['status', t => t.integer('status').defaultTo(1)],
    ['api_key_hash', t => t.text('api_key_hash')],
  ]) await addCol('users', col, fn);

  for (const [col, fn] of [
    ['source', t => t.string('source', 20).defaultTo('self')],
    ['team_id', t => t.integer('team_id')],
    ['assignee_id', t => t.integer('assignee_id')],
    ['password_enc', t => t.text('password_enc').defaultTo('')],
    ['fetch_address', t => t.text('fetch_address').defaultTo('')],
    ['forward_provider', t => t.string('forward_provider').defaultTo('')],
    ['forward_token_enc', t => t.text('forward_token_enc').defaultTo('')],
    ['token_hash', t => t.text('token_hash')],
    ['token_enc', t => t.text('token_enc').defaultTo('')],
    ['token_prefix', t => t.string('token_prefix').defaultTo('')],
    ['health_status', t => t.string('health_status', 20).defaultTo('active')],
    ['fail_count', t => t.integer('fail_count').defaultTo(0)],
    ['created_by', t => t.integer('created_by')],
    ['shared', t => t.integer('shared').defaultTo(0)],
    ['purchaser', t => t.string('purchaser').defaultTo('')],
    ['invoiced', t => t.integer('invoiced').defaultTo(0)],
  ]) await addCol('emails', col, fn);

  for (const [col, fn] of [
    ['team_id', t => t.integer('team_id')],
    ['requested_by', t => t.integer('requested_by')],
  ]) await addCol('email_logs', col, fn);

  // Indexes
  if (DB_BACKEND === 'sqlite') {
    await db.raw('CREATE INDEX IF NOT EXISTS idx_emails_token_hash ON emails(token_hash)');
    await db.raw('CREATE INDEX IF NOT EXISTS idx_emails_created_by ON emails(created_by)');
    await db.raw('CREATE INDEX IF NOT EXISTS idx_grants_user ON account_grants(user_id)');
    await db.raw('CREATE INDEX IF NOT EXISTS idx_grants_account ON account_grants(account_id)');
    await db.raw('CREATE INDEX IF NOT EXISTS idx_app_keys_key_hash ON app_keys(key_hash)');
  }
}

async function backfillLegacy() {
  const hasLegacyToken = await db.schema.hasColumn('emails', 'token');
  const hasLegacyPass = await db.schema.hasColumn('emails', 'password');
  if (!hasLegacyToken && !hasLegacyPass) return;

  const rows = await db('emails').select('id', 'token_hash', 'token_enc', 'password_enc',
    ...(hasLegacyToken ? [db.raw('"token"')] : [db.raw("'' as token")]),
    ...(hasLegacyPass ? [db.raw('"password"')] : [db.raw("'' as password")])
  );
  for (const r of rows) {
    if (!r.token_hash && r.token) {
      await db('emails').where('id', r.id).update({
        token_hash: hashToken(r.token),
        token_enc: encrypt(r.token),
        token_prefix: maskToken(r.token),
      });
    }
    if ((!r.password_enc || r.password_enc === '') && r.password) {
      await db('emails').where('id', r.id).update({ password_enc: encrypt(r.password) });
    }
  }
}

async function seedDefaults() {
  const hasTeam = await db('teams').first();
  if (!hasTeam) {
    await db('teams').insert({ name: '默认团队', remark: '系统默认团队' });
  }
}

export async function initDb() {
  await ensureSchema();
  await backfillLegacy();
  await seedDefaults();
}

export function hasLegacyTokenColumn() {
  return db.schema.hasColumn('emails', 'token');
}

export default db;
