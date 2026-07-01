import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import db from '../db.js';
import { fetchVerificationCode } from './imap.js';
import { fetchVia171 } from '../services/forward171.js';
import { decrypt, maskToken } from './crypto.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const fetchQueue = new Queue('fetch-code', { connection });

const FAIL_THRESHOLD = 3;

async function logQuery(account, label, type, result, success, errorMsg, requestedBy) {
  await db('email_logs').insert({
    email_id: account.id,
    email_address: account.address,
    requested_by: requestedBy || null,
    query_type: type,
    query_token: label,
    subject: result?.subject || '',
    code: result?.code ? maskToken(result.code) : '',
    raw_body: '',
    success: success ? 1 : 0,
    error_msg: errorMsg || null,
  });
}

async function markError(account, reason) {
  const next = (account.fail_count || 0) + 1;
  await db('emails').where('id', account.id).update({ fail_count: next });
  if (next >= FAIL_THRESHOLD && account.health_status === 'active') {
    await db('emails').where('id', account.id).update({ health_status: 'error', updated_at: db.fn.now() });
    await db('account_status_logs').insert({
      account_id: account.id, from_status: 'active', to_status: 'error',
      changed_by: null,
      reason: `连续 ${next} 次取码失败自动标记: ${reason}`.slice(0, 200),
    });
  }
}

async function processFetchJob(job) {
  const { accountId, type, label, requestedBy } = job.data;
  const account = await db('emails').where('id', accountId).first();
  if (!account) throw new Error('账号不存在');
  if (account.status !== 1) return { code: 403, message: '账号已停用' };
  const BLOCKED = new Set(['banned', 'expired', 'disabled']);
  if (BLOCKED.has(account.health_status)) {
    return { code: 403, message: `账号状态异常（${account.health_status}），暂不可取码` };
  }

  try {
    let result;
    if (account.source === 'forward') {
      result = await fetchVia171(decrypt(account.forward_token_enc), type);
    } else {
      const password = decrypt(account.password_enc);
      if (!password) return { code: 400, message: '该邮箱未配置密码，无法查询' };
      const mailbox = account.fetch_address || account.address;
      const recipient = account.fetch_address ? account.address : null;
      result = await fetchVerificationCode(mailbox, password, type, recipient);
    }
    if (account.fail_count) await db('emails').where('id', account.id).update({ fail_count: 0 });
    await logQuery(account, label, type, result, true, null, requestedBy);

    if (!result) return { code: 200, message: 'no new message', data: null };
    return {
      code: 200, message: 'success',
      data: { code: result.code, subject: result.subject, body: result.body, from: result.from, date: result.date },
    };
  } catch (err) {
    await markError(account, err.message);
    await logQuery(account, label, type, null, false, err.message, requestedBy);
    return { code: 500, message: err.message };
  }
}

let worker = null;

export function startWorker() {
  if (worker) return worker;
  worker = new Worker('fetch-code', processFetchJob, {
    connection: new IORedis(REDIS_URL, { maxRetriesPerRequest: null }),
    concurrency: Number(process.env.FETCH_CONCURRENCY || 20),
  });
  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id} failed:`, err.message);
  });
  console.log('[worker] 取码 worker 已启动');
  return worker;
}

export async function enqueueFetch({ accountId, type, label, requestedBy }) {
  const job = await fetchQueue.add('fetch', { accountId, type, label, requestedBy }, {
    removeOnComplete: { age: 300 },
    removeOnFail: { age: 600 },
  });
  return job.id;
}

export async function waitForResult(jobId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await fetchQueue.getJob(jobId);
    if (!job) return { code: 404, message: '任务不存在' };
    const state = await job.getState();
    if (state === 'completed') return job.returnvalue;
    if (state === 'failed') return { code: 500, message: job.failedReason || '取码失败' };
    await new Promise(r => setTimeout(r, 500));
  }
  return { code: 202, message: '任务仍在处理中，请稍后查询' };
}

export async function getJobResult(jobId) {
  const job = await fetchQueue.getJob(jobId);
  if (!job) return { status: 'not_found', result: null };
  const state = await job.getState();
  if (state === 'completed') return { status: 'completed', result: job.returnvalue };
  if (state === 'failed') return { status: 'failed', result: { code: 500, message: job.failedReason } };
  return { status: state, result: null };
}
