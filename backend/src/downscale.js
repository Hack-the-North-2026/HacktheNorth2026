import { createHash } from 'node:crypto';
import { agentLog, bytesLabel, jobMsg, logger } from './logger.js';

const MAX_EDGE = 1280;
const PHASH_SIZE = 8;

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function clipCacheKey(sha256, durationS) {
  if (!sha256) return null;
  if (durationS == null || !Number.isFinite(Number(durationS))) return String(sha256);
  const tenths = Math.round(Number(durationS) * 10);
  return `${sha256}:d${tenths}`;
}

export function attachClipHash(file) {
  const buffer = file?.buffer;
  if (!buffer?.length) return file;
  file.sha256 = sha256Buffer(buffer);
  file.image_hash = file.sha256;
  file.clip_hash = file.sha256;
  // Never pHash an MP4 container. Optional near-dupe uses the hero keyframe later.
  file.phash = null;
  return file;
}

export async function perceptualHash(buffer) {
  const sharp = (await import('sharp')).default;
  const raw = await sharp(buffer, { failOn: 'none' })
    .greyscale()
    .resize(PHASH_SIZE, PHASH_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();
  let sum = 0;
  for (const value of raw) sum += value;
  const mean = sum / Math.max(1, raw.length);
  let bits = 0n;
  for (const value of raw) {
    bits = (bits << 1n) | (value >= mean ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

export async function attachImageHash(file) {
  const buffer = file?.buffer;
  if (!buffer?.length) return file;
  file.sha256 = sha256Buffer(buffer);
  file.image_hash = file.sha256;
  try {
    file.phash = await perceptualHash(buffer);
  } catch {
    file.phash = null;
  }
  return file;
}

export async function downscaleUpload(file, jobId) {
  if (!file?.buffer?.length) return file;

  try {
    const sharp = (await import('sharp')).default;
    const image = sharp(file.buffer, { failOn: 'none' }).rotate();
    const meta = await image.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const longest = Math.max(width, height);

    let pipeline = image;
    let outW = width;
    let outH = height;
    if (longest > MAX_EDGE) {
      const scale = MAX_EDGE / longest;
      outW = Math.max(1, Math.round(width * scale));
      outH = Math.max(1, Math.round(height * scale));
      pipeline = pipeline.resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const buffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
    file.buffer = buffer;
    file.size = buffer.length;
    file.mimetype = 'image/jpeg';
    if (file.originalname) {
      file.originalname = String(file.originalname).replace(/\.[^.]+$/, '.jpg');
    }

    if (longest > MAX_EDGE) {
      logger.info(
        jobMsg(jobId, `ingest — downscaled ${width}x${height} → ${outW}x${outH} JPEG (${bytesLabel(buffer.length)})`),
      );
    } else {
      logger.info(
        jobMsg(jobId, `ingest — photo is ${width}x${height}, converted to JPEG (${bytesLabel(buffer.length)})`),
      );
    }
    // #region agent log
    agentLog('F', 'downscale.js', 'ingest complete', {
      jobId,
      from: [width, height],
      to: [outW, outH],
      longest,
      resized: longest > MAX_EDGE,
      jpegBytes: buffer.length,
    });
    // #endregion
  } catch (error) {
    logger.warn(jobMsg(jobId, 'ingest — could not downscale, using original photo'));
    logger.warn(error instanceof Error ? error.message : String(error));
  }

  await attachImageHash(file);
  if (file.image_hash) {
    logger.info(jobMsg(jobId, `ingest — image_hash ${file.image_hash.slice(0, 12)}`));
  }
  return file;
}
