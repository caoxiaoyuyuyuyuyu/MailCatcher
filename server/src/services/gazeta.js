import {
  WebmailError,
  collectRecentMessages,
  createBrowserSession,
  fillFirstVisible,
  clickFirstVisible,
  pageText,
  parseMessageRows,
} from './webmailBrowser.js';

export const GAZETA_LOGIN_URL = 'https://oauth.gazeta.pl/poczta/auth';
const GAZETA_INBOX_URL = 'https://poczta.gazeta.pl/';

export function parseGazetaMessages(html, baseUrl = GAZETA_INBOX_URL) {
  return parseMessageRows(html, baseUrl).map(({ href, ...mail }) => mail);
}

export function classifyGazetaPage(text) {
  const value = String(text || '').toLowerCase();
  if (/nieprawidł|niepopraw|błędne dane|złe hasło|zly haslo|invalid password/.test(value)) return 'credentials';
  if (/kod awaryjny|weryfikacj[ae].*dwuetap|captcha|recaptcha|kod jednorazowy/.test(value)) return 'challenge';
  return null;
}

function hasGazetaInbox(text) {
  return /skrzynka odbiorcza|odebrane|inbox|wiadomości|wiadom[oó]ści/i.test(String(text || ''));
}

export async function loginGazeta(email, password, { session = null, fake = null } = {}) {
  if (fake) {
    const kind = classifyGazetaPage(fake.loginPage?.body || '');
    if (kind) throw new WebmailError('gazeta', kind);
    return { page: fake.loginPage, session: null };
  }

  const ownedSession = session || await createBrowserSession();
  const page = ownedSession.page;
  try {
    await page.goto(GAZETA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const emailFilled = await fillFirstVisible(page, [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]', 'input[autocomplete="username"]',
    ], email);
    const passwordFilled = await fillFirstVisible(page, [
      'input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]',
    ], password);
    if (!emailFilled || !passwordFilled) throw new WebmailError('gazeta', 'structure');
    if (!await clickFirstVisible(page, ['button[type="submit"]', 'button:has-text("Zaloguj")', 'input[type="submit"]'])) {
      throw new WebmailError('gazeta', 'structure');
    }
    await page.waitForTimeout(1000);
    const text = await pageText(page);
    const kind = classifyGazetaPage(text);
    if (kind) throw new WebmailError('gazeta', kind);
    try { await page.waitForURL(url => !/oauth\.gazeta\.pl\/poczta\/auth/i.test(url.toString()), { timeout: 15000 }); } catch {}
    const afterLogin = await pageText(page);
    if (!hasGazetaInbox(afterLogin) && /oauth\.gazeta\.pl\/poczta\/auth/i.test(page.url())) {
      throw new WebmailError('gazeta', 'structure');
    }
    return { page, session: ownedSession };
  } catch (err) {
    if (err instanceof WebmailError) {
      if (!session) await ownedSession.close();
      throw err;
    }
    if (!session) await ownedSession.close();
    throw new WebmailError('gazeta', 'network', err?.message || '请求失败');
  }
}

export async function fetchGazetaEmails(email, password, options = {}) {
  const result = await loginGazeta(email, password, options);
  if (!result.session) return [];
  try {
    return await collectRecentMessages(result.page, { baseUrl: result.page.url() });
  } finally {
    await result.session.close();
  }
}
