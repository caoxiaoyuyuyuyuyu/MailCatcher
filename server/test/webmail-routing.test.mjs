import assert from 'node:assert/strict';
import test from 'node:test';
import { getWebmailProvider, getKnownServer, getMailboxAccessMode } from '../src/services/imap.js';

test('webmail domains route independently from mail.com and IMAP', () => {
  assert.equal(getWebmailProvider('a@gazeta.pl'), 'gazeta');
  assert.equal(getWebmailProvider('a@onet.pl'), 'onet');
  assert.equal(getWebmailProvider('a@mail.com'), null);
  assert.equal(getWebmailProvider('a@example.com'), null);
});

test('Onet uses its official IMAP endpoint by default', () => {
  assert.deepEqual(getKnownServer('onet.pl'), { host: 'imap.poczta.onet.pl', port: 993, secure: true });
  assert.equal(getMailboxAccessMode('a@onet.pl'), 'imap');
  assert.equal(getMailboxAccessMode('a@gazeta.pl'), 'webmail');
});
