import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
dotenv.config({ override: true });

await import('./sentry.js');
const { getJob } = await import('./jobs.js');
const { isImageUpload, startIdentifyJob } = await import('./pipeline.js');

const app = express();
app.set('etag', false);
const PORT = Number(process.env.BACKEND_PORT || 4000);
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  const started = performance.now();
  res.on('finish', () => {
    const context = {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - started),
    };
    const routinePoll = req.method === 'GET' && req.path.startsWith('/jobs/');
    if (res.statusCode >= 500) logger.error('http.request', new Error(`HTTP ${res.statusCode}`), context);
    else if (res.statusCode >= 400) logger.warn('http.request', context);
    else if (routinePoll) logger.debug('http.request', context);
    else logger.info('http.request', context);
  });
  next();
});

function lanIPv4() {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const iface of addrs || []) {
      const family = iface.family === 'IPv4' || iface.family === 4;
      if (family && !iface.internal) return iface.address;
    }
  }
  return null;
}

export function isDevUploadEnabled() {
  if (process.env.ENABLE_DEV_UPLOAD === 'true') return true;
  if (process.env.ENABLE_DEV_UPLOAD === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'Fit Stealer Backend' });
});

app.get('/health', async (_req, res) => {
  let aiService = 'unreachable';
  try {
    const response = await fetch(`${AI_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      aiService = 'ok';
    }
  } catch {
    aiService = 'unreachable';
  }

  const lan = lanIPv4();
  res.json({
    status: 'ok',
    service: 'Fit Stealer Backend',
    aiService,
    expoHint: lan ? `http://${lan}:${PORT}` : `http://localhost:${PORT}`,
  });
});

app.get('/dev/reload', (req, res) => {
  if (!isDevUploadEnabled()) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write('data: connected\n\n');
  const ping = setInterval(() => {
    res.write(':\n\n');
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    res.end();
  });
});

app.get('/dev/upload', (_req, res) => {
  if (!isDevUploadEnabled()) {
    return res.status(404).json({ error: 'Not found.' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../public/dev-upload.html'));
});

app.get('/jobs/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  return res.json(job);
});

function handleIdentify(req, res) {
  const type = String(req.body?.type || 'image');
  const origin = String(req.body?.origin || 'app');

  if (type !== 'image') {
    return res.status(400).json({ error: 'Stage 1 accepts still images only.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'An image file is required (multipart field "image").' });
  }
  if (!isImageUpload(req.file)) {
    return res.status(400).json({ error: 'Upload a JPEG or PNG screenshot.' });
  }

  logger.info('identify.accepted', {
    request_id: req.requestId,
    origin,
    type,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    bytes: req.file.size,
  });

  const job = startIdentifyJob({ origin, file: req.file });
  return res.json(job);
}

function identifyUpload(req, res, next) {
  upload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Image is too large (45 MB max).' });
    }
    return res.status(400).json({ error: err.message || 'Could not read the uploaded image.' });
  });
}

app.post('/api/identify', identifyUpload, handleIdentify);
app.post('/jobs', identifyUpload, handleIdentify);

app.post('/api/process-url', async (req, res) => {
  try {
    const response = await fetch(`${AI_SERVICE_URL}/api/process-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    res.status(502).json({
      detail: timedOut ? 'AI service timed out' : 'AI service unavailable',
    });
  }
});

app.use((error, req, res, _next) => {
  logger.error('http.unhandled', error, {
    request_id: req.requestId,
    method: req.method,
    path: req.path,
  });
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('process.unhandled_rejection', error);
});

process.on('uncaughtException', (error) => {
  logger.error('process.uncaught_exception', error);
  process.exitCode = 1;
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info('server.started', { url: `http://localhost:${PORT}` });
  if (isDevUploadEnabled()) {
    logger.info('server.dev_upload', { url: `http://localhost:${PORT}/dev/upload` });
  }
  const lan = lanIPv4();
  if (lan) {
    logger.info('server.expo_hint', { url: `http://${lan}:${PORT}` });
  }
});
