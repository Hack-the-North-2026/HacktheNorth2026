import tls from 'node:tls';
import { MongoClient, ServerApiVersion } from 'mongodb';
import { logger } from './logger.js';

const uri = process.env.MONGODB_URI || '';

let client = null;
let db = null;
let status = uri ? 'connecting' : 'unconfigured';
let connecting = null;

function mongoOptions() {
  return {
    tls: true,
    // Node 26 negotiates TLS 1.3 by default; Atlas on this network rejects it
    // with "tlsv1 alert internal error". Forcing 1.2 makes the handshake succeed.
    secureContext: tls.createSecureContext({
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    }),
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
    },
  };
}

export async function connectMongo() {
  if (!uri) {
    logger.warn('MongoDB URI not set — recent searches disabled');
    status = 'unconfigured';
    return null;
  }
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    const next = new MongoClient(uri, mongoOptions());
    try {
      await next.connect();
      const nextDb = next.db();
      await nextDb.collection('recent_searches').createIndex({ device_id: 1, created_at: -1 });
      client = next;
      db = nextDb;
      status = 'ok';
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
      logger.error('MongoDB connection failed', error);
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
