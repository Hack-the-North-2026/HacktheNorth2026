import { unlink } from 'node:fs/promises';
import path from 'node:path';

const MANAGED = /fit-stealer/i;

export function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

export function isManagedTempPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (!path.isAbsolute(filePath)) return false;
  return MANAGED.test(filePath);
}

export function collectTempPaths(result = {}) {
  const imagePath = result.imagePath || result.image_path;
  const garments = result.garments;
  const paths = [];
  if (isManagedTempPath(imagePath)) paths.push(imagePath);
  for (const garment of garments || []) {
    if (isManagedTempPath(garment?.chip_key)) paths.push(garment.chip_key);
    if (isManagedTempPath(garment?.alt_chip_key)) paths.push(garment.alt_chip_key);
  }
  for (const framePath of result.image_paths || []) {
    if (isManagedTempPath(framePath)) paths.push(framePath);
  }
  for (const frame of result.frames || []) {
    if (isManagedTempPath(frame?.path)) paths.push(frame.path);
  }
  return [...new Set(paths)];
}

export async function deleteTempPaths(filePaths) {
  await Promise.all(
    (filePaths || []).map(async (filePath) => {
      if (!isManagedTempPath(filePath)) return;
      try {
        await unlink(filePath);
      } catch {
        // Already gone or not writable from this process.
      }
    }),
  );
}

export function scrubChipKeys(items) {
  return (items || []).map((item) => {
    const garment = item?.garment;
    if (!garment) return item;
    const next = { ...garment };
    let changed = false;
    if (isManagedTempPath(garment.chip_key)) {
      next.chip_key = garment.id || '';
      changed = true;
    }
    if (isManagedTempPath(garment.alt_chip_key)) {
      next.alt_chip_key = '';
      changed = true;
    }
    if (!changed) return item;
    return { ...item, garment: next };
  });
}

export function releaseUpload(file) {
  if (file && Buffer.isBuffer(file.buffer) && file.buffer.length) {
    file.buffer = Buffer.alloc(0);
  }
}
