import { agentLog, bytesLabel, jobMsg, logger } from './logger.js';

const MAX_EDGE = 1280;

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

  return file;
}
