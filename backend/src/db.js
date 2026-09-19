import { MongoClient, ServerApiVersion } from 'mongodb';
import { logger } from './logger.js';

const uri = process.env.MONGODB_URI || '';

let client = null;
let db = null;
let status = uri ? 'connecting' : 'unconfigured';

export async function connectMongo() {
  if (!uri) {
    logger.warn('MongoDB URI not set — recent searches disabled');
    status = 'unconfigured';
    return null;
  }
  if (db) return db;

  try {
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    await client.connect();
    db = client.db();
    await db.collection('recent_searches').createIndex({ device_id: 1, created_at: -1 });
    status = 'ok';
    logger.info('MongoDB connected — recent searches ready');
    return db;
  } catch (error) {
    status = 'error';
    client = null;
    db = null;
    logger.error('MongoDB connection failed', error);
    return null;
  }
}

export async function getDb() {
  if (db) return db;
  return connectMongo();
}

export function mongoStatus() {
  return status;
}
