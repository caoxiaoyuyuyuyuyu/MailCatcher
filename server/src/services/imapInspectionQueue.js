import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import db from '../db.js';
import { runBatchImapInspection } from './imapInspection.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const QUEUE_NAME = process.env.IMAP_INSPECTION_QUEUE_NAME || 'imap-inspection';
const DEFAULT_GLOBAL_CONCURRENCY = 5;
const DEFAULT_GLOBAL_RATE_LIMIT = 30;
const DEFAULT_GLOBAL_RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_PENDING = 250;
const DEFAULT_ACCOUNT_COOLDOWN_MS = 30 * 1000;
const DEFAULT_BATCH_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RESERVATION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_USER_LIMIT = 200;
const DEFAULT_USER_WINDOW_MS = 10 * 60 * 1000;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function createConnection() {
  return new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
}

const queueConnection = createConnection();
const queueEventsConnection = createConnection();

export const imapInspectionQueue = new Queue(QUEUE_NAME, {
  connection: queueConnection,
});
export const imapInspectionQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: queueEventsConnection,
});
imapInspectionQueueEvents.setMaxListeners(0);

function accountVersion(account) {
  return Math.max(1, Number(account?.imap_config_version) || 1);
}

function accountDeduplicationId(account) {
  return `account-${Number(account.id)}-v-${accountVersion(account)}`;
}

function resultCacheKey(deduplicationId) {
  return imapInspectionQueue.toKey(`result-${deduplicationId}`);
}

function inFlightKey(deduplicationId) {
  return imapInspectionQueue.toKey(`inflight-${deduplicationId}`);
}

function batchKey(batchId) {
  return imapInspectionQueue.toKey(`batch-${batchId}`);
}

const reservationKey = imapInspectionQueue.toKey('reservations');

function safeQueueMessage(error, fallback = 'IMAP 巡检任务执行失败') {
  return String(error?.message || error || fallback).slice(0, 500);
}

function skippedResult(account, error, reason = 'system_error') {
  return {
    id: Number(account?.id) || 0,
    address: String(account?.address || ''),
    mailbox: String(account?.fetch_address || account?.address || ''),
    status: 'skipped',
    reason,
    error: safeQueueMessage(error),
    duration_ms: 0,
  };
}

const RESERVE_BATCH_SCRIPT = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local count = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)

local states = {}
local values = {}
local needed = 0
local offset = 5
for index = 1, count do
  local deduplicationId = ARGV[offset]
  local resultKey = ARGV[offset + 1]
  local inFlightKey = ARGV[offset + 2]
  local requestedJobId = ARGV[offset + 3]
  offset = offset + 4
  if redis.call('EXISTS', resultKey) == 1 then
    states[index] = 'cached'
    values[index] = ''
  else
    local existingJobId = redis.call('GET', inFlightKey)
    if existingJobId then
      states[index] = 'existing'
      values[index] = existingJobId
    else
      states[index] = 'new'
      values[index] = requestedJobId
      needed = needed + 1
    end
  end
end

local pending = redis.call('ZCARD', KEYS[1])
if pending + needed > limit then
  return {0, pending, needed}
end

offset = 5
for index = 1, count do
  local deduplicationId = ARGV[offset]
  local resultKey = ARGV[offset + 1]
  local inFlightKey = ARGV[offset + 2]
  local requestedJobId = ARGV[offset + 3]
  offset = offset + 4
  if states[index] == 'new' then
    redis.call('PSETEX', inFlightKey, ttl, requestedJobId)
    redis.call('ZADD', KEYS[1], now + ttl, deduplicationId)
  end
end

local response = {1, pending + needed, needed}
for index = 1, count do
  table.insert(response, states[index])
  table.insert(response, values[index])
end
return response
`;

const FINALIZE_SCRIPT = `
redis.call('PSETEX', KEYS[1], ARGV[1], ARGV[2])
local currentJobId = redis.call('GET', KEYS[2])
if currentJobId == ARGV[3] then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[3], ARGV[4])
end
return 1
`;

const RELEASE_SCRIPT = `
local currentJobId = redis.call('GET', KEYS[1])
if currentJobId == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[2])
  return 1
