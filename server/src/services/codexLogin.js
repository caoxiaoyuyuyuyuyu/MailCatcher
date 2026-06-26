import { chromium } from 'playwright-core';

// 触发 OpenAI(ChatGPT/Codex) 的「邮箱验证码」登录：
// 打开登录页 → 填邮箱 → 回车 → OpenAI 给该邮箱发一封「临时登录代码」。
// 这些 Codex 账号是纯邮箱 OTP（无需密码），实测填邮箱即可触发发码、未遇验证码拦截。
// 发码后由统一接码（self + fetch_address 转发收件箱）把码取回来。

const CHROME_PATH = '/usr/bin/google-chrome';
const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage',
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export async function triggerCodexLogin(email) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH, args: LAUNCH_ARGS });
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

    await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);

    const input = await page.$('input[type="email"], input[name="email"], input[autocomplete="username"]');
    if (!input) throw new Error('未找到邮箱输入框（登录页可能改版或被风控拦截）');
    await input.fill(email);
    await input.press('Enter'); // 回车提交邮箱，避开「Continue with Google」等社交按钮
    await page.waitForTimeout(6000);

    const url = page.url();
    const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    if (/email-verification/i.test(url) || /Check your inbox|verification code|验证码|登录代码/i.test(text)) {
      return { sent: true, email };
    }
    if (/captcha|are you human|arkose|challenge/i.test(text)) {
      throw new Error('触发被风控拦截（验证码/人机校验）');
    }
    throw new Error('未能触发发码: ' + text.slice(0, 150));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
