import { Router } from 'express';
import db from '../db.js';
import { fetchVerificationCode } from '../services/imap.js';
import { fetchVia171 } from '../services/forward171.js';
import { decrypt, hashToken, maskToken } from '../services/crypto.js';

const router = Router();

const FAIL_THRESHOLD = 3; // 连续失败达到此值自动标记 error
const BLOCKED_HEALTH = new Set(['banned', 'expired', 'disabled']);

function logQuery(account, plainToken, type, result, success, errorMsg) {
  db.prepare(
    `INSERT INTO email_logs
       (email_id, email_address, team_id, query_type, query_token, subject, code, raw_body, success, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    account.id, account.address, account.team_id || null, type,
    maskToken(plainToken),                       // 仅存掩码，不留明文令牌
    result?.subject || '',
    result?.code ? maskToken(result.code) : '',  // 验证码脱敏
    '',                                          // 不再落库原文邮件正文
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

router.get('/', async (req, res) => {
  const { token, type = 'gpt' } = req.query;
  if (!token) return res.json({ code: 400, message: '请提供查询令牌' });

  const account = db.prepare('SELECT * FROM emails WHERE token_hash = ?').get(hashToken(token));
  if (!account) return res.json({ code: 401, message: '无效的令牌' });
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
    logQuery(account, token, type, result, true, null);

    if (!result) return res.json({ code: 200, message: 'no new message', data: null });
    return res.json({
      code: 200,
      message: 'success',
      data: {
        code: result.code,
        subject: result.subject,
        body: result.body,
        from: result.from,
        date: result.date,
      },
    });
  } catch (err) {
    markError(account, err.message);
    logQuery(account, token, type, null, false, err.message);
    return res.json({ code: 500, message: err.message });
  }
});

export default router;
