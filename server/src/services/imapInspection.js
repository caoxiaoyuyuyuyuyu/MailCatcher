import { decrypt } from './crypto.js';
import { testImapConnection, usesImapForAccount } from './imap.js';

const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;
const DEFAULT_TIMEOUT_MS = 20000;

function elapsedSince(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function safeMessage(error, secrets = []) {
  let message = String(error?.message || error || '巡检失败');
  for (const secret of secrets) {
    if (secret) message = message.split(String(secret)).join('***');
  }
  return message.slice(0, 500);
}

function skipped(base, error, startedAt) {
  return { ...base, status: 'skipped', error, duration_ms: elapsedSince(startedAt) };
}

async function inspectAccount(account, {
  decryptPassword,
  supportsMailbox,
  inspectConnection,
  timeoutMs,
}) {
  const startedAt = Date.now();
  const mailbox = String(account.fetch_address || account.address || '').trim();
  const base = {
    id: account.id,
    address: account.address,
    mailbox,
  };

  if (account.source !== 'self') {
    return skipped(base, '非自管账号，不使用 IMAP', startedAt);
  }
  if (!account.password_enc) {
    return skipped(base, '未配置收件密码', startedAt);
  }
  if (!mailbox) {
    return skipped(base, '未配置收件邮箱', startedAt);
  }

  let supported;
  try {
    supported = await supportsMailbox(mailbox);
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error: safeMessage(error),
      duration_ms: elapsedSince(startedAt),
    };
  }
  if (!supported) {
    return skipped(base, '该邮箱通过 Webmail/API 收件，不使用 IMAP', startedAt);
  }

  let password;
  try {
    password = decryptPassword(account.password_enc);
  } catch {
    return {
      ...base,
      status: 'failed',
      error: '收件密码解密失败',
      duration_ms: elapsedSince(startedAt),
    };
  }

  try {
    const result = await inspectConnection(mailbox, password, { timeoutMs });
    if (result?.success === false) {
      throw new Error(result.message || 'IMAP 连接失败');
    }
    return {
      ...base,
      status: 'success',
      server: result?.server || '',
      messages: Number(result?.messages || 0),
      duration_ms: elapsedSince(startedAt),
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error: safeMessage(error, [password, account.password_enc]),
      duration_ms: elapsedSince(startedAt),
    };
  }
}

export async function supportsImapInspection(mailbox) {
  return usesImapForAccount(mailbox);
}

export async function runBatchImapInspection(accounts, options = {}) {
  const startedAt = Date.now();
  const list = Array.isArray(accounts) ? accounts : [];
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Number(options.concurrency ?? process.env.IMAP_INSPECTION_CONCURRENCY) || DEFAULT_CONCURRENCY),
  );
  const timeoutMs = Math.min(
    120000,
    Math.max(1000, Number(options.timeoutMs ?? process.env.IMAP_INSPECTION_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  );
  const dependencies = {
    decryptPassword: options.decryptPassword || decrypt,
    supportsMailbox: options.supportsMailbox || supportsImapInspection,
    inspectConnection: options.inspectConnection || testImapConnection,
    timeoutMs,
  };

  const results = new Array(list.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await inspectAccount(list[index], dependencies);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, () => worker()),
  );

  return {
    total: results.length,
    success: results.filter(result => result.status === 'success').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    duration_ms: elapsedSince(startedAt),
    results,
  };
}
