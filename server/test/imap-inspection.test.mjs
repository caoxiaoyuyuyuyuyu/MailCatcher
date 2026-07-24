import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runBatchImapInspection,
  supportsImapInspection,
} from '../src/services/imapInspection.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('batch inspection limits concurrency, preserves order and summarizes results', async () => {
  let active = 0;
  let peak = 0;
  const inspected = [];
  const passwords = {
    enc_ok: 'secret-ok',
    enc_bad: 'secret-bad',
    enc_web: 'secret-web',
  };

  const accounts = [
    { id: 1, address: 'display@example.test', fetch_address: 'inbox@163.com', source: 'self', password_enc: 'enc_ok' },
    { id: 2, address: 'broken@163.com', fetch_address: '', source: 'self', password_enc: 'enc_bad' },
    { id: 3, address: 'forward@example.test', source: 'forward', password_enc: '' },
    { id: 4, address: 'missing@163.com', source: 'self', password_enc: '' },
    { id: 5, address: 'browser@gazeta.pl', source: 'self', password_enc: 'enc_web' },
  ];

  const report = await runBatchImapInspection(accounts, {
    concurrency: 2,
    decryptPassword: encrypted => passwords[encrypted],
    supportsMailbox: async mailbox => !mailbox.endsWith('@gazeta.pl'),
    inspectConnection: async (mailbox, password) => {
      active += 1;
      peak = Math.max(peak, active);
      inspected.push({ mailbox, password });
      await wait(10);
      active -= 1;
      if (mailbox === 'broken@163.com') {
        throw new Error(`login failed for ${password}`);
      }
      return { success: true, server: 'imap.163.com:993', messages: 12 };
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(inspected.map(item => item.mailbox), ['inbox@163.com', 'broken@163.com']);
  assert.deepEqual(report.results.map(item => item.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    { total: report.total, success: report.success, failed: report.failed, skipped: report.skipped },
    { total: 5, success: 1, failed: 1, skipped: 3 },
  );
  assert.equal(report.results[0].mailbox, 'inbox@163.com');
  assert.equal(report.results[0].messages, 12);
  assert.equal(report.results[1].status, 'failed');
  assert.match(report.results[1].error, /login failed/);
  assert.doesNotMatch(JSON.stringify(report), /secret-ok|secret-bad|enc_ok|enc_bad/);
  assert.match(report.results[2].error, /非自管账号/);
  assert.match(report.results[3].error, /未配置收件密码/);
  assert.match(report.results[4].error, /Webmail|API/);
  assert.ok(report.duration_ms >= 0);
});

test('mailbox routing identifies accounts that do not use IMAP', async () => {
  assert.equal(await supportsImapInspection('user@163.com'), true);
  assert.equal(await supportsImapInspection('user@gazeta.pl'), false);
  assert.equal(await supportsImapInspection('user@mail.com'), false);
});
