import { chromium } from 'playwright-core';

const CHROME_PATH = '/usr/bin/google-chrome';
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export async function triggerClaudeLogin(email) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: LAUNCH_ARGS,
    });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    let sendResult = null;
    page.on('response', async (resp) => {
      if (resp.url().includes('/api/auth/send_magic_link') && resp.status() === 200) {
        try { sendResult = await resp.json(); } catch {}
      }
    });

    await page.goto('https://claude.ai/login', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('input[type="email"]#email', { timeout: 15000 });

    await page.fill('input[type="email"]#email', email);
    await page.waitForTimeout(300);
    await page.click('button:has-text("Continue with email")');
    await page.waitForTimeout(5000);

    const cookies = await context.cookies();
    const cookieMap = Object.fromEntries(cookies.map(c => [c.name, c.value]));

    const deviceId = cookieMap['anthropic-device-id'] || '';
    const anonymousId = cookieMap['ajs_anonymous_id'] || '';

    const relevantNames = new Set([
      'pendingLogin', '__cf_bm', '_cfuvid', 'cf_clearance',
      'anthropic-device-id', 'ajs_anonymous_id', 'activitySessionId',
    ]);
    const cookieStr = cookies
      .filter(c => relevantNames.has(c.name) || c.domain.includes('claude.ai'))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    const clientSha = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      for (const s of scripts) {
        const m = s.src.match(/index-([a-zA-Z0-9]+)\.js/);
        if (m) return m[1];
      }
      return '';
    });

    if (!sendResult || !sendResult.sent) {
      const errorText = await page.textContent('body').catch(() => '');
      throw new Error(
        sendResult
          ? 'Claude 未能发送验证邮件'
          : `触发登录失败: ${errorText.substring(0, 200)}`
      );
    }

    return {
      anonymousId,
      clientSha,
      cookie: cookieStr,
      deviceId,
      email,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
