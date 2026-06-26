import express from 'express';
import cors from 'cors';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import authRoutes from './routes/auth.js';
import emailRoutes from './routes/emails.js';
import mailServerRoutes from './routes/mailServers.js';
import messageRoutes from './routes/message.js';
import logRoutes from './routes/logs.js';
import claudeRoutes from './routes/claude.js';
import codexRoutes from './routes/codex.js';
import userRoutes from './routes/users.js';
import { authMiddleware } from './middleware/auth.js';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/admin', authRoutes);
app.use('/api/admin/user', userRoutes);
app.use('/api/admin/email', emailRoutes);
app.use('/api/admin/mail-server', mailServerRoutes);
app.use('/api/v1/message', messageRoutes);
app.use('/api/v1/claude', claudeRoutes);
app.use('/api/v1/codex', codexRoutes);
app.use('/api/admin/logs', logRoutes);

app.use(express.static(join(__dirname, '..', 'public')));

app.get('/api/admin/stats', authMiddleware, (req, res) => {
  const emails = db.prepare('SELECT COUNT(*) c FROM emails').get().c;
  const servers = db.prepare('SELECT COUNT(*) c FROM mail_servers').get().c;
  const logs = db.prepare('SELECT COUNT(*) c FROM email_logs').get().c;
  const successLogs = db.prepare('SELECT COUNT(*) c FROM email_logs WHERE success = 1').get().c;
  res.json({ code: 200, data: { emails, servers, logs, successLogs } });
});

app.get('*', (req, res) => {
  const publicIndex = join(__dirname, '..', 'public', 'index.html');
  res.sendFile(publicIndex, err => {
    if (err) res.status(404).json({ code: 404, message: 'Not found' });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MailCatcher server running at http://0.0.0.0:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`API:   http://localhost:${PORT}/api/v1/message?type=gpt&token=YOUR_TOKEN`);
});