end
return 0
`;

function inspectionSettings(options = {}) {
  return {
    cooldownMs: boundedInteger(
      options.cooldownMs ?? process.env.IMAP_INSPECTION_ACCOUNT_COOLDOWN_MS,
      DEFAULT_ACCOUNT_COOLDOWN_MS,
      1000,
      60 * 60 * 1000,
    ),
    batchTtlMs: boundedInteger(
      options.batchTtlMs ?? process.env.IMAP_INSPECTION_BATCH_TTL_MS,
      DEFAULT_BATCH_TTL_MS,
      60 * 1000,
      24 * 60 * 60 * 1000,
    ),
    reservationTtlMs: boundedInteger(
      options.reservationTtlMs ?? process.env.IMAP_INSPECTION_RESERVATION_TTL_MS,
      DEFAULT_RESERVATION_TTL_MS,
      60 * 1000,
      24 * 60 * 60 * 1000,
    ),
    maxPending: boundedInteger(
      options.maxPending ?? process.env.IMAP_INSPECTION_MAX_PENDING,
      DEFAULT_MAX_PENDING,
      1,
      10000,
    ),
  };
}

async function releaseReservation(deduplicationId, jobId) {
  const client = await imapInspectionQueue.client;
  await client.eval(
    RELEASE_SCRIPT,
    2,
    inFlightKey(deduplicationId),
    reservationKey,
    String(jobId),
    deduplicationId,
  );
}

async function finalizeInspection(job, result, cooldownMs) {
  const { deduplicationId } = job.data;
  const client = await imapInspectionQueue.client;
  await client.eval(
    FINALIZE_SCRIPT,
    3,
    resultCacheKey(deduplicationId),
    inFlightKey(deduplicationId),
    reservationKey,
    cooldownMs,
    JSON.stringify(result),
    String(job.id),
    deduplicationId,
  );
}

async function processImapInspectionJob(job) {
  const startedAt = Date.now();
  const accountId = Number(job.data.accountId);
  const requestedVersion = Math.max(1, Number(job.data.configVersion) || 1);
  const cooldownMs = boundedInteger(
    job.data.cooldownMs,
    DEFAULT_ACCOUNT_COOLDOWN_MS,
    1000,
    60 * 60 * 1000,
  );
  let account;
  let result;

  try {
    account = await db('emails')
      .select('id', 'address', 'fetch_address', 'source', 'password_enc', 'imap_config_version')
      .where('id', accountId)
      .first();

    if (!account) {
      result = skippedResult(
        { id: accountId },
        '账号不存在或已被删除',
        'account_missing',
      );
    } else if (accountVersion(account) !== requestedVersion) {
      result = {
        ...skippedResult(account, 'IMAP 配置已更新，正在使用最新配置重新巡检', 'stale_config'),
        current_config_version: accountVersion(account),
      };
    } else {
      const report = await runBatchImapInspection([account], { concurrency: 1 });
      result = report.results[0];
    }
  } catch (error) {
    result = skippedResult(
      account || { id: accountId },
      safeQueueMessage(error),
      'system_error',
    );
  }

  result.duration_ms = Math.max(Number(result.duration_ms) || 0, Date.now() - startedAt);
  await finalizeInspection(job, result, cooldownMs);
  return result;
}

let inspectionWorker = null;
let inspectionWorkerConnection = null;

export async function startImapInspectionWorker() {
  if (inspectionWorker) return inspectionWorker;
  const globalConcurrency = boundedInteger(
    process.env.IMAP_INSPECTION_GLOBAL_CONCURRENCY,
    DEFAULT_GLOBAL_CONCURRENCY,
    1,
    10,
  );
  const globalRateLimit = boundedInteger(
    process.env.IMAP_INSPECTION_GLOBAL_RATE_LIMIT,
    DEFAULT_GLOBAL_RATE_LIMIT,
    1,
    10000,
  );
  const globalRateWindowMs = boundedInteger(
    process.env.IMAP_INSPECTION_GLOBAL_RATE_WINDOW_MS,
    DEFAULT_GLOBAL_RATE_WINDOW_MS,
    1000,
    60 * 60 * 1000,
  );

  await imapInspectionQueue.setGlobalConcurrency(globalConcurrency);
  await imapInspectionQueue.setGlobalRateLimit(globalRateLimit, globalRateWindowMs);
  await imapInspectionQueueEvents.waitUntilReady();

  inspectionWorkerConnection = createConnection();
  inspectionWorker = new Worker(QUEUE_NAME, processImapInspectionJob, {
    connection: inspectionWorkerConnection,
    concurrency: globalConcurrency,
  });
  inspectionWorker.on('failed', (job, error) => {
    console.error(`[imap-inspection] job ${job?.id} failed:`, error.message);
    if (job?.data?.deduplicationId) {
      releaseReservation(job.data.deduplicationId, job.id).catch(releaseError => {
        console.error(`[imap-inspection] failed to release reservation ${job.id}:`, releaseError.message);
      });
    }
  });
  await inspectionWorker.waitUntilReady();
  console.log(
    `[worker] IMAP 巡检 worker 已启动（全局并发 ${globalConcurrency}，`
    + `全局速率 ${globalRateLimit}/${globalRateWindowMs}ms）`,
  );
  return inspectionWorker;
}

export class ImapInspectionBusyError extends Error {
  constructor(message = 'IMAP 巡检队列繁忙，请稍后重试') {
    super(message);
    this.name = 'ImapInspectionBusyError';
    this.code = 'IMAP_INSPECTION_BUSY';
    this.retryAfterMs = 1000;
  }
}

async function reserveAccounts(accounts, options = {}) {
  const settings = inspectionSettings(options);
  const prepared = accounts.map(account => {
    const deduplicationId = accountDeduplicationId(account);
    return {
      account,
      deduplicationId,
      requestedJobId: randomUUID(),
      resultKey: resultCacheKey(deduplicationId),
      inFlightKey: inFlightKey(deduplicationId),
    };
  });
  if (!prepared.length) return { descriptors: [], settings };

  const client = await imapInspectionQueue.client;
  const args = [
    Date.now(),
    settings.maxPending,
    settings.reservationTtlMs,
    prepared.length,
  ];
  for (const item of prepared) {
    args.push(
      item.deduplicationId,
      item.resultKey,
      item.inFlightKey,
      item.requestedJobId,
    );
  }
  const response = await client.eval(
    RESERVE_BATCH_SCRIPT,
    1,
    reservationKey,
    ...args,
  );
  if (Number(response[0]) !== 1) {
    throw new ImapInspectionBusyError();
  }

  const descriptors = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index];
    const state = String(response[3 + (index * 2)]);
    const existingJobId = String(response[4 + (index * 2)] || '');
    if (state === 'cached') {
      const cached = await client.get(item.resultKey);
      if (cached) {
        descriptors.push({
          account: item.account,
          deduplicationId: item.deduplicationId,
          state: 'completed',
          result: JSON.parse(cached),
        });
        continue;
      }
      // The cache expired immediately after reservation. Reserve it normally below.
      const retried = await reserveAccounts([item.account], options);
      descriptors.push(retried.descriptors[0]);
      continue;
    }
    descriptors.push({
      account: item.account,
      deduplicationId: item.deduplicationId,
      state,
      jobId: state === 'new' ? item.requestedJobId : existingJobId,
    });
  }
  return { descriptors, settings };
}

async function addReservedJobs(descriptors, context, settings) {
  for (const descriptor of descriptors) {
    if (descriptor.state !== 'new') continue;
    try {
      const job = await imapInspectionQueue.add(
        'inspect-account',
        {
          accountId: Number(descriptor.account.id),
          configVersion: accountVersion(descriptor.account),
          deduplicationId: descriptor.deduplicationId,
          requestedBy: Number(context.userId) || null,
          cooldownMs: settings.cooldownMs,
        },
        {
          jobId: descriptor.jobId,
          deduplication: { id: descriptor.deduplicationId },
          removeOnComplete: { age: Math.ceil(settings.batchTtlMs / 1000), count: 10000 },
          removeOnFail: { age: Math.ceil(settings.batchTtlMs / 1000), count: 10000 },
          attempts: 1,
        },
      );
      descriptor.jobId = String(job.id);
      descriptor.state = 'queued';
    } catch (error) {
      await releaseReservation(descriptor.deduplicationId, descriptor.jobId);
      descriptor.state = 'completed';
      descriptor.result = skippedResult(
        descriptor.account,
        safeQueueMessage(error),
        'system_error',
      );
    }
  }
}

export async function enqueueImapInspection(account, options = {}) {
  const normalized = typeof account === 'object'
    ? account
    : { id: Number(account), imap_config_version: options.configVersion || 1 };
  const { descriptors, settings } = await reserveAccounts([normalized], options);
  await addReservedJobs(descriptors, options, settings);
  return descriptors[0];
}

function batchMetadata(batchId, accounts, descriptors, context) {
  return {
    id: batchId,
    created_by: Number(context.userId),
    created_role: String(context.userRole || ''),
    created_at: Date.now(),
    entries: descriptors.map((descriptor, index) => ({
      account_id: Number(accounts[index].id),
      config_version: accountVersion(accounts[index]),
      address: String(accounts[index].address || ''),
      mailbox: String(accounts[index].fetch_address || accounts[index].address || ''),
      deduplication_id: descriptor.deduplicationId,
      job_id: descriptor.jobId || null,
      refreshes: 0,
      result: descriptor.result || null,
    })),
  };
}

async function saveBatch(metadata, ttlMs, keepTtl = false) {
  const client = await imapInspectionQueue.client;
  const key = batchKey(metadata.id);
  if (keepTtl) {
    await client.set(key, JSON.stringify(metadata), 'KEEPTTL');
  } else {
    await client.psetex(key, ttlMs, JSON.stringify(metadata));
  }
}

export async function createImapInspectionBatch(accounts, context, options = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const { descriptors, settings } = await reserveAccounts(list, options);
  await addReservedJobs(descriptors, context, settings);
  const batchId = randomUUID();
  const metadata = batchMetadata(batchId, list, descriptors, context);
  await saveBatch(metadata, settings.batchTtlMs);
  const report = await summarizeBatch(metadata);
  return report;
}

async function refreshStaleEntry(metadata, entry) {
  if (entry.refreshes >= 3) {
    entry.result = {
      id: entry.account_id,
      address: entry.address,
      mailbox: entry.mailbox,
      status: 'skipped',
      reason: 'stale_config',
      error: 'IMAP 配置连续发生变化，请重新发起巡检',
      duration_ms: 0,
    };
    return;
  }

  const account = await db('emails')
    .select('id', 'address', 'fetch_address', 'source', 'password_enc', 'imap_config_version')
    .where('id', entry.account_id)
    .first();
  if (!account) {
    entry.result = skippedResult(
      { id: entry.account_id, address: entry.address, fetch_address: entry.mailbox },
      '账号不存在或已被删除',
      'account_missing',
    );
    return;
  }

  try {
    const descriptor = await enqueueImapInspection(account, {
      userId: metadata.created_by,
    });
    entry.config_version = accountVersion(account);
    entry.address = String(account.address || '');
    entry.mailbox = String(account.fetch_address || account.address || '');
    entry.deduplication_id = descriptor.deduplicationId;
    entry.job_id = descriptor.jobId || null;
    entry.result = descriptor.result || null;
    entry.refreshes += 1;
    delete entry.missing_since;
  } catch (error) {
    entry.result = skippedResult(account, safeQueueMessage(error), 'system_busy');
  }
}

async function summarizeBatch(metadata, { allowRefresh = true } = {}) {
  let dirty = false;
  let hasActive = false;

  for (const entry of metadata.entries) {
    if (entry.result) continue;
    const job = entry.job_id ? await imapInspectionQueue.getJob(entry.job_id) : null;
    if (!job) {
      const client = await imapInspectionQueue.client;
      const inFlightJobId = await client.get(inFlightKey(entry.deduplication_id));
      if (inFlightJobId) {
        if (!entry.missing_since) {
          entry.missing_since = Date.now();
          dirty = true;
          hasActive = true;
          continue;
        }
        if (Date.now() - entry.missing_since < 5000) {
          hasActive = true;
          continue;
        }
        await releaseReservation(entry.deduplication_id, inFlightJobId);
      }
      entry.result = {
        id: entry.account_id,
        address: entry.address,
        mailbox: entry.mailbox,
        status: 'skipped',
        reason: 'task_expired',
        error: '巡检任务不存在或已过期，请重新发起巡检',
        duration_ms: 0,
      };
      dirty = true;
      continue;
    }

    const state = await job.getState();
    if (state === 'completed') {
      const result = job.returnvalue || skippedResult(
        entry,
        '巡检任务没有返回结果',
        'system_error',
      );
      if (result.reason === 'stale_config' && allowRefresh) {
        await refreshStaleEntry(metadata, entry);
      } else {
        entry.result = result;
      }
      dirty = true;
    } else if (state === 'failed') {
      entry.result = {
        id: entry.account_id,
        address: entry.address,
        mailbox: entry.mailbox,
        status: 'skipped',
        reason: 'system_error',
        error: safeQueueMessage(job.failedReason),
        duration_ms: 0,
      };
      dirty = true;
    } else {
      hasActive = hasActive || state === 'active';
    }
  }

  if (dirty) await saveBatch(metadata, 0, true);
  const results = metadata.entries.filter(entry => entry.result).map(entry => entry.result);
  const checked = results.length;
  const total = metadata.entries.length;
  return {
    batch_id: metadata.id,
    state: checked === total ? 'completed' : (hasActive ? 'running' : 'queued'),
    total,
    checked,
    remaining: Math.max(0, total - checked),
    success: results.filter(result => result.status === 'success').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    duration_ms: Math.max(0, Date.now() - metadata.created_at),
    results,
  };
}

export async function getImapInspectionBatch(batchId, requester = {}) {
  const client = await imapInspectionQueue.client;
  const raw = await client.get(batchKey(String(batchId)));
  if (!raw) return { found: false, forbidden: false, report: null };
  const metadata = JSON.parse(raw);
  const isOwner = Number(metadata.created_by) === Number(requester.userId);
  const isAdministrator = requester.userRole === 'admin';
  if (!isOwner && !isAdministrator) {
    return { found: true, forbidden: true, report: null };
  }
  return {
    found: true,
    forbidden: false,
    report: await summarizeBatch(metadata),
  };
}

const USER_QUOTA_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
if current + cost > limit then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then ttl = window end
  return {0, math.max(0, limit - current), ttl}
end
local next = redis.call('INCRBY', KEYS[1], cost)
if current == 0 then redis.call('PEXPIRE', KEYS[1], window) end
return {1, math.max(0, limit - next), redis.call('PTTL', KEYS[1])}
`;

