import { ImapFlow } from 'imapflow';
import { resolveMx } from 'node:dns/promises';
import db from '../db.js';

const mxCache = new Map();

const KNOWN_SERVERS = {
  'gmail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'googlemail.com': { host: 'imap.gmail.com', port: 993, secure: true },
  'outlook.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'hotmail.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'live.com': { host: 'outlook.office365.com', port: 993, secure: true },
  'yahoo.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  'icloud.com': { host: 'imap.mail.me.com', port: 993, secure: true },
  'mail.com': { host: 'imap.mail.com', port: 993, secure: true },
  'qq.com': { host: 'imap.qq.com', port: 993, secure: true },
  '163.com': { host: 'imap.163.com', port: 993, secure: true },
  '126.com': { host: 'imap.126.com', port: 993, secure: true },
  'sina.com': { host: 'imap.sina.com', port: 993, secure: true },
  'yeah.net': { host: 'imap.yeah.net', port: 993, secure: true },
  'zoho.com': { host: 'imap.zoho.com', port: 993, secure: true },
  'protonmail.com': { host: 'imap.protonmail.ch', port: 993, secure: true },
  'aol.com': { host: 'imap.aol.com', port: 993, secure: true },
  'gmx.com': { host: 'imap.gmx.com', port: 993, secure: true },
  'yandex.com': { host: 'imap.yandex.com', port: 993, secure: true },
  'onet.pl': { host: 'imap.poczta.onet.pl', port: 993, secure: true },
};

export function getKnownServer(domain) {
  return KNOWN_SERVERS[String(domain || '').toLowerCase()] || null;
}

async function isMxMailcom(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  try {
    const records = await resolveMx(domain);
    const hit = records.some(r => r.exchange.toLowerCase().endsWith('.mail.com'));
    mxCache.set(domain, hit);
    return hit;
  } catch {
    mxCache.set(domain, false);
    return false;
  }
}

async function getServerConfig(emailAddress) {
  const domain = emailAddress.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const server = await db('mail_servers').where({ domain, status: 1 }).first();
  if (server) {
    return { host: server.host, port: server.port, secure: !!server.use_ssl };
  }

  if (getKnownServer(domain)) return getKnownServer(domain);

  return { host: `imap.${domain}`, port: 993, secure: true };
}

const CODE_PATTERNS = [
  /verification\s*code[:\s]*(\d{4,8})/i,
  /验证码[：:\s]*(\d{4,8})/,
  /code[:\s]*(\d{4,8})/i,
  /OTP[:\s]*(\d{4,8})/i,
  /\b(\d{6})\b/,
];

const TYPE_FILTERS = {
  gpt: {
    from: ['noreply@tm.openai.com', 'noreply@email.openai.com', 'support@openai.com'],
    subject: /openai|chatgpt|verify|verification|login|code/i,
  },
  chatgpt: {
    from: ['noreply@tm.openai.com', 'noreply@email.openai.com', 'support@openai.com'],
    subject: /openai|chatgpt|verify|verification|login|code/i,
  },
  claude: {
    from: ['noreply@anthropic.com', 'support@anthropic.com', 'no-reply@mail.anthropic.com'],
    subject: /anthropic|claude|verify|verification|login|code/i,
  },
  google: {
    from: ['noreply@google.com', 'no-reply@accounts.google.com'],
    subject: /google|verify|verification|code/i,
  },
  telegram: {
    from: ['noreply@telegram.org', 'notify@telegram.org'],
    subject: /telegram|login|code/i,
  },
  grok: {
    from: ['noreply@x.com', 'verify@x.com', 'info@x.com'],
    subject: /grok|x\.com|verify|code/i,
  },
  chipper: {
    from: [],
    subject: /chipper|verify|code/i,
  },
};

