import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bytesLabel, logger, shortId } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });
dotenv.config({ override: true });

const { Sentry, sentryEnabled } = await import('./sentry.js');
const { connectMongo, mongoStatus } = await import('./db.js');
const { canReadJob, getJob, getJobFrame, toPublicJob } = await import('./jobs.js');
const { isImageUpload, isVideoUpload, startIdentifyJob } = await import('./pipeline.js');
const { listRecentSearches, sanitizeDeviceId } = await import('./recentSearches.js');

const app = express();
app.set('etag', false);
const PORT = Number(process.env.BACKEND_PORT || 4000);
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

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
    if (res.statusCode < 400) return;
    const jobPoll = req.path.match(/^\/jobs\/([^/]+)$/);
    if (req.path.startsWith('/json') || req.path === '/favicon.ico') return;
    if (jobPoll && res.statusCode === 404) {
      logger.warn(`Job ${shortId(jobPoll[1])} not found`);
      return;
    }
    const took = Math.round(performance.now() - started);
    const line = `HTTP ${res.statusCode} ${req.method} ${req.path} (${took}ms)`;
    if (res.statusCode >= 500) logger.error(line);
    else logger.warn(line);
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
  let ffmpeg = 'unknown';
  try {
    const response = await fetch(`${AI_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      aiService = 'ok';
      const data = await response.json().catch(() => ({}));
      if (data.ffmpeg === 'ok' || data.ffmpeg === 'missing') ffmpeg = data.ffmpeg;
    }
  } catch {
    aiService = 'unreachable';
  }

  const lan = lanIPv4();
  res.json({
    status: 'ok',
    service: 'Fit Stealer Backend',
    aiService,
    ffmpeg,
    mongo: mongoStatus(),
    sentry: sentryEnabled() ? 'ok' : 'unconfigured',
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

function requestDeviceId(req) {
  return sanitizeDeviceId(req.get('x-device-id') || req.query.device_id);
}

app.get('/jobs/:id/frames/:index', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const job = await getJob(req.params.id);
  if (!canReadJob(job, requestDeviceId(req))) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  const frame = getJobFrame(req.params.id, req.params.index);
  if (!frame) {
    return res.status(404).json({ error: 'Frame not found.' });
  }
  res.setHeader('Content-Type', 'image/jpeg');
  return res.send(frame);
});

app.get('/jobs/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const job = await getJob(req.params.id);
  if (!canReadJob(job, requestDeviceId(req))) {
    return res.status(404).json({ error: 'Job not found.' });
  }
  return res.json(toPublicJob(job));
});

app.get('/recent-searches', async (req, res) => {
  const deviceId = sanitizeDeviceId(req.get('x-device-id') || req.query.device_id);
  if (!deviceId) {
    return res.status(400).json({ error: 'A device id is required.' });
  }
  try {
    const searches = await listRecentSearches(deviceId);
    if (searches == null) {
      return res.status(503).json({ error: 'Recent searches are unavailable.' });
    }
    return res.json({ searches });
  } catch (error) {
    logger.error('Could not list recent searches', error);
    return res.status(503).json({ error: 'Recent searches are unavailable.' });
  }
});

function handleIdentify(req, res) {
  if (!req.file) {
    logger.warn('Upload rejected: no media file attached');
    return res.status(400).json({ error: 'A file is required (multipart field "image" or "video").' });
  }

  const isVideo = isVideoUpload(req.file) || req.body?.type === 'video';
  const type = isVideo ? 'video' : 'image';
  const origin = String(req.body?.origin || 'app');

  if (type === 'video') {
    if (!isVideoUpload(req.file)) {
      logger.warn('Upload rejected: not an MP4/MOV/WEBM video');
      return res.status(400).json({ error: 'Upload an MP4, MOV, or WEBM video clip.' });
    }
  } else {
    if (!isImageUpload(req.file)) {
      logger.warn('Upload rejected: not a JPEG/PNG screenshot');
      return res.status(400).json({ error: 'Upload a JPEG or PNG screenshot.' });
    }
  }

  const filename = decodeURIComponent(req.file.originalname || (type === 'video' ? 'clip' : 'screenshot'));
  logger.blank();
  logger.info(`Got ${type} "${filename}" (${bytesLabel(req.file.size)}) from ${origin}`);

  const deviceId = req.body?.device_id;
  const job = startIdentifyJob({ origin, file: req.file, deviceId, type });
  return res.json(toPublicJob(job));
}

const uploadFields = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'file', maxCount: 1 },
]);

function identifyUpload(req, res, next) {
  uploadFields(req, res, (err) => {
    if (!err) {
      if (!req.file) {
        req.file = req.files?.video?.[0] || req.files?.image?.[0] || req.files?.file?.[0];
      }
      return next();
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      logger.warn(`Upload rejected: file is larger than ${bytesLabel(MAX_UPLOAD_BYTES)}`);
      return res.status(400).json({ error: `File is too large (${bytesLabel(MAX_UPLOAD_BYTES)} max).` });
    }
    logger.warn(`Upload rejected: ${err.message || 'could not read the file'}`);
    return res.status(400).json({ error: err.message || 'Could not read the uploaded file.' });
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

Sentry.setupExpressErrorHandler(app);

app.use((error, req, res, _next) => {
  logger.error(`Unhandled error on ${req.method} ${req.path}`, error);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exitCode = 1;
});

app.listen(PORT, '0.0.0.0', () => {
  void connectMongo();
  logger.info(`Backend ready at http://localhost:${PORT}`);
  if (sentryEnabled()) {
    logger.info('Sentry tracing and logs enabled');
  } else {
    logger.warn('Sentry DSN not set — add SENTRY_DSN to .env to turn on tracing');
  }
  if (isDevUploadEnabled()) {
    logger.info(`Dev upload page: http://localhost:${PORT}/dev/upload`);
  }
  const lan = lanIPv4();
  if (lan) {
    logger.info(`Phone should use: http://${lan}:${PORT}`);
  }
});
