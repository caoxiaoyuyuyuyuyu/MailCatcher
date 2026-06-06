import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { testImapConnection } from '../services/imap.js';

const router = Router();
router.use(authMiddleware);

router.get('/list', (req, res) => {
  const { page = 1, pageSize = 30, keyword = '', status = '', batch_no = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];

  if (keyword) {
    where += ' AND (address LIKE ? OR token LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  if (status) {
    const statuses = status.split(',').map(Number);
    where += ` AND status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  if (batch_no) {
    where += ' AND batch_no = ?';
    params.push(batch_no);
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM emails WHERE ${where}`).get(...params).c;
  const list = db.prepare(`SELECT * FROM emails WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), offset);

  res.json({ code: 200, data: { list, total } });
});

router.post('/create', (req, res) => {
  const { address, password, appkey, token, batch_no } = req.body;
  if (!address) return res.json({ code: 400, message: '邮箱地址不能为空' });

  const finalToken = token || uuidv4().replace(/-/g, '');
  try {
    db.prepare(
      'INSERT INTO emails (address, password, appkey, token, batch_no) VALUES (?, ?, ?, ?, ?)'
    ).run(address, password || '', appkey || '', finalToken, batch_no || '');
    res.json({ code: 200, message: 'success' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.json({ code: 400, message: '邮箱地址或令牌已存在' });
    }
    res.json({ code: 500, message: err.message });
  }
});

router.put('/update', (req, res) => {
  const { id, address, password, appkey, token, batch_no, status } = req.body;
  if (!id) return res.json({ code: 400, message: 'id 不能为空' });
  try {
    db.prepare(
      `UPDATE emails SET address=?, password=?, appkey=?, token=?, batch_no=?, status=?,
       updated_at=datetime('now') WHERE id=?`
    ).run(address, password || '', appkey || '', token, batch_no || '', status ?? 1, id);
    res.json({ code: 200, message: 'success' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

router.delete('/delete/:id', (req, res) => {
  db.prepare('DELETE FROM emails WHERE id = ?').run(req.params.id);
  res.json({ code: 200, message: 'success' });
});

router.post('/delete-batch', (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.json({ code: 400, message: '请选择要删除的邮箱' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM emails WHERE id IN (${placeholders})`).run(...ids);
  res.json({ code: 200, message: 'success' });
});

router.post('/import', (req, res) => {
  const { emails } = req.body;
  if (!emails?.length) return res.json({ code: 400, message: '导入数据为空' });

  const insert = db.prepare(
    'INSERT OR IGNORE INTO emails (address, password, appkey, token, batch_no) VALUES (?, ?, ?, ?, ?)'
  );
  const batch_no = `batch_${Date.now()}`;
  let imported = 0;

  const txn = db.transaction(() => {
    for (const item of emails) {
      let address, password, appkey;
      if (typeof item === 'string') {
        const parts = item.split('----');
        address = parts[0]?.trim();
        password = parts[1]?.trim() || '';
        appkey = parts[2]?.trim() || '';
      } else {
        ({ address, password = '', appkey = '' } = item);
      }
      if (!address) continue;
      const token = uuidv4().replace(/-/g, '');
      const result = insert.run(address, password, appkey, token, batch_no);
      if (result.changes > 0) imported++;
    }
  });
  txn();

  res.json({ code: 200, data: { imported, batch_no }, message: `成功导入 ${imported} 个邮箱` });
});

router.post('/test-connection', async (req, res) => {
  const { address, password } = req.body;
  if (!address || !password) {
    return res.json({ code: 400, message: '请提供邮箱地址和密码' });
  }
  try {
    const result = await testImapConnection(address, password);
    res.json({ code: 200, data: result, message: 'IMAP 连接成功' });
  } catch (err) {
    res.json({ code: 500, message: err.message });
  }
});

router.post('/clear', (req, res) => {
  db.prepare('DELETE FROM emails').run();
  res.json({ code: 200, message: 'success' });
});

export default router;
