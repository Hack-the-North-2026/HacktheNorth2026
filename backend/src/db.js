import { MongoClient, ServerApiVersion } from 'mongodb';
import { logger } from './logger.js';

const uri = process.env.MONGODB_URI || '';
const RETRY_AFTER_MS = 30_000;

let client = null;
let db = null;
let status = uri ? 'connecting' : 'unconfigured';
let connecting = null;
let lastFailAt = 0;

function mongoOptions() {
  return {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  };
}

function isAtlasTlsReject(error) {
  const msg = error instanceof Error ? `${error.message} ${error.cause || ''}` : String(error);
  return /alert number 80|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR|tlsv1 alert internal error/i.test(msg);
}

async function publicIpHint() {
  try {
    const response = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(2500) });
    const data = await response.json();
    return typeof data?.ip === 'string' ? data.ip : null;
  } catch {
    return null;
  }
}

export async function connectMongo() {
  if (!uri) {
    logger.warn('MongoDB URI not set — recent searches disabled');
    status = 'unconfigured';
    return null;
  }
  if (db) return db;
  if (connecting) return connecting;
  if (status === 'error' && Date.now() - lastFailAt < RETRY_AFTER_MS) return null;

  connecting = (async () => {
    const next = new MongoClient(uri, mongoOptions());
    try {
      await next.connect();
      const nextDb = next.db();
      await nextDb.collection('recent_searches').createIndex({ device_id: 1, created_at: -1 });
      client = next;
      db = nextDb;
      status = 'ok';
      lastFailAt = 0;
      logger.info('MongoDB connected — recent searches ready');
      return db;
    } catch (error) {
      status = 'error';
      try {
        await next.close();
      } catch {
        // Already closed or never opened.
      }
      client = null;
      db = null;
      lastFailAt = Date.now();
      logger.error('MongoDB connection failed', error);
      if (isAtlasTlsReject(error)) {
        const ip = await publicIpHint();
        logger.error(
          ip
            ? `Atlas closed the TLS handshake (alert 80). Add ${ip} — or 0.0.0.0/0 for local/hackathon — in Atlas Network Access.`
            : 'Atlas closed the TLS handshake (alert 80). Add this machine’s IP, or 0.0.0.0/0, in Atlas Network Access.',
        );
      }
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export async function getDb() {
  if (db) return db;
  return connectMongo();
}

export function mongoStatus() {
  return status;
}
