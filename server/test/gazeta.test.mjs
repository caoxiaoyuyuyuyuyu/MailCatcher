import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGazetaPage, parseGazetaMessages, loginGazeta } from '../src/services/gazeta.js';

test('Gazeta parser returns normalized message details', () => {
  const [mail] = parseGazetaMessages(`<div data-message-id="42" data-date="2026-07-20T10:00:00Z">
    <a href="/message/42"><span class="sender">noreply@openai.com</span>
    <span class="subject">Your verification code</span></a>
    <p class="message-body">Use code 654321</p></div>`, 'https://poczta.gazeta.pl');
  assert.equal(mail.from, 'noreply@openai.com');
  assert.equal(mail.subject, 'Your verification code');
  assert.match(mail.body, /654321/);
  assert.equal(mail.date, '2026-07-20T10:00:00.000Z');
});

test('Gazeta page classification distinguishes credentials and challenge', () => {
  assert.equal(classifyGazetaPage('Nieprawidłowe dane logowania'), 'credentials');
  assert.equal(classifyGazetaPage('Wpisz kod awaryjny'), 'challenge');
  assert.equal(classifyGazetaPage('Skrzynka odbiorcza'), null);
});

test('Gazeta login fixture reports bad credentials without leaking password', async () => {
  const fake = { loginPage: { body: 'Nieprawidłowe dane logowania' } };
  await assert.rejects(
    () => loginGazeta('a@gazeta.pl', 'secret', { fake }),
    err => err.kind === 'credentials' && !err.message.includes('secret'),
  );
});
