import { Router } from 'express';
import { triggerClaudeLogin } from '../services/claudeLogin.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware); // 触发 Claude 登录属敏感操作，需登录

router.post('/send', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.json({ code: 400, message: '请提供邮箱地址' });
  }

  try {
    const data = await triggerClaudeLogin(email);
    return res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[claude/send] error:', err.message);
    return res.json({ code: 500, message: err.message });
  }
});

export default router;
