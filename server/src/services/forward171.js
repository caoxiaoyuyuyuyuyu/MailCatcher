// 171mail 转发适配器
// 把取码请求转发到 171mail 的公开接口（与 MailCatcher 自身接口一致）：
//   GET https://b.171mail.com/api/v1/message?token=<171mail_token>&type=<type>
// 成功：{ code:200, message:"success", data:{ from, to, subject, body, code, Date } }
// 注意：171mail 的若干"无邮件/抖动"状态是以 code:500 + 中文 message 形式返回的，这里归一化：
//   - 收件箱为空 / 未匹配到邮件 / no new message  → 视为无新邮件（返回 null）
//   - 网络或代理请求失败 / 超时                    → 上游抖动，自动重试
//   - 其余                                         → 硬错误，抛出

const BASE = process.env.FORWARD_171_BASE || 'https://b.171mail.com';
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 4; // 上游抖动概率较高，多次重试压低失败率
const BACKOFF_MS = 600;

// 无新邮件（先于 transient 判定，避免被当作错误重试）
const EMPTY_RE = /收件箱为空|未匹配到邮件|no new message/i;
// 171mail 把所有"临时故障"都包成「获取邮件失败: ...」（网络/代理/未能提取配置/请稍后重试 等），
// 这类一律重试；硬错误（如「邮箱服务器未配置」）不带此前缀，直接抛出。
const TRANSIENT_RE = /获取邮件失败|网络或代理|请稍后重试|timeout|aborted|超时/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function fetchVia171(forwardToken, type) {
  if (!forwardToken) throw new Error('该账号未配置 171mail 转发令牌');
  const t = type === 'chatgpt' ? 'gpt' : (type || 'gpt');
  const url = `${BASE}/api/v1/message?token=${encodeURIComponent(forwardToken)}&type=${encodeURIComponent(t)}`;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let json;
    try {
      const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
      json = await resp.json();
    } catch (err) {
      // 网络层错误（超时/连接失败/非 JSON）→ 重试
      lastErr = new Error(`171mail 转发请求失败: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(BACKOFF_MS); continue; }
      throw lastErr;
    }

    if (json.message === 'success' && json.data) {
      const d = json.data;
      return {
        code: d.code || null,
        subject: d.subject || '',
        body: d.body || '',
        from: d.from || '',
        date: d.date || d.Date || null,
      };
    }

    const msg = json.message || json.msg || '';
    if (EMPTY_RE.test(msg) || (json.code === 200 && !json.data)) return null; // 无新邮件

    if (TRANSIENT_RE.test(msg)) { // 上游抖动 → 重试
      lastErr = new Error(`171mail 上游抖动: ${msg}`);
      if (attempt < MAX_ATTEMPTS) { await sleep(BACKOFF_MS); continue; }
      throw lastErr;
    }

    throw new Error(msg || `171mail 返回异常 (code=${json.code})`); // 硬错误
  }
  throw lastErr || new Error('171mail 转发失败');
}
