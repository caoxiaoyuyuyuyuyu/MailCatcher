#!/usr/bin/env node
// MailCatcher 压测脚本
// 用法: node scripts/bench.mjs [选项]
//   --base      服务地址 (默认 http://localhost:3000)
//   --admin     管理员用户名 (默认 admin)
//   --pass      管理员密码 (默认 admin123)
//   --concurrency  并发数 (默认 100)
//   --total     总请求数 (默认 1000)
//   --mode      sync | async | both (默认 both)
//   --type      验证码类型 (默认 claude)

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.split('=')).filter(a => a[0].startsWith('--')).map(([k, v]) => [k.slice(2), v || 'true'])
);

const BASE = args.base || 'http://localhost:3000';
const ADMIN_USER = args.admin || 'admin';
const ADMIN_PASS = args.pass || 'admin123';
const CONCURRENCY = Number(args.concurrency || 100);
const TOTAL = Number(args.total || 1000);
const MODE = args.mode || 'both';
const TYPE = args.type || 'claude';

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const resp = await fetch(BASE + path, opts);
  return resp.json();
}

function percentile(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function printStats(label, latencies, errors, elapsed) {
  const success = latencies.length;
  const total = success + errors;
  const qps = (total / elapsed * 1000).toFixed(1);
  console.log(`\n── ${label} ──`);
  console.log(`  总请求: ${total}  成功: ${success}  失败: ${errors}`);
  console.log(`  耗时: ${(elapsed / 1000).toFixed(2)}s  QPS: ${qps}`);
  if (success > 0) {
    console.log(`  延迟 P50: ${percentile(latencies, 50).toFixed(0)}ms  P95: ${percentile(latencies, 95).toFixed(0)}ms  P99: ${percentile(latencies, 99).toFixed(0)}ms`);
    console.log(`  延迟 min: ${Math.min(...latencies).toFixed(0)}ms  max: ${Math.max(...latencies).toFixed(0)}ms  avg: ${(latencies.reduce((a, b) => a + b, 0) / success).toFixed(0)}ms`);
  }
}

async function runParallel(total, concurrency, fn) {
  const latencies = [];
  let errors = 0;
  let completed = 0;
  let nextIdx = 0;

  const start = Date.now();

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= total) break;
      try {
        const t0 = Date.now();
        const ok = await fn(idx);
        const elapsed = Date.now() - t0;
        if (ok) latencies.push(elapsed);
        else errors++;
      } catch {
        errors++;
      }
      completed++;
      if (completed % Math.max(1, Math.floor(total / 10)) === 0) {
        process.stdout.write(`  进度: ${completed}/${total} (${(completed / total * 100).toFixed(0)}%)\r`);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  const elapsed = Date.now() - start;
  process.stdout.write('\r' + ' '.repeat(50) + '\r');
  return { latencies, errors, elapsed };
}

async function setup(token) {
  // 确保有测试用的 forward 账号（使用 mock 171 或已有账号）
  const list = await api('GET', '/api/admin/email/list?pageSize=100&source=forward', null, token);
  const candidates = (list.code === 200 ? list.data.list : []).filter(a => a.health_status === 'active' && a.status === 1);
  if (!candidates.length) {
    console.log('  没有可用的 active forward 账号，跳过取码压测');
    return null;
  }
  const email = candidates[0].address;
  console.log(`  使用账号: ${email}`);
  return email;
}

async function benchSync(token, email, total, concurrency) {
  console.log(`\n[同步取码] 并发=${concurrency} 总请求=${total}`);
  const { latencies, errors, elapsed } = await runParallel(total, concurrency, async () => {
    const r = await api('GET', `/api/v1/message?email=${encodeURIComponent(email)}&type=${TYPE}`, null, token);
    return r.code === 200;
  });
  printStats('同步取码 (GET /api/v1/message)', latencies, errors, elapsed);
}

async function benchAsync(token, email, total, concurrency) {
  console.log(`\n[异步取码] 并发=${concurrency} 总请求=${total}`);

  // Phase 1: 提交任务（纯入队性能）
  const taskIds = [];
  const { latencies: submitLats, errors: submitErrs, elapsed: submitElapsed } = await runParallel(total, concurrency, async () => {
    const r = await api('POST', '/api/v1/message/async', { email, type: TYPE }, token);
    if (r.code === 200 && r.data?.taskId) {
      taskIds.push(r.data.taskId);
      return true;
    }
    return false;
  });
  printStats('异步提交 (POST /api/v1/message/async)', submitLats, submitErrs, submitElapsed);

  // Phase 2: 等待所有任务完成（Worker 处理能力）
  if (taskIds.length > 0) {
    console.log(`\n  等待 ${taskIds.length} 个任务完成...`);
    const pollStart = Date.now();
    const pollLats = [];
    let pollErrors = 0;
    let pollCompleted = 0;

    const { latencies: completionLats, errors: completionErrors, elapsed: completionElapsed } = await runParallel(taskIds.length, Math.min(concurrency, taskIds.length), async (idx) => {
      const taskId = taskIds[idx];
      const taskStart = Date.now();
      for (let attempt = 0; attempt < 120; attempt++) {
        const r = await api('GET', `/api/v1/message/task/${taskId}`);
        if (r.code === 200 || r.code === 500 || r.code === 403 || r.code === 400) {
          return r.code === 200;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    });
    printStats('任务完成 (Worker 处理)', completionLats, completionErrors, completionElapsed);
  }
}

async function benchApiOnly(token, total, concurrency) {
  console.log(`\n[纯 API 吞吐] 并发=${concurrency} 总请求=${total}`);
  const { latencies, errors, elapsed } = await runParallel(total, concurrency, async () => {
    const r = await api('GET', '/api/admin/stats', null, token);
    return r.code === 200;
  });
  printStats('纯 API (GET /api/admin/stats)', latencies, errors, elapsed);
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     MailCatcher 压力测试                  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  服务: ${BASE}`);
  console.log(`  并发: ${CONCURRENCY}  总请求: ${TOTAL}  模式: ${MODE}`);

  // Login
  const login = await api('POST', '/api/admin/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (login.code !== 200) {
    console.error('登录失败:', login.message);
    process.exit(1);
  }
  const token = login.data.accessToken;
  console.log('  登录成功');

  // 1. 纯 API 吞吐基准
  await benchApiOnly(token, TOTAL, CONCURRENCY);

  // 2. 取码压测
  const email = await setup(token);
  if (!email) return;

  if (MODE === 'sync' || MODE === 'both') {
    await benchSync(token, email, Math.min(TOTAL, 50), Math.min(CONCURRENCY, 10));
  }
  if (MODE === 'async' || MODE === 'both') {
    await benchAsync(token, email, TOTAL, CONCURRENCY);
  }

  console.log('\n压测完成。');
}

main().catch(err => {
  console.error('压测异常:', err);
  process.exit(1);
});
