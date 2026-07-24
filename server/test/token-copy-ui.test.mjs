import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('assigned account rows expose the token copy action', () => {
  assert.match(
    html,
    /<el-button link size="small" type="primary" @click="copyAccountToken\(row\)">复制<\/el-button>/,
  );
});

test('token copy uses the authenticated reveal endpoint', () => {
  assert.match(
    html,
    /api\('POST', '\/api\/admin\/email\/reveal-token', \{ id: row\.id \}\)/,
  );
});

test('inline Vue script remains syntactically valid', () => {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  assert.ok(start >= '<script>'.length && end > start, 'inline script exists');
  new Function(html.slice(start, end));
});
