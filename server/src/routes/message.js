import { Router } from 'express';
import db from '../db.js';
import { fetchVerificationCode } from '../services/imap.js';
import { fetchVia171 } from '../services/forward171.js';
import { decrypt, hashToken, maskToken } from '../services/crypto.js';
import { resolvePrincipal } from '../middleware/auth.js';

const router = Router();

const FAIL_THRESHOLD = 3; // 连续失败达到此值自动标记 error
const BLOCKED_HEALTH = new Set(['banned', 'expired', 'disabled']);

function logQuery(account, label, type, result, success, errorMsg, requestedBy) {
  db.prepare(
    `INSERT INTO email_logs
       (email_id, email_address, requested_by, query_type, query_token, subject, code, raw_body, success, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    account.id, account.address, requestedBy || null, type,
    label,                                        // 仅存掩码/标识，不留明文令牌
    result?.subject || '',
    result?.code ? maskToken(result.code) : '',   // 验证码脱敏
    '',                                           // 不落库原文邮件正文
    success ? 1 : 0,
    errorMsg || null
  );
}

function markError(account, reason) {
  const next = (account.fail_count || 0) + 1;
  db.prepare('UPDATE emails SET fail_count = ? WHERE id = ?').run(next, account.id);
  if (next >= FAIL_THRESHOLD && account.health_status === 'active') {
    db.prepare("UPDATE emails SET health_status = 'error', updated_at = datetime('now') WHERE id = ?").run(account.id);
    db.prepare(
      `INSERT INTO account_status_logs (account_id, from_status, to_status, changed_by, reason)
       VALUES (?, 'active', 'error', NULL, ?)`
    ).run(account.id, `连续 ${next} 次取码失败自动标记: ${reason}`.slice(0, 200));
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
      result = await fetchVerificationCode(account.address, password, type);
    }
    if (account.fail_count) db.prepare('UPDATE emails SET fail_count = 0 WHERE id = ?').run(account.id);
    logQuery(account, label, type, result, true, null, requestedBy);

    if (!result) return res.json({ code: 200, message: 'no new message', data: null });
    return res.json({
      code: 200, message: 'success',
      data: { code: result.code, subject: result.subject, body: result.body, from: result.from, date: result.date },
    });
  } catch (err) {
    markError(account, err.message);
    logQuery(account, label, type, null, false, err.message, requestedBy);
    return res.json({ code: 500, message: err.message });
  }
}

// 接码：两种方式
//   1) token 方式（无需登录）：?token=<我方签发的账号令牌>&type=
//   2) 邮箱方式（需身份）：    ?email=<地址>&type=  + Authorization: Bearer <登录JWT 或 用户API Key>
//      单团队：登录用户均可对账号池中的邮箱取码。
router.get('/', async (req, res) => {
  const { token, email, type = 'gpt' } = req.query;

  if (token) {
    const account = db.prepare('SELECT * FROM emails WHERE token_hash = ?').get(hashToken(token));
    if (!account) return res.json({ code: 401, message: '无效的令牌' });
    return runFetch(res, account, type, maskToken(token), null);
  }

  if (email) {
    const principal = resolvePrincipal(req);
    if (!principal) return res.json({ code: 401, message: '按邮箱取码需登录或提供 API Key' });
    const account = db.prepare('SELECT * FROM emails WHERE address = ?').get(email);
    if (!account) return res.json({ code: 404, message: '账号不存在' });
    return runFetch(res, account, type, account.token_prefix || '(email)', principal.id);
  }

  return res.json({ code: 400, message: '请提供 token 或 email' });
});

export default router;
