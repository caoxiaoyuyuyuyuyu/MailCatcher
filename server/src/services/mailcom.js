const BASE = 'https://lightmailer.mail.com';
const LOGIN_URL = 'https://login.mail.com/login';
const HOME_URL = 'https://www.mail.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

class CookieJar {
  constructor() { this.cookies = new Map(); }

  update(resp) {
    const setCookies = resp.headers.getSetCookie?.() || [];
    for (const raw of setCookies) {
      const pair = raw.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq), pair);
    }
  }

  toString() {
    return [...this.cookies.values()].join('; ');
  }
}

async function doFetch(url, opts, jar) {
  const headers = { 'User-Agent': UA, ...(opts.headers || {}) };
  if (jar) headers['Cookie'] = jar.toString();
  const resp = await fetch(url, { ...opts, headers });
  if (jar) jar.update(resp);
  return resp;
}

async function followRedirects(url, jar, maxRedirects = 5) {
  let resp;
  for (let i = 0; i < maxRedirects; i++) {
    resp = await doFetch(url, { redirect: 'manual' }, jar);
    const loc = resp.headers.get('location');
    if (!loc || (resp.status !== 301 && resp.status !== 302 && resp.status !== 303)) break;
    await resp.text();
    url = loc.startsWith('http') ? loc : new URL(loc, url).href;
  }
  return resp;
}

async function login(email, password) {
  const jar = new CookieJar();

  const homeResp = await doFetch(HOME_URL, {}, jar);
  const homeHtml = await homeResp.text();
  const stats = homeHtml.match(/name="statistics"\s*value="([^"]*)"/)?.[1] || '';

  const body = new URLSearchParams({
    service: 'mailint',
    statistics: stats,
    uasServiceID: 'mc_starter_mailcom',
    successURL: 'https://$(clientName)-$(dataCenter).mail.com/login',
    loginFailedURL: 'https://www.mail.com/logout/?ls=wd',
    loginErrorURL: 'https://www.mail.com/logout/?ls=te',
    edition: 'us',
    lang: 'en',
    usertype: 'standard',
    username: email,
    password: password,
  });

  const loginResp = await doFetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': HOME_URL },
    body: body.toString(),
    redirect: 'manual',
  }, jar);
  await loginResp.text();

  const location = loginResp.headers.get('location') || '';
  if (!location.includes('ott=')) {
    throw new Error('mail.com 登录失败: 用户名或密码错误');
  }

  await followRedirects(location, jar);

  const ottMatch = location.match(/ott=([^&]+)/);
  const ott = ottMatch?.[1] || '';

  const lmResp = await followRedirects(`${BASE}/start?device=desktop&ott=${ott}`, jar);
  await lmResp.text();

  const tcfResp = await doFetch(`${BASE}/start?0-1.0-&device=desktop`, {
    headers: { 'Wicket-Ajax': 'true', 'Wicket-Ajax-BaseURL': 'start?0&device=desktop' },
  }, jar);
  const tcfXml = await tcfResp.text();

  const redirectPath = tcfXml.match(/<redirect><!\[CDATA\[\.\/([^\]]*)\]\]>/)?.[1];
  if (!redirectPath) {
    throw new Error('mail.com 无法初始化邮箱会话');
  }

  const folderResp = await followRedirects(`${BASE}/${redirectPath}`, jar);
  const folderHtml = await folderResp.text();

  const inboxMatch = folderHtml.match(/folderId=(\d+)[^>]*data-webdriver="INBOX/);
  const folderId = inboxMatch?.[1] || null;

  if (!folderId) {
    throw new Error('mail.com 无法找到收件箱');
  }

  return { jar, folderId };
}

function parseMessageList(html) {
  const messages = [];
  const itemRegex = /messagedetail\?folderId=(\d+)&(?:amp;)?mailIndex=(\d+)&(?:amp;)?mailId=(\d+)/g;
  const subjectRegex = /mail-header__subject">([^<]*)/g;

  const links = [...html.matchAll(itemRegex)];
  const subjects = [...html.matchAll(subjectRegex)];

  for (let i = 0; i < links.length; i++) {
    const [fullLink, folderId, mailIndex, mailId] = links[i];
    const subject = subjects[i]?.[1]?.trim() || '';
    messages.push({
      link: `messagedetail?folderId=${folderId}&mailIndex=${mailIndex}&mailId=${mailId}`,
      subject,
    });
  }
  return messages;
}

async function readMessage(jar, link) {
  const resp = await doFetch(`${BASE}/${link}`, {}, jar);
  const html = await resp.text();

  const subject = html.match(/mail-header__subject">([^<]*)/)?.[1]?.trim() || '';
  const from = html.match(/From:<\/span>\s*([^<]*)/)?.[1]?.trim() || '';

  const mailIdMatch = link.match(/mailId=(\d+)/);
  let body = '';
  let links = [];
  if (mailIdMatch) {
    const bodyResp = await doFetch(`${BASE}/mailbody/${mailIdMatch[1]}/false`, {}, jar);
    const bodyHtml = await bodyResp.text();

    const allTextUrls = bodyHtml.matchAll(/https?:\/\/[^\s"'<>]+/g);
    for (const m of allTextUrls) {
      const u = m[0].replace(/&amp;/g, '&');
      if (u.includes('mail.com') || u.includes('uicdn') || u.includes('tifbs')) continue;
      if (u.match(/\.(png|jpg|gif|ico|css|js)$/i)) continue;
      links.push(u);
    }

    links.sort((a, b) => {
      const scoreLink = (url) => {
        if (url.includes('magic-link')) return 100;
        if (url.match(/verify|login|auth|confirm|activate|code/i)) return 50;
        return 0;
      };
      return scoreLink(b) - scoreLink(a);
    });

    body = bodyHtml
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { subject, from, body: body.substring(0, 3000), links };
}

export async function fetchMailcomEmails(email, password) {
  const { jar, folderId } = await login(email, password);

  const listResp = await followRedirects(`${BASE}/messagelist?folderId=${folderId}`, jar);
  const listHtml = await listResp.text();

  const messages = parseMessageList(listHtml);
  if (messages.length === 0) return [];

  // 共用收件箱转发时，一批邮件涌入会把目标挤出前几封，扫描条数放宽（可配 MAILCOM_SCAN_LIMIT）
  const scanLimit = Number(process.env.MAILCOM_SCAN_LIMIT || 15);
  const results = [];
  for (const msg of messages.slice(0, scanLimit)) {
    const detail = await readMessage(jar, msg.link);
    results.push(detail);
  }

  return results;
}
