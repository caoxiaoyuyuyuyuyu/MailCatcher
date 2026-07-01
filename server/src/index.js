import express from 'express';
import cors from 'cors';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { initDb } from './db.js';
import db from './db.js';
import authRoutes, { ensureDefaultAdmin } from './routes/auth.js';
import emailRoutes from './routes/emails.js';
import mailServerRoutes from './routes/mailServers.js';
import messageRoutes from './routes/message.js';
import logRoutes from './routes/logs.js';
import claudeRoutes from './routes/claude.js';
import codexRoutes from './routes/codex.js';
import userRoutes from './routes/users.js';
import appKeyRoutes from './routes/appKeys.js';
import { authMiddleware } from './middleware/auth.js';
import { startWorker } from './services/queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.use('/api/admin', authRoutes);
app.use('/api/admin/user', userRoutes);
app.use('/api/admin/email', emailRoutes);
app.use('/api/admin/mail-server', mailServerRoutes);
app.use('/api/admin/app-keys', appKeyRoutes);
app.use('/api/v1/message', messageRoutes);
app.use('/api/v1/claude', claudeRoutes);
app.use('/api/v1/codex', codexRoutes);
app.use('/api/admin/logs', logRoutes);

app.use(express.static(join(__dirname, '..', 'public')));

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  const [{ c: emails }] = await db('emails').count('* as c');
  const [{ c: servers }] = await db('mail_servers').count('* as c');
  const [{ c: logs }] = await db('email_logs').count('* as c');
  const [{ c: successLogs }] = await db('email_logs').where('success', 1).count('* as c');
  res.json({ code: 200, data: { emails: Number(emails), servers: Number(servers), logs: Number(logs), successLogs: Number(successLogs) } });
});

app.get('*', (req, res) => {
  const publicIndex = join(__dirname, '..', 'public', 'index.html');
  res.sendFile(publicIndex, err => {
    if (err) res.status(404).json({ code: 404, message: 'Not found' });
  });
});

async function start() {
  await initDb();
  await ensureDefaultAdmin();
  startWorker();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MailCatcher server running at http://0.0.0.0:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin`);
    console.log(`API:   http://localhost:${PORT}/api/v1/message?type=gpt&token=YOUR_TOKEN`);
  });
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
