import {
  WebmailError,
  collectRecentMessages,
  createBrowserSession,
  fillFirstVisible,
  clickFirstVisible,
  pageText,
  parseMessageRows,
} from './webmailBrowser.js';

export const ONET_LOGIN_URL = 'https://poczta.onet.pl/';

export function parseOnetMessages(html, baseUrl = ONET_LOGIN_URL) {
  return parseMessageRows(html, baseUrl).map(({ href, ...mail }) => mail);
}

export function classifyOnetPage(text) {
  const value = String(text || '').toLowerCase();
  if (/wybierz plan|wybór planu|poczta basic|choose a plan|plan selection|oferta\.poczta/.test(value)) return 'activation';
  if (/captcha|recaptcha|kod jednorazowy|weryfikacj[ae].*(kod|tożsamo)|two[- ]factor|verification code/.test(value)) return 'challenge';
  if (/nieprawidł|niepopraw|błędne hasło|incorrect password|invalid password|wrong password/.test(value)) return 'credentials';
  return null;
}

function hasOnetInbox(text) {
  return /skrzynka odbiorcza|odebrane|inbox|mailbox|wiadomości|messages/i.test(String(text || ''));
}

export async function loginOnet(email, password, { session = null } = {}) {
  const ownedSession = session || await createBrowserSession();
  const page = ownedSession.page;
  try {
    await page.goto(ONET_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!await fillFirstVisible(page, [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]', 'input[autocomplete="username"]',
    ], email)) throw new WebmailError('onet', 'structure');
    if (!await clickFirstVisible(page, [
      'button:has-text("Next")', 'button:has-text("Dalej")', 'button:has-text("Continue")', 'button[type="submit"]',
    ])) throw new WebmailError('onet', 'structure');

    await page.waitForTimeout(500);
    if (!await fillFirstVisible(page, [
      'input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]',
    ], password)) throw new WebmailError('onet', 'structure');
    if (!await clickFirstVisible(page, [
      'button:has-text("Sign in")', 'button:has-text("Zaloguj")', 'button:has-text("Log in")', 'button[type="submit"]',
    ])) throw new WebmailError('onet', 'structure');

    await page.waitForTimeout(1200);
    let text = await pageText(page);
    let kind = classifyOnetPage(text);
    if (kind) throw new WebmailError('onet', kind);
    try {
      await page.waitForURL(url => !/konto\.onet\.pl\/(?:en\/)?signin/i.test(url.toString()), { timeout: 15000 });
    } catch {}
    text = await pageText(page);
    kind = classifyOnetPage(text);
    if (kind) throw new WebmailError('onet', kind);
    if (!hasOnetInbox(text) && /konto\.onet\.pl\/(?:en\/)?signin|platnosci\.poczta\.onet\.pl/i.test(page.url())) {
      throw new WebmailError('onet', 'structure');
    }
    if (!hasOnetInbox(text)) throw new WebmailError('onet', 'structure');
    return { page, session: ownedSession };
  } catch (err) {
    if (err instanceof WebmailError) throw err;
    throw new WebmailError('onet', 'network', err?.message || '请求失败');
  }
}

export async function fetchOnetEmails(email, password, options = {}) {
  const result = await loginOnet(email, password, options);
  try {
    return await collectRecentMessages(result.page, { baseUrl: result.page.url() });
  } finally {
    await result.session.close();
  }
}
