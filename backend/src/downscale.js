const MAX_EDGE = 1280;

export async function downscaleUpload(file) {
  if (!file?.buffer?.length) return file;

  try {
    const sharp = (await import('sharp')).default;
    const image = sharp(file.buffer, { failOn: 'none' }).rotate();
    const meta = await image.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const longest = Math.max(width, height);

    let pipeline = image;
    if (longest > MAX_EDGE) {
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
  } catch (error) {
    console.warn('[ingest] downscale skipped:', error.message);
  }

  return file;
}
