import { Router } from 'express';
import db from '../db.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('admin'));

router.get('/email', async (req, res) => {
  const { page = 1, pageSize = 30, keyword = '' } = req.query;
  const offset = (page - 1) * pageSize;
  let query = db('email_logs');
  let countQuery = db('email_logs');
  if (keyword) {
    query = query.where(function () { this.where('email_address', 'like', `%${keyword}%`).orWhere('query_type', 'like', `%${keyword}%`); });
    countQuery = countQuery.where(function () { this.where('email_address', 'like', `%${keyword}%`).orWhere('query_type', 'like', `%${keyword}%`); });
  }
  const [{ c: total }] = await countQuery.count('* as c');
  const list = await query.select('*').orderBy('id', 'desc').limit(Number(pageSize)).offset(offset);
  res.json({ code: 200, data: { list, total: Number(total) } });
});

router.post('/email/clear', async (req, res) => {
  await db('email_logs').del();
  res.json({ code: 200, message: 'success' });
});

export default router;
