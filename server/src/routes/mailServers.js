import { Router } from 'express';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/list', (req, res) => {
  const { page = 1, pageSize = 30, keyword = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];
  if (keyword) {
    where += ' AND (domain LIKE ? OR host LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM mail_servers WHERE ${where}`).get(...params).c;
  const list = db.prepare(`SELECT * FROM mail_servers WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), offset);
  res.json({ code: 200, data: { list, total } });
});

router.post('/create', (req, res) => {
  const { domain, host, port = 993, use_ssl = 1, use_proxy = 0, status = 1 } = req.body;
  if (!domain || !host) return res.json({ code: 400, message: '域名和服务器地址不能为空' });
  try {
    db.prepare(
      'INSERT INTO mail_servers (domain, host, port, use_ssl, use_proxy, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(domain, host, port, use_ssl, use_proxy, status);
    res.json({ code: 200, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.json({ code: 400, message: '该域名已存在' });
    }
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', (req, res) => {
  const { id, domain, host, port, use_ssl, use_proxy, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  db.prepare(
    `UPDATE mail_servers SET domain=?, host=?, port=?, use_ssl=?, use_proxy=?, status=?,
     updated_at=datetime('now') WHERE id=?`
  ).run(domain, host, port, use_ssl ?? 1, use_proxy ?? 0, status ?? 1, id);
  res.json({ code: 200, message: 'success' });
});

router.delete('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM mail_servers WHERE id = ?').run(req.params.id);
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的服务' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM mail_servers WHERE id IN (${placeholders})`).run(...ids);
  res.json({ code: 200, message: 'success' });
});

router.post('/clear', (req, res) => {
  db.prepare('DELETE FROM mail_servers').run();
  res.json({ code: 200, message: 'success' });
});

export default router;
