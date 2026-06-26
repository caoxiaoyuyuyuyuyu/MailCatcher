import { Router } from 'express';
import { triggerCodexLogin } from '../services/codexLogin.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware); // 触发登录属敏感操作，需登录

// 触发 OpenAI/Codex 给指定邮箱发送登录验证码。发码后用接码接口取回。
router.post('/send', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ code: 400, message: '请提供邮箱地址' });
  try {
    const data = await triggerCodexLogin(email);
    return res.json({ code: 200, data, message: '已触发，请稍后取码' });
  } catch (err) {
    console.error('[codex/send] error:', err.message);
    return res.json({ code: 500, message: err.message });
  }
});

export default router;
