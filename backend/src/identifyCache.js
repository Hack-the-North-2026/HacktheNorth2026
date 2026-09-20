const CACHE_TTL_MS = Number(process.env.IDENTIFY_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const CACHE_MAX = Number(process.env.IDENTIFY_CACHE_MAX || 64);

const cache = new Map();

function clone(value) {
  return structuredClone(value);
}

export function getCachedIdentify(hash) {
  if (!hash) return null;
  const hit = cache.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > CACHE_TTL_MS) {
    cache.delete(hash);
    return null;
  }
  cache.delete(hash);
  cache.set(hash, hit);
  return clone(hit.payload);
}

export function setCachedIdentify(hash, payload) {
  if (!hash || !payload) return;
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(hash, { storedAt: Date.now(), payload: clone(payload) });
}

export function clearIdentifyCache() {
  cache.clear();
}

export function identifyCacheSize() {
  return cache.size;
}
