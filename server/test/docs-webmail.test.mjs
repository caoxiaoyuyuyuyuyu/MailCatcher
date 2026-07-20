import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const file of ['README.md', 'TEST.md']) {
  const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
  assert.match(text, /gazeta\.pl/i, `${file} documents Gazeta`);
  assert.match(text, /onet\.pl/i, `${file} documents Onet`);
  assert.match(text, /WEBMAIL_SCAN_LIMIT|CHROME_PATH/i, `${file} documents webmail runtime config`);
  assert.match(text, /activation|套餐|启用/i, `${file} documents activation gate`);
}
