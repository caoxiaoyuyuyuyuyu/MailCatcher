import { Router } from 'express';
import db from '../db.js';
import { fetchVerificationCode } from '../services/imap.js';
import { fetchVia171 } from '../services/forward171.js';
import { decrypt, hashToken, maskToken } from '../services/crypto.js';
import { resolveIdentity } from '../middleware/auth.js';

const router = Router();

const FAIL_THRESHOLD = 3;
const BLOCKED_HEALTH = new Set(['banned', 'expired', 'disabled']);

async function logQuery(account, label, type, result, success, errorMsg, requestedBy) {
  await db('email_logs').insert({
    email_id: account.id,
    email_address: account.address,
    requested_by: requestedBy || null,
    query_type: type,
    query_token: label,
    subject: result?.subject || '',
    code: result?.code ? maskToken(result.code) : '',
    raw_body: '',
    success: success ? 1 : 0,
    error_msg: errorMsg || null,
  });
}

async function markError(account, reason) {
  const next = (account.fail_count || 0) + 1;
  await db('emails').where('id', account.id).update({ fail_count: next });
  if (next >= FAIL_THRESHOLD && account.health_status === 'active') {
    await db('emails').where('id', account.id).update({ health_status: 'error', updated_at: db.fn.now() });
    await db('account_status_logs').insert({
      account_id: account.id,
      from_status: 'active',
      to_status: 'error',
      changed_by: null,
      reason: `连续 ${next} 次取码失败自动标记: ${reason}`.slice(0, 200),
    });
  }
}

async function runFetch(res, account, type, label, requestedBy) {
  if (account.status !== 1) return res.json({ code: 403, message: '账号已停用' });
  if (BLOCKED_HEALTH.has(account.health_status)) {
    return res.json({ code: 403, message: `账号状态异常（${account.health_status}），暂不可取码` });
  }
  try {
    let result;
    if (account.source === 'forward') {
      result = await fetchVia171(decrypt(account.forward_token_enc), type);
    } else {
      const password = decrypt(account.password_enc);
      if (!password) return res.json({ code: 400, message: '该邮箱未配置密码，无法查询' });
      const mailbox = account.fetch_address || account.address;
      const recipient = account.fetch_address ? account.address : null;
      result = await fetchVerificationCode(mailbox, password, type, recipient);
    }
    if (account.fail_count) await db('emails').where('id', account.id).update({ fail_count: 0 });
    await logQuery(account, label, type, result, true, null, requestedBy);

    if (!result) return res.json({ code: 200, message: 'no new message', data: null });
    return res.json({
      code: 200, message: 'success',
      data: { code: result.code, subject: result.subject, body: result.body, from: result.from, date: result.date },
    });
  } catch (err) {
    await markError(account, err.message);
    await logQuery(account, label, type, null, false, err.message, requestedBy);
    return res.json({ code: 500, message: err.message });
  }
}

function checkAppKeyAccess(appKey, account) {
  const scope = typeof appKey.allowed_accounts === 'string'
    ? JSON.parse(appKey.allowed_accounts) : (appKey.allowed_accounts || {});
  if (!scope.scope || scope.scope === 'all') return true;
  if (scope.account_ids && Array.isArray(scope.account_ids)) {
    return scope.account_ids.includes(account.id);
  }
  return false;
}

router.get('/', async (req, res) => {
  const { token, email, type = 'gpt' } = req.query;

  if (token) {
    const account = await db('emails').where('token_hash', hashToken(token)).first();
    if (!account) return res.json({ code: 401, message: '无效的令牌' });
    return runFetch(res, account, type, maskToken(token), null);
  }

  if (email) {
    const identity = await resolveIdentity(req);
    if (!identity) return res.json({ code: 401, message: '按邮箱取码需登录或提供 API Key / App Key' });

    const account = await db('emails').where('address', email).first();
    if (!account) return res.json({ code: 404, message: '账号不存在' });

    if (req.appKey) {
      if (!checkAppKeyAccess(req.appKey, account)) {
        return res.json({ code: 403, message: '该 App Key 无权访问此账号' });
      }
      return runFetch(res, account, type, `[appkey:${req.appKey.key_prefix}]`, null);
    }

    const principal = req.user;
    const canAccess = principal.role === 'admin' || account.created_by === principal.id
      || await db('account_grants').where({ account_id: account.id, user_id: principal.id }).first();
    if (!canAccess) return res.json({ code: 403, message: '无权访问该账号' });
    return runFetch(res, account, type, account.token_prefix || '(email)', principal.id);
  }

  return res.json({ code: 400, message: '请提供 token 或 email' });
});

export default router;