export function extractCode(text) {
  if (!text) return null;
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractLink(text) {
  if (!text) return null;
  const magicLink = text.match(/https?:\/\/[^\s<>"']*magic-link[^\s<>"']*/);
  if (magicLink) return magicLink[0];
  const verifyLink = text.match(/https?:\/\/[^\s<>"']*(?:verify|login|auth|confirm|activate)[^\s<>"']*/i);
  if (verifyLink) return verifyLink[0];
  const linkMatch = text.match(/https?:\/\/[^\s<>"']+/);
  return linkMatch ? linkMatch[0] : null;
}

// 取码回溯时间窗（分钟）。转发有延迟，默认放宽到 30 分钟，可用 FETCH_LOOKBACK_MINUTES 覆盖
export const LOOKBACK_MINUTES = Number(process.env.FETCH_LOOKBACK_MINUTES || 30);

// 判断一封邮件是否命中指定类型。
// 关键：转发后外层发件人会被改写成转发者地址，导致按 from 过滤失效。
// 因此发件人匹配同时在 from + subject + body 里找已知发件地址——
// 转发邮件正文通常保留原始「From: xxx@openai.com」，这样转发/直收都能命中。
export function messageMatchesType(type, { from = '', subject = '', body = '' } = {}) {
  if (type === 'all') return true;
  const typeFilter = TYPE_FILTERS[type] || TYPE_FILTERS.gpt;
  const haystack = `${from} ${subject} ${body}`.toLowerCase();
  const fromMatch = typeFilter.from.length === 0 ||
    typeFilter.from.some(f => haystack.includes(f.toLowerCase()));
  const subjectMatch = typeFilter.subject.test(subject);
  return fromMatch || subjectMatch;
}

// 登录/安全「通知」邮件——不含验证码，取码时必须跳过，
// 否则会把通知正文里的追踪链接（如 sendgrid）误当成验证码返回。
// 注意避开「登录代码/登录码」这类真正的验证码主题。
const NOTIFICATION_SUBJECT = /new sign-?in to your|new sign-?in|new login to your|检测到.*登录|新的?登录活动|security alert|安全提醒|安全警报/i;

// 这些类型的「码」本身就是链接（magic-link）；其余类型只认数字验证码，不拿链接兜底。
const LINK_BASED_TYPES = new Set(['claude']);

const SKIP_MAILBOX_RE = /^(?:sent|drafts?|trash|outbox|wysłane|szkice|kosz)$/i;
const MAILBOX_PRIORITY = [
  /^inbox$/i,
  /^społeczności$/i,
  /^(?:junk|spam)$/i,
  /^powiadomienia$/i,
];

function mailboxPath(mailbox) {
  return typeof mailbox === 'string' ? mailbox : mailbox?.path;
}

// 邮箱服务商可能把登录邮件自动放入分类文件夹；优先扫描收件箱和常见收件分类，
// 同时保留其他非发件箱文件夹作为兜底。发件箱、草稿和回收站不参与取码。
export function getMailboxSearchOrder(mailboxes = []) {
  const paths = [];
  const seen = new Set();

  for (const mailbox of mailboxes) {
    const path = mailboxPath(mailbox);
    const key = String(path || '').toLowerCase();
    if (!path || seen.has(key) || SKIP_MAILBOX_RE.test(path)) continue;
    seen.add(key);
    paths.push(path);
  }

  return paths
    .map((path, index) => ({ path, index, priority: MAILBOX_PRIORITY.findIndex(re => re.test(path)) }))
    .sort((a, b) => {
      const priorityA = a.priority === -1 ? MAILBOX_PRIORITY.length : a.priority;
      const priorityB = b.priority === -1 ? MAILBOX_PRIORITY.length : b.priority;
      return priorityA - priorityB || a.index - b.index;
    })
    .map(item => item.path);
}

export function getMailboxSearchPaths(emailAddress, mailboxes = []) {
  if (getWebmailProvider(emailAddress) !== 'onet') return ['INBOX'];
  const paths = getMailboxSearchOrder(mailboxes);
  return paths.length > 0 ? paths : ['INBOX'];
}

// 从一封邮件里挑出该 type 应返回的凭证。挑不出返回 null → 调用方跳过这封继续找下一封。
// type='all' 为原始调试视图，返回码或链接（可能为空字符串，仍算命中）。
export function pickCredential(type, { subject = '', body = '', links = null } = {}) {
  const code = extractCode(body) || extractCode(subject);
  if (type === 'all') {
    const link = (links && links.length > 0) ? links[0] : extractLink(body);
    return code || link || '';
  }
  // 通知类邮件且没有数字码 → 跳过（避免返回追踪链接）
  if (NOTIFICATION_SUBJECT.test(subject) && !code) return null;
  if (code) return code;
  if (LINK_BASED_TYPES.has(type)) {
    const link = (links && links.length > 0) ? links[0] : extractLink(body);
    return link || null;
  }
  return null; // 数字码类型没提取到码 → 跳过，继续找真正的验证码邮件
}

const MAILCOM_DOMAINS = new Set([
  'mail.com', 'email.com', 'usa.com', 'consultant.com', 'europe.com',
  'asia.com', 'iname.com', 'writeme.com', 'dr.com', 'myself.com',
  'post.com', 'techie.com', 'engineer.com', 'cheerful.com', 'priest.com',
  'artlover.com', 'activist.com',
]);

async function isMailcomDomain(emailAddress) {
  const domain = emailAddress.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (MAILCOM_DOMAINS.has(domain) || domain.endsWith('.mail.com')) return true;
  return isMxMailcom(domain);
}

export function getWebmailProvider(emailAddress) {
  const domain = emailAddress.split('@')[1]?.toLowerCase();
  if (domain === 'gazeta.pl') return 'gazeta';
  if (domain === 'onet.pl') return 'onet';
  return null;
}

export function getMailboxAccessMode(emailAddress) {
  const provider = getWebmailProvider(emailAddress);
  if (provider === 'onet') return process.env.ONET_ACCESS_MODE === 'webmail' ? 'webmail' : 'imap';
  if (provider === 'gazeta') return 'webmail';
  return 'imap';
}

export async function usesImapForAccount(emailAddress) {
  if (getMailboxAccessMode(emailAddress) === 'webmail') return false;
  return !await isMailcomDomain(emailAddress);
}

export async function fetchVerificationCode(emailAddress, password, type, recipient) {
  const provider = getWebmailProvider(emailAddress);
  if (provider && getMailboxAccessMode(emailAddress) === 'webmail') {
    return fetchViaWebmail(provider, emailAddress, password, type, recipient);
  }
  if (await isMailcomDomain(emailAddress)) {
    return fetchViaWebApi(emailAddress, password, type, recipient);
  }
  return fetchViaImap(emailAddress, password, type, recipient);
}

function matchesRecipient(recipient, ...texts) {
  if (!recipient) return true;
  const hay = texts.join(' ').toLowerCase();
  return hay.includes(recipient.toLowerCase());
}

async function fetchViaWebApi(emailAddress, password, type, recipient) {
  const { fetchMailcomEmails } = await import('./mailcom.js');
  const emails = await fetchMailcomEmails(emailAddress, password);

  if (!emails || emails.length === 0) return null;

  for (const email of emails) {
    if (!messageMatchesType(type, { from: email.from, subject: email.subject, body: email.body })) continue;
    if (!matchesRecipient(recipient, email.body, email.subject, email.from)) continue;

    const cred = pickCredential(type, { subject: email.subject, body: email.body, links: email.links });
    if (cred !== null) {
      return {
        code: cred || null,
        subject: email.subject,
        body: (email.body || '').substring(0, 2000),
        from: email.from,
        date: email.date,
      };
    }
  }

  return null;
}

async function fetchViaWebmail(provider, emailAddress, password, type, recipient) {
  const module = provider === 'gazeta'
    ? await import('./gazeta.js')
    : await import('./onet.js');
  const emails = provider === 'gazeta'
    ? await module.fetchGazetaEmails(emailAddress, password)
    : await module.fetchOnetEmails(emailAddress, password);

  if (!emails || emails.length === 0) return null;
  for (const email of emails) {
    if (!messageMatchesType(type, { from: email.from, subject: email.subject, body: email.body })) continue;
    if (!matchesRecipient(recipient, email.body, email.subject, email.from)) continue;
    const cred = pickCredential(type, { subject: email.subject, body: email.body, links: email.links });
    if (cred !== null) {
      return {
        code: cred || null,
        subject: email.subject,
        body: (email.body || '').substring(0, 2000),
        from: email.from,
        date: email.date,
      };
    }
  }
  return null;
}

async function fetchViaImap(emailAddress, password, type, recipient) {
  const serverConfig = await getServerConfig(emailAddress);
  if (!serverConfig) {
    throw new Error(`无法确定 ${emailAddress} 的 IMAP 服务器`);
  }

  const client = new ImapFlow({
    host: serverConfig.host,
    port: serverConfig.port,
    secure: serverConfig.secure,
    auth: { user: emailAddress, pass: password },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    if (err.authenticationFailed) {
      throw new Error(`IMAP 认证失败 (${serverConfig.host}): 邮箱密码错误或需要应用专用密码`);
    }
    throw new Error(`IMAP 连接失败 (${serverConfig.host}:${serverConfig.port}): ${err.message}`);
  }

  try {
    let mailboxPaths = ['INBOX'];
    if (getWebmailProvider(emailAddress) === 'onet') {
      try {
        mailboxPaths = getMailboxSearchPaths(emailAddress, await client.list());
      } catch {
        // 某些 IMAP 服务不支持 LIST；Onet 回退到 INBOX。
      }
    }
    if (mailboxPaths.length === 0) mailboxPaths = ['INBOX'];

    const lookbackSince = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
    const filter = { since: lookbackSince };

    for (const mailboxPath of mailboxPaths) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailboxPath);
      } catch (err) {
        if (mailboxPath === 'INBOX') throw err;
        continue;
      }

      try {
        const messages = [];
        for await (const msg of client.fetch(filter, {
          envelope: true,
          source: true,
          uid: true,
        })) {
          messages.push(msg);
        }

        messages.sort((a, b) => {
          const dateA = a.envelope?.date ? new Date(a.envelope.date) : new Date(0);
          const dateB = b.envelope?.date ? new Date(b.envelope.date) : new Date(0);
          return dateB - dateA;
        });

        for (const msg of messages) {
          const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() || '';
          const subject = msg.envelope?.subject || '';
          const date = msg.envelope?.date;

          if (date && new Date(date) < lookbackSince) continue;

          let bodyText = '';
          let bodyParsed = false;
          const parseBody = async () => {
            if (bodyParsed) return;
            bodyParsed = true;
            if (msg.source) {
              const { simpleParser } = await import('mailparser');
              const parsed = await simpleParser(msg.source);
              bodyText = parsed.text || parsed.html || '';
            }
          };

          // 先用信封 from + 主题快速判断；不中再解析正文重试
          // （转发邮件原始发件人在正文里，需要正文才能命中）
          if (!messageMatchesType(type, { from: fromAddr, subject })) {
            await parseBody();
            if (!messageMatchesType(type, { from: fromAddr, subject, body: bodyText })) continue;
          }
          await parseBody();

          if (!matchesRecipient(recipient, bodyText, subject, fromAddr)) continue;

          const cred = pickCredential(type, { subject, body: bodyText });
          if (cred !== null) {
            return {
              code: cred || null,
              subject,
              body: bodyText.substring(0, 2000),
              from: fromAddr,
              date: date?.toISOString(),
            };
          }
        }
      } finally {
        lock.release();
      }
    }

    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function testImapConnection(emailAddress, password, options = {}) {
  const serverConfig = await getServerConfig(emailAddress);
  if (!serverConfig) {
    throw new Error(`无法确定 ${emailAddress} 的 IMAP 服务器`);
  }

  const timeoutMs = Math.min(120000, Math.max(1000, Number(options.timeoutMs) || 20000));
  const client = new ImapFlow({
    host: serverConfig.host,
    port: serverConfig.port,
    secure: serverConfig.secure,
    auth: { user: emailAddress, pass: password },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });

  try {
    await client.connect();
    let lock;
    let messages = 0;
    try {
      lock = await client.getMailboxLock('INBOX');
      messages = Number(client.mailbox?.exists || 0);
    } finally {
      lock?.release();
    }
    return {
      success: true,
      server: `${serverConfig.host}:${serverConfig.port}`,
      messages,
    };
  } catch (err) {
    throw new Error(`IMAP 连接失败: ${err.message}`);
  } finally {
    await client.logout().catch(() => {});
  }
}
