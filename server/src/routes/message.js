import { Router } from 'express';
import db from '../db.js';
import { fetchVerificationCode } from '../services/imap.js';

const router = Router();

router.get('/', async (req, res) => {
  const { token, type = 'gpt' } = req.query;

  if (!token) {
    return res.json({ code: 400, message: '请提供查询令牌' });
  }

  const email = db.prepare('SELECT * FROM emails WHERE token = ? AND status = 1').get(token);
  if (!email) {
    return res.json({ code: 401, message: '无效的令牌' });
  }

  if (!email.password) {
    return res.json({ code: 400, message: '该邮箱未配置密码，无法查询' });
  }

  try {
    const result = await fetchVerificationCode(email.address, email.password, type);

    db.prepare(
      `INSERT INTO email_logs (email_id, email_address, query_type, query_token, subject, code, raw_body, success)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      email.id, email.address, type, token,
      result?.subject || '', result?.code || '', result?.body?.substring(0, 500) || '',
      result ? 1 : 0
    );

    if (!result) {
      return res.json({ code: 200, message: 'no new message', data: null });
    }

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
    db.prepare(
      `INSERT INTO email_logs (email_id, email_address, query_type, query_token, success, error_msg)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(email.id, email.address, type, token, err.message);

    return res.json({ code: 500, message: err.message });
  }
});

export default router;
