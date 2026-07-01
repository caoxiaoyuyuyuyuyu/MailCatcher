import { Router } from 'express';
import db from '../db.js';
import { hashToken, maskToken } from '../services/crypto.js';
import { resolveIdentity } from '../middleware/auth.js';
import { enqueueFetch, waitForResult, getJobResult } from '../services/queue.js';

const router = Router();

const BLOCKED_HEALTH = new Set(['banned', 'expired', 'disabled']);

function checkAppKeyAccess(appKey, account) {
  const scope = typeof appKey.allowed_accounts === 'string'
    ? JSON.parse(appKey.allowed_accounts) : (appKey.allowed_accounts || {});
  if (!scope.scope || scope.scope === 'all') return true;
  if (scope.account_ids && Array.isArray(scope.account_ids)) {
    return scope.account_ids.includes(account.id);
  }
  return false;
}

async function resolveAccount(req) {
  const { token, email } = req.query;

  if (token) {
    const account = await db('emails').where('token_hash', hashToken(token)).first();
    if (!account) return { error: { code: 401, message: '无效的令牌' } };
    return { account, label: maskToken(token), requestedBy: null };
  }

  if (email) {
    const identity = await resolveIdentity(req);
    if (!identity) return { error: { code: 401, message: '按邮箱取码需登录或提供 API Key / App Key' } };

    const account = await db('emails').where('address', email).first();
    if (!account) return { error: { code: 404, message: '账号不存在' } };

    if (req.appKey) {
      if (!checkAppKeyAccess(req.appKey, account)) {
        return { error: { code: 403, message: '该 App Key 无权访问此账号' } };
      }
      return { account, label: `[appkey:${req.appKey.key_prefix}]`, requestedBy: null };
    }

    const principal = req.user;
    const canAccess = principal.role === 'admin' || account.created_by === principal.id
      || await db('account_grants').where({ account_id: account.id, user_id: principal.id }).first();
    if (!canAccess) return { error: { code: 403, message: '无权访问该账号' } };
    return { account, label: account.token_prefix || '(email)', requestedBy: principal.id };
  }

  return { error: { code: 400, message: '请提供 token 或 email' } };
}

// 同步接码（兼容现有调用）：入队 + 等待结果
router.get('/', async (req, res) => {
  const { type = 'gpt' } = req.query;
  const resolved = await resolveAccount(req);
  if (resolved.error) return res.json(resolved.error);

  const { account, label, requestedBy } = resolved;
  if (account.status !== 1) return res.json({ code: 403, message: '账号已停用' });
  if (BLOCKED_HEALTH.has(account.health_status)) {
    return res.json({ code: 403, message: `账号状态异常（${account.health_status}），暂不可取码` });
  }

  const jobId = await enqueueFetch({ accountId: account.id, type, label, requestedBy });
  const result = await waitForResult(jobId, 90000);
  return res.json(result);
});

// 异步接码：入队立即返回 taskId
router.post('/async', async (req, res) => {
  const { email, type = 'gpt' } = req.body;
  if (!email) return res.json({ code: 400, message: '请提供 email' });

  req.query = { ...req.query, email };
  const resolved = await resolveAccount(req);
  if (resolved.error) return res.json(resolved.error);

  const { account, label, requestedBy } = resolved;
  if (account.status !== 1) return res.json({ code: 403, message: '账号已停用' });
  if (BLOCKED_HEALTH.has(account.health_status)) {
    return res.json({ code: 403, message: `账号状态异常（${account.health_status}），暂不可取码` });
  }

  const taskId = await enqueueFetch({ accountId: account.id, type, label, requestedBy });
  return res.json({ code: 200, data: { taskId }, message: '任务已提交，请通过 taskId 查询结果' });
});

// 查询异步任务结果
router.get('/task/:taskId', async (req, res) => {
  const { status, result } = await getJobResult(req.params.taskId);
  if (status === 'not_found') return res.json({ code: 404, message: '任务不存在或已过期' });
  if (status === 'completed') return res.json(result);
  if (status === 'failed') return res.json(result);
  return res.json({ code: 202, data: { status }, message: '任务处理中' });
});

export default router;
