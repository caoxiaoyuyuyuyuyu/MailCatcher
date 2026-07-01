#!/usr/bin/env node
// 一次性脚本：将 SQLite 数据迁移到 PostgreSQL
// 用法: PG_HOST=.. PG_PORT=.. PG_USER=.. PG_PASSWORD=.. PG_DATABASE=.. node scripts/migrate-sqlite-to-pg.mjs

import Database from 'better-sqlite3';
import Knex from 'knex';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MAILCATCHER_DATA_DIR || join(__dirname, '..', 'data');
const sqliteDb = new Database(join(DATA_DIR, 'mailcatcher.db'));

const pg = Knex({
  client: 'pg',
  connection: process.env.DATABASE_URL || {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'mailcatcher',
    password: process.env.PG_PASSWORD || '',
    database: process.env.PG_DATABASE || 'mailcatcher',
  },
});

const TABLES_ORDER = ['teams', 'users', 'mail_servers', 'emails', 'account_status_logs', 'email_logs', 'account_grants', 'app_keys'];

async function migrate() {
  // First ensure PG schema exists by importing initDb
  console.log('初始化 PostgreSQL schema...');
  const origBackend = process.env.DB_BACKEND;
  process.env.DB_BACKEND = 'postgres';
  const { initDb } = await import('../src/db.js');
  await initDb();
  process.env.DB_BACKEND = origBackend;

  for (const table of TABLES_ORDER) {
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.length) { console.log(`  跳过 ${table}（SQLite 中不存在）`); continue; }

    // Check which columns exist in PG
    const pgCols = await pg(table).columnInfo();
    const commonCols = cols.filter(c => c in pgCols);

    const rows = sqliteDb.prepare(`SELECT ${commonCols.map(c => `"${c}"`).join(',')} FROM ${table}`).all();
    if (!rows.length) { console.log(`  ${table}: 0 行（空表）`); continue; }

    // Clear existing PG data
    await pg(table).del();

    // Insert in batches
    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      await pg(table).insert(rows.slice(i, i + BATCH));
    }

    // Reset sequence for tables with auto-increment
    if (commonCols.includes('id')) {
      const maxId = Math.max(...rows.map(r => r.id));
      await pg.raw(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), ?)`, [maxId]);
    }

    console.log(`  ${table}: ${rows.length} 行已迁移`);
  }

  console.log('\n迁移完成！');
  sqliteDb.close();
  await pg.destroy();
}

migrate().catch(err => {
  console.error('迁移失败:', err);
  process.exit(1);
});
