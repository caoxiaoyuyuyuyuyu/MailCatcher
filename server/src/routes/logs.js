import { Router } from 'express';
import db from '../db.js';
import { authMiddleware, requireRole, teamScope } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

router.get('/email', (req, res) => {
  const { page = 1, pageSize = 30, keyword = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let where = '1=1';
  const params = [];

  const scope = teamScope(req, 'team_id');
  where += scope.clause; params.push(...scope.params);

  if (keyword) {
    where += ' AND (email_address LIKE ? OR query_type LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) as c FROM email_logs WHERE ${where}`).get(...params).c;
  const list = db.prepare(`SELECT * FROM email_logs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), offset);
  res.json({ code: 200, data: { list, total } });
});

router.post('/email/clear', requireRole('super_admin'), (req, res) => {
  db.prepare('DELETE FROM email_logs').run();
  res.json({ code: 200, message: 'success' });
});

export default router;
