import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const REDIS_URL = process.env.IMAP_INSPECTION_TEST_REDIS_URL || 'redis://127.0.0.1:6379/13';
const QUEUE_NAME = `imap-inspection-test-${process.pid}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mailcatcher-imap-inspection-'));

process.env.REDIS_URL = REDIS_URL;
process.env.IMAP_INSPECTION_QUEUE_NAME = QUEUE_NAME;
process.env.MAILCATCHER_DATA_DIR = DATA_DIR;
process.env.ENCRYPTION_KEY = 'imap-inspection-test-key';
process.env.IMAP_INSPECTION_GLOBAL_CONCURRENCY = '2';
process.env.IMAP_INSPECTION_GLOBAL_RATE_LIMIT = '1000';
process.env.IMAP_INSPECTION_GLOBAL_RATE_WINDOW_MS = '1000';

const { default: db, initDb } = await import('../src/db.js');
const {
  closeImapInspectionQueue,
  consumeImapInspectionQuota,
  createImapInspectionBatch,
  enqueueImapInspection,
  getImapInspectionBatch,
  ImapInspectionBusyError,
  imapInspectionQueue,
  imapInspectionQueueEvents,
  startImapInspectionWorker,
} = await import('../src/services/imapInspectionQueue.js');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForBatch(batchId, userId = 7) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const batch = await getImapInspectionBatch(batchId, { userId, userRole: 'member' });
    if (batch.report?.state === 'completed') return batch.report;
    await wait(20);
  }
  throw new Error(`batch ${batchId} did not complete`);
}

test('inspection queue protects global resources and keeps batch results correct', async t => {
  const control = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  const workerConnections = [];
  const workers = [];

  t.after(async () => {
    await Promise.allSettled(workers.map(worker => worker.close()));
    await closeImapInspectionQueue();
    await control.flushdb();
    await Promise.allSettled(workerConnections.map(connection => connection.quit()));
    await control.quit();
    await db.destroy();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  await control.flushdb();
  await initDb();
  await imapInspectionQueue.setGlobalConcurrency(2);
  await imapInspectionQueueEvents.waitUntilReady();

  let active = 0;
  let peak = 0;
  const processor = async job => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(35);
    active -= 1;
    return { id: job.data.accountId, status: 'success' };
  };

  for (let index = 0; index < 2; index += 1) {
    const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    workerConnections.push(connection);
    const worker = new Worker(QUEUE_NAME, processor, { connection, concurrency: 5 });
    workers.push(worker);
    await worker.waitUntilReady();
  }

  const jobs = await imapInspectionQueue.addBulk(
    Array.from({ length: 8 }, (_, index) => ({
      name: 'concurrency-check',
      data: { accountId: index + 1 },
    })),
  );
  await Promise.all(jobs.map(job => job.waitUntilFinished(imapInspectionQueueEvents, 5000)));
  assert.equal(peak, 2, 'global concurrency applies across multiple worker instances');

  await Promise.all(workers.splice(0).map(worker => worker.close()));
  await imapInspectionQueue.drain(true);
  await control.flushdb();

  const first = await enqueueImapInspection(
    { id: 91, imap_config_version: 1 },
    { maxPending: 1, reservationTtlMs: 60000, cooldownMs: 1000, userId: 7 },
  );
  await wait(1100);
  const duplicate = await enqueueImapInspection(
    { id: 91, imap_config_version: 1 },
    { maxPending: 1, reservationTtlMs: 60000, cooldownMs: 1000, userId: 7 },
  );
  assert.equal(duplicate.jobId, first.jobId, 'queued account remains deduplicated without an enqueue TTL');
  await assert.rejects(
    enqueueImapInspection(
      { id: 92, imap_config_version: 1 },
      { maxPending: 1, reservationTtlMs: 60000, userId: 7 },
    ),
    ImapInspectionBusyError,
    'global backlog admission rejects work above the configured cap',
  );

  await control.flushdb();
  const firstQuota = await consumeImapInspectionQuota(7, 2, { limit: 3, windowMs: 10000 });
  assert.equal(firstQuota.allowed, true);
  assert.equal(firstQuota.remaining, 1);
  const deniedQuota = await consumeImapInspectionQuota(7, 2, { limit: 3, windowMs: 10000 });
  assert.equal(deniedQuota.allowed, false);
  assert.ok(deniedQuota.retryAfterMs > 0);

  await control.flushdb();
  const [inserted] = await db('emails').insert({
    address: 'versioned-forward@example.test',
    source: 'forward',
    created_by: 7,
    imap_config_version: 1,
  }).returning('id');
  const accountId = typeof inserted === 'object' ? inserted.id : inserted;
  const versionOne = await db('emails').where('id', accountId).first();

  const staleBatch = await createImapInspectionBatch(
    [versionOne],
    { userId: 7, userRole: 'member' },
    { cooldownMs: 5000, maxPending: 5 },
  );
  assert.equal(staleBatch.state, 'queued');
  assert.equal(staleBatch.failed, 0, 'queue delay is pending work, not an account failure');
  await db('emails').where('id', accountId).update({ imap_config_version: 2 });
  await startImapInspectionWorker();

  const refreshedReport = await waitForBatch(staleBatch.batch_id);
  assert.equal(refreshedReport.checked, 1);
  assert.equal(refreshedReport.skipped, 1);
  assert.notEqual(
    refreshedReport.results[0].reason,
    'stale_config',
    'a stale queued job is replaced by an inspection of the latest credential version',
  );

  const rateLimit = await imapInspectionQueue.getGlobalRateLimit();
  assert.deepEqual(rateLimit, { max: 1000, duration: 1000 });

  const versionTwo = await db('emails').where('id', accountId).first();
  const jobsBeforeCacheHit = await imapInspectionQueue.getJobCountByTypes('waiting', 'active', 'completed');
  const cachedBatch = await createImapInspectionBatch(
    [versionTwo],
    { userId: 7, userRole: 'member' },
    { cooldownMs: 5000, maxPending: 5 },
  );
  assert.equal(cachedBatch.state, 'completed');
  const jobsAfterCacheHit = await imapInspectionQueue.getJobCountByTypes('waiting', 'active', 'completed');
  assert.equal(jobsAfterCacheHit, jobsBeforeCacheHit, 'post-completion cooldown reuses the safe cached result');

  const forbidden = await getImapInspectionBatch(cachedBatch.batch_id, {
    userId: 8,
    userRole: 'member',
  });
  assert.equal(forbidden.forbidden, true, 'another member cannot read a batch they do not own');

  await db('emails').where('id', accountId).update({ imap_config_version: 3 });
  const versionThree = await db('emails').where('id', accountId).first();
  const jobsBeforeVersionChange = await imapInspectionQueue.getJobCountByTypes('waiting', 'active', 'completed');
  const freshBatch = await createImapInspectionBatch(
    [versionThree],
    { userId: 7, userRole: 'member' },
    { cooldownMs: 5000, maxPending: 5 },
  );
  const jobsAfterVersionChange = await imapInspectionQueue.getJobCountByTypes('waiting', 'active', 'completed');
  assert.ok(
    jobsAfterVersionChange > jobsBeforeVersionChange,
    'credential updates enqueue a fresh job instead of reusing the previous version cache',
  );
  const freshReport = await waitForBatch(freshBatch.batch_id);
  assert.equal(freshReport.checked, 1);
  assert.equal(freshReport.skipped, 1);
});
