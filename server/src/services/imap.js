import { ImapFlow } from 'imapflow';
import db from '../db.js';

function getServerConfig(emailAddress) {
  const domain = emailAddress.split('@')[1]?.toLowerCase();
  if (!domain) return null;

  const server = db.prepare('SELECT * FROM mail_servers WHERE domain = ? AND status = 1').get(domain);
  if (server) {
    return { host: server.host, port: server.port, secure: !!server.use_ssl };
  }

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
  };

  if (KNOWN_SERVERS[domain]) return KNOWN_SERVERS[domain];

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

function extractCode(text) {
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

const MAILCOM_DOMAINS = new Set([
  'mail.com', 'email.com', 'usa.com', 'consultant.com', 'europe.com',
  'asia.com', 'iname.com', 'writeme.com', 'dr.com', 'myself.com',
  'post.com', 'techie.com', 'engineer.com', 'cheerful.com', 'priest.com',
  'artlover.com', 'activist.com',
]);

function isMailcomDomain(emailAddress) {
  const domain = emailAddress.split('@')[1]?.toLowerCase();
  return domain && (MAILCOM_DOMAINS.has(domain) || domain.endsWith('.mail.com'));
}

// recipient（可选）：转发收件箱场景下，按原始收件人（展示邮箱）过滤——
// 转发邮件正文会保留 "To: <原邮箱>"，据此区分同一收件箱里不同账号的验证码。
export async function fetchVerificationCode(emailAddress, password, type, recipient) {
  if (isMailcomDomain(emailAddress)) {
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

  const typeFilter = TYPE_FILTERS[type] || TYPE_FILTERS.gpt;

  for (const email of emails) {
    const fromMatch = typeFilter.from.length === 0 ||
      typeFilter.from.some(f => (email.from || '').toLowerCase().includes(f.toLowerCase()));
    const subjectMatch = typeFilter.subject.test(email.subject || '');

    if (!fromMatch && !subjectMatch && type !== 'all') continue;
    if (!matchesRecipient(recipient, email.body, email.subject, email.from)) continue;

    const code = extractCode(email.body) || extractCode(email.subject);
    const link = (email.links && email.links.length > 0)
      ? email.links[0]
      : extractLink(email.body);

    if (code || link || type === 'all') {
      return {
        code: code || link || null,
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
  const serverConfig = getServerConfig(emailAddress);
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
    const lock = await client.getMailboxLock('INBOX');

    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const filter = type === 'all'
        ? { since: tenMinutesAgo }
        : { since: tenMinutesAgo };

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

      const typeFilter = TYPE_FILTERS[type] || TYPE_FILTERS.gpt;

      for (const msg of messages) {
        const fromAddr = msg.envelope?.from?.[0]?.address?.toLowerCase() || '';
        const subject = msg.envelope?.subject || '';
        const date = msg.envelope?.date;

        if (date && new Date(date) < tenMinutesAgo) continue;

        const fromMatch = typeFilter.from.length === 0 ||
          typeFilter.from.some(f => fromAddr.includes(f.toLowerCase()));
        const subjectMatch = typeFilter.subject.test(subject);

        if (!fromMatch && !subjectMatch && type !== 'all') continue;

        let bodyText = '';
        if (msg.source) {
          const { simpleParser } = await import('mailparser');
          const parsed = await simpleParser(msg.source);
          bodyText = parsed.text || parsed.html || '';
        }

        if (!matchesRecipient(recipient, bodyText, subject, fromAddr)) continue;

        const code = extractCode(subject) || extractCode(bodyText);
        const link = extractLink(bodyText);

        if (code || link || type === 'all') {
          return {
            code: code || link || null,
            subject,
            body: bodyText.substring(0, 2000),
            from: fromAddr,
            date: date?.toISOString(),
          };
        }
      }

      return null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function testImapConnection(emailAddress, password) {
  const serverConfig = getServerConfig(emailAddress);
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
    const lock = await client.getMailboxLock('INBOX');
    const status = client.mailbox;
    lock.release();
    await client.logout();
    return {
      success: true,
      server: `${serverConfig.host}:${serverConfig.port}`,
      messages: status?.exists || 0,
    };
  } catch (err) {
    throw new Error(`IMAP 连接失败: ${err.message}`);
  }
}
