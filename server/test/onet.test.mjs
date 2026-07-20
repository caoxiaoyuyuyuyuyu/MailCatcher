import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOnetMessages, classifyOnetPage } from '../src/services/onet.js';

test('Onet parser normalizes inbox message fixture', () => {
  const [mail] = parseOnetMessages(`<article data-message-id="m1" data-date="2026-07-20T10:01:00Z">
    <a href="/mail/m1"><span data-field="from">noreply@openai.com</span>
    <span data-field="subject">Sign-in code</span></a>
    <div data-field="body">Verification code: 112233</div></article>`, 'https://poczta.onet.pl');
  assert.equal(mail.code, undefined);
  assert.equal(mail.subject, 'Sign-in code');
  assert.equal(mail.from, 'noreply@openai.com');
  assert.match(mail.body, /112233/);
  assert.equal(mail.date, '2026-07-20T10:01:00.000Z');
});

test('Onet plan page is an activation error, not a credential error', () => {
  assert.equal(classifyOnetPage('Wybierz plan odpowiedni dla Ciebie'), 'activation');
  assert.equal(classifyOnetPage('Nieprawidłowe hasło'), 'credentials');
  assert.equal(classifyOnetPage('captcha recaptcha'), 'challenge');
  assert.equal(classifyOnetPage('Skrzynka odbiorcza'), null);
});