const REFUND_USER_QUOTA_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local next = math.max(0, current - cost)
if next == 0 then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], next, 'KEEPTTL')
end
return next
`;

function userQuotaKey(userId) {
  return imapInspectionQueue.toKey(`user-quota-${Number(userId)}`);
}

export async function consumeImapInspectionQuota(userId, cost, options = {}) {
  const limit = boundedInteger(
    options.limit ?? process.env.IMAP_INSPECTION_USER_LIMIT,
    DEFAULT_USER_LIMIT,
    1,
    10000,
  );
  const windowMs = boundedInteger(
    options.windowMs ?? process.env.IMAP_INSPECTION_USER_WINDOW_MS,
    DEFAULT_USER_WINDOW_MS,
    1000,
    24 * 60 * 60 * 1000,
  );
  const requested = boundedInteger(cost, 1, 1, limit + 1);
  const client = await imapInspectionQueue.client;
  const [allowed, remaining, retryAfterMs] = await client.eval(
    USER_QUOTA_SCRIPT,
    1,
    userQuotaKey(userId),
    limit,
    requested,
    windowMs,
  );
  return {
    allowed: Number(allowed) === 1,
    remaining: Number(remaining),
    retryAfterMs: Math.max(0, Number(retryAfterMs)),
    limit,
    windowMs,
  };
}

export async function refundImapInspectionQuota(userId, cost) {
  const client = await imapInspectionQueue.client;
  return Number(await client.eval(
    REFUND_USER_QUOTA_SCRIPT,
    1,
    userQuotaKey(userId),
    Math.max(0, Number(cost) || 0),
  ));
}

export async function closeImapInspectionQueue() {
  if (inspectionWorker) {
    await inspectionWorker.close();
    inspectionWorker = null;
  }
  if (inspectionWorkerConnection?.status !== 'end') {
    await inspectionWorkerConnection.quit();
  }
  inspectionWorkerConnection = null;
  await imapInspectionQueueEvents.close();
  await imapInspectionQueue.close();
  if (queueEventsConnection.status !== 'end') await queueEventsConnection.quit();
  if (queueConnection.status !== 'end') await queueConnection.quit();
}
