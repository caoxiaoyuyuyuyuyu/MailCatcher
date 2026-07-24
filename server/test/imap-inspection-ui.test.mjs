import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('account page exposes batch IMAP inspection and a result summary', () => {
  assert.match(html, /批量巡检 IMAP/);
  assert.match(html, /\/api\/admin\/email\/inspect-imap/);
  assert.match(html, /imapInspectionDialog/);
  assert.match(html, /imapInspectionReport\.(?:total|success|failed|skipped)/);
  assert.match(html, /selectedAccounts\.value\.map\(a => a\.id\)/);
  assert.match(html, /未选择时巡检全部可见账号/);
  assert.match(html, /<el-progress[^>]+imapInspectionProgress\.percent/);
  assert.match(html, /已检查.*imapInspectionProgress\.checked[\s\S]*剩余.*imapInspectionProgress\.remaining/);
  assert.match(html, /IMAP_INSPECTION_CLIENT_CONCURRENCY\s*=\s*5/);
  assert.match(html, /\{\s*ids:\s*\[target\.id\]\s*\}/);
  assert.match(html, /imapInspectionProgress\.checked\s*=\s*completed/);
});

test('inline application script remains valid JavaScript', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));
});
