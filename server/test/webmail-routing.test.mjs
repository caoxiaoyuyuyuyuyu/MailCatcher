import assert from 'node:assert/strict';
import test from 'node:test';
import { getWebmailProvider } from '../src/services/imap.js';

test('webmail domains route independently from mail.com and IMAP', () => {
  assert.equal(getWebmailProvider('a@gazeta.pl'), 'gazeta');
  assert.equal(getWebmailProvider('a@onet.pl'), 'onet');
  assert.equal(getWebmailProvider('a@mail.com'), null);
  assert.equal(getWebmailProvider('a@example.com'), null);
});
