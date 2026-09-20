import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from './db.js';
import { logger, shortId } from './logger.js';

const COLLECTION = 'recent_searches';
const LIST_LIMIT = 20;
const DEVICE_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const FALLBACK_PATH = path.join(os.tmpdir(), 'fit-stealer-recent-searches.json');

function loadFallback() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFallback(docs) {
  fs.writeFileSync(FALLBACK_PATH, JSON.stringify(docs));
}

function upsertFallback(doc) {
  const docs = loadFallback().filter((row) => row.job_id !== doc.job_id);
  docs.unshift(doc);
  saveFallback(docs.slice(0, 80));
}

function recentDoc(job, safeDeviceId) {
  const now = new Date();
  return {
    _id: job.job_id,
    job_id: job.job_id,
    device_id: safeDeviceId,
    status: 'done',
    origin: job.origin || 'app',
    outfit_summary: job.outfit_summary || '',
    thumbnail_url: safeThumbnail(job.thumbnail_url, job.items),
    items: job.items,
    item_count: job.items.length,
    categories: job.items.map((item) => item?.garment?.category).filter(Boolean),
    preview_title: job.items[0]?.garment?.description || job.outfit_summary || 'Identified fit',
    updated_at: now,
    created_at: now,
  };
}

function persistLocal(job, safeDeviceId, reason) {
  upsertFallback(recentDoc(job, safeDeviceId));
  logger.info(`Job ${shortId(job.job_id)}  saved to recent searches (local, ${reason})`);
}

export function sanitizeDeviceId(value) {
  const id = String(value || '').trim();
  return DEVICE_ID.test(id) ? id : null;
}

function thumbnailFromItems(items) {
  for (const item of items || []) {
    for (const match of item.matches || []) {
      if (match?.image_url) return match.image_url;
    }
  }
  return undefined;
}

function safeThumbnail(thumbnailUrl, items) {
  const raw = String(thumbnailUrl || '');
  if (raw && !raw.startsWith('data:') && !raw.startsWith('blob:')) return raw;
  return thumbnailFromItems(items);
}

export function toIdentifyResult(doc) {
  if (!doc) return null;
  return {
    job_id: doc.job_id,
    status: doc.status,
    origin: doc.origin || 'app',
    thumbnail_url: doc.thumbnail_url,
    outfit_summary: doc.outfit_summary || '',
    items: Array.isArray(doc.items) ? doc.items : [],
  };
}

export function toRecentSearch(doc) {
  return {
    job_id: doc.job_id,
    created_at: doc.created_at instanceof Date ? doc.created_at.toISOString() : doc.created_at,
    outfit_summary: doc.outfit_summary || '',
    item_count: Number(doc.item_count || 0),
    categories: Array.isArray(doc.categories) ? doc.categories : [],
    thumbnail_url: doc.thumbnail_url,
    preview_title: doc.preview_title || doc.outfit_summary || 'Identified fit',
  };
}

export async function persistRecentSearch(job, deviceId) {
  const safeDeviceId = sanitizeDeviceId(deviceId);
  if (!safeDeviceId) return;
  if (!job || job.status !== 'done' || !Array.isArray(job.items) || job.items.length === 0) return;

  const database = await getDb();
  if (!database) {
    persistLocal(job, safeDeviceId, 'atlas-down');
    return;
  }

  const doc = recentDoc(job, safeDeviceId);
  try {
    await database.collection(COLLECTION).updateOne(
      { _id: job.job_id },
      {
        $set: {
          job_id: doc.job_id,
          device_id: doc.device_id,
          status: doc.status,
          origin: doc.origin,
          outfit_summary: doc.outfit_summary,
          thumbnail_url: doc.thumbnail_url,
          items: doc.items,
          item_count: doc.item_count,
          categories: doc.categories,
          preview_title: doc.preview_title,
          updated_at: doc.updated_at,
        },
        $setOnInsert: { created_at: doc.created_at },
      },
      { upsert: true },
    );
    logger.info(`Job ${shortId(job.job_id)}  saved to recent searches`);
  } catch (error) {
    logger.warn(`Job ${shortId(job.job_id)}  could not save recent search`);
    logger.warn(error instanceof Error ? error.message : String(error));
    persistLocal(job, safeDeviceId, 'mongo-write-failed');
  }
}

export async function listRecentSearches(deviceId) {
  const safeDeviceId = sanitizeDeviceId(deviceId);
  if (!safeDeviceId) return [];

  const database = await getDb();
  if (!database) {
    const docs = loadFallback()
      .filter((row) => row.device_id === safeDeviceId)
      .slice(0, LIST_LIMIT);
    return docs.map(toRecentSearch);
  }

  const docs = await database
    .collection(COLLECTION)
    .find({ device_id: safeDeviceId })
    .project({ items: 0, device_id: 0 })
    .sort({ created_at: -1 })
    .limit(LIST_LIMIT)
    .toArray();

  return docs.map(toRecentSearch);
}

export async function findRecentJob(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return null;

  const database = await getDb();
  if (!database) {
    return toIdentifyResult(loadFallback().find((row) => row.job_id === id));
  }

  const doc = await database.collection(COLLECTION).findOne({ job_id: id });
  return toIdentifyResult(doc);
}
