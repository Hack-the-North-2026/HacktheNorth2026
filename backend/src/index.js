import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

const app = express();
const PORT = Number(process.env.BACKEND_PORT || 4000);
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Fit Stealer Backend' });
});

app.get('/health', async (_req, res) => {
  let aiService = 'unreachable';
  try {
    const response = await fetch(`${AI_SERVICE_URL}/health`);
    if (response.ok) {
      aiService = 'ok';
    }
  } catch {
    aiService = 'unreachable';
  }

  res.json({
    status: 'ok',
    service: 'Fit Stealer Backend',
    aiService,
  });
});

app.post('/api/process-url', async (req, res) => {
  try {
    const response = await fetch(`${AI_SERVICE_URL}/api/process-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch {
    res.status(502).json({ detail: 'AI service unavailable' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
