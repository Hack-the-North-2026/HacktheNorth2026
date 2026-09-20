import { getDb } from './db.js';
import { logger, shortId } from './logger.js';

const COLLECTION = 'recent_searches';
const LIST_LIMIT = 20;
const DEVICE_ID = /^[a-zA-Z0-9_-]{8,80}$/;

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
  if (!database) return;

  const categories = job.items
    .map((item) => item?.garment?.category)
    .filter(Boolean);
  const previewTitle = job.items[0]?.garment?.description || job.outfit_summary || 'Identified fit';
  const now = new Date();

  try {
    await database.collection(COLLECTION).updateOne(
      { _id: job.job_id },
      {
        $set: {
          job_id: job.job_id,
          device_id: safeDeviceId,
          status: 'done',
          origin: job.origin || 'app',
          outfit_summary: job.outfit_summary || '',
          thumbnail_url: job.thumbnail_url || thumbnailFromItems(job.items),
          items: job.items,
          item_count: job.items.length,
          categories,
          preview_title: previewTitle,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true },
    );
    logger.info(`Job ${shortId(job.job_id)}  saved to recent searches`);
  } catch (error) {
    logger.warn(`Job ${shortId(job.job_id)}  could not save recent search`);
    logger.warn(error instanceof Error ? error.message : String(error));
  }
}

export async function listRecentSearches(deviceId) {
  const safeDeviceId = sanitizeDeviceId(deviceId);
  if (!safeDeviceId) return [];

  const database = await getDb();
  if (!database) return null;

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
  if (!database) return null;

  const doc = await database.collection(COLLECTION).findOne({ job_id: id });
  return toIdentifyResult(doc);
}
