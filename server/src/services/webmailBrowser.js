import { chromium } from 'playwright-core';

const DEFAULT_UA = process.env.WEBMAIL_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const DEFAULT_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
const ERROR_LABELS = {
  credentials: '登录失败：邮箱或密码错误',
  challenge: '登录需要额外验证，暂不支持自动取码',
  activation: '邮箱服务尚未启用，请先在官方页面完成套餐/服务启用',
  structure: '无法初始化邮箱会话',
  network: '网页登录网络请求失败',
};

export class WebmailError extends Error {
  constructor(provider, kind, detail = '') {
    const name = provider ? `${provider[0].toUpperCase()}${provider.slice(1)}` : 'Webmail';
    const safeDetail = String(detail || '')
      .replace(/password|passwd|cookie|authorization|token|secret/gi, '[已隐藏]')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 180);
    const suffix = safeDetail && !ERROR_LABELS[kind]?.includes(safeDetail) ? `：${safeDetail}` : '';
    super(`${name} ${ERROR_LABELS[kind] || ERROR_LABELS.structure}${suffix}`);
    this.name = 'WebmailError';
    this.provider = provider;
    this.kind = ERROR_LABELS[kind] ? kind : 'structure';
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(value) {
  return decodeEntities(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--(?:[\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function fieldText(block, pattern) {
  const re = new RegExp(`<([a-z0-9]+)\\b[^>]*(?:${pattern})[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  const match = String(block || '').match(re);
  return match ? stripHtml(match[2]) : '';
}

export function extractLinksAndText(html) {
  const source = String(html || '');
  const links = [];
  const linkRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of source.matchAll(linkRe)) links.push(decodeEntities(match[1]));
  return { text: stripHtml(source), links: [...new Set(links)] };
}

function rowBlocks(html) {
  const source = String(html || '');
  const blocks = [];
  const rowRe = /<(li|tr|article|section|div)\b([^>]*(?:data-message-id|data-messageid|data-testid\s*=\s*["'][^"']*(?:message|mail)|role\s*=\s*["']row["'])[^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(rowRe)) blocks.push({ tag: match[0], attrs: match[2], body: match[3] });
  return blocks;
}

function normaliseDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseMessageRows(html, baseUrl = '') {
  const rows = [];
  const seen = new Set();
  for (const row of rowBlocks(html)) {
    const links = extractLinksAndText(row.body).links.map(link => {
      try { return new URL(link, baseUrl || undefined).href; } catch { return link; }
    });
    const href = links[0];
    const from = fieldText(row.body, "(?:class|data-field)\\s*=\\s*[\\\"'][^\\\"']*(?:from|sender)[^\\\"']*[\\\"']") ||
      fieldText(row.body, "data-field\\s*=\\s*[\\\"']from[\\\"']");
    const subject = fieldText(row.body, "(?:class|data-field)\\s*=\\s*[\\\"'][^\\\"']*subject[^\\\"']*[\\\"']") ||
      (href ? stripHtml(row.body).replace(from, '').trim() : '');
    const body = fieldText(row.body, "(?:class|data-field)\\s*=\\s*[\\\"'][^\\\"']*(?:message-)?body[^\\\"']*[\\\"']") ||
      fieldText(row.body, "data-testid\\s*=\\s*[\\\"'][^\\\"']*body[^\\\"']*[\\\"']");
    const rawDate = attribute(row.attrs, 'data-date') || attribute(row.attrs, 'datetime');
    const date = normaliseDate(rawDate);
    const key = href || `${subject}\u0000${from}\u0000${date || ''}`;
    if (seen.has(key) || (!subject && !body && !from)) continue;
    seen.add(key);
    rows.push({ subject, from, body, links: [...new Set(links)], ...(date ? { date } : {}), ...(href ? { href } : {}) });
  }
  return rows;
}

export async function createBrowserSession({
  headless = true,
  executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome',
  launch = chromium.launch.bind(chromium),
} = {}) {
  const browser = await launch({ headless, executablePath, args: DEFAULT_ARGS });
  const context = await browser.newContext({ userAgent: DEFAULT_UA, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  }).catch(() => {});
  return {
    browser,
    context,
    page,
    async close() { await context.close().catch(() => {}); await browser.close().catch(() => {}); },
  };
}

export async function pageText(page) {
  return page.locator('body').innerText().catch(async () => stripHtml(await page.content().catch(() => '')));
}

export async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0) && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

export async function fillFirstVisible(page, selectors, value) {
  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) return false;
  await locator.fill(value);
  return true;
}

export async function clickFirstVisible(page, selectors) {
  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) return false;
  await locator.click();
  return true;
}

export async function collectRecentMessages(page, { baseUrl = page.url(), limit = Number(process.env.WEBMAIL_SCAN_LIMIT || 15) } = {}) {
  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return ''; } })();
  const rows = parseMessageRows(await page.content(), baseUrl)
    .filter(row => !row.href || !origin || (() => { try { return new URL(row.href).origin === origin; } catch { return false; } })())
    .slice(0, limit);
  const needsDetail = rows.filter(row => !row.body && row.href);
  if (!needsDetail.length) return rows.map(({ href, ...row }) => row);

  const detailPage = await page.context().newPage();
  try {
    for (const row of needsDetail) {
      try {
        await detailPage.goto(row.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const detailRows = parseMessageRows(await detailPage.content(), detailPage.url());
        const detail = detailRows.find(item => item.body) || detailRows[0];
        if (detail?.body) Object.assign(row, detail);
      } catch {
        // One malformed message should not hide the other recent messages.
      }
    }
  } finally {
    await detailPage.close().catch(() => {});
  }
  return rows.map(({ href, ...row }) => row);
}
