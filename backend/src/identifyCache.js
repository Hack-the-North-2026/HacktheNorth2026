const CACHE_TTL_MS = Number(process.env.IDENTIFY_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const CACHE_MAX = Number(process.env.IDENTIFY_CACHE_MAX || 64);
const PHASH_MAX_DISTANCE = Number(process.env.IDENTIFY_PHASH_DISTANCE || 2);

const cache = new Map();

function clone(value) {
  return structuredClone(value);
}

export function hammingHex(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  try {
    let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let distance = 0;
    while (bits) {
      distance += Number(bits & 1n);
      bits >>= 1n;
    }
    return distance;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function touch(key, hit) {
  cache.delete(key);
  cache.set(key, hit);
  return clone(hit.payload);
}

function isFresh(hit) {
  return Boolean(hit) && Date.now() - hit.storedAt <= CACHE_TTL_MS;
}

export function getCachedIdentify(hash, phash) {
  if (hash) {
    const hit = cache.get(hash);
    if (hit && !isFresh(hit)) {
      cache.delete(hash);
    } else if (hit) {
      return touch(hash, hit);
    }
  }
  if (!phash) return null;
  for (const [key, hit] of cache) {
    if (!isFresh(hit)) {
      cache.delete(key);
      continue;
    }
    if (hit.phash && hammingHex(hit.phash, phash) <= PHASH_MAX_DISTANCE) {
      return touch(key, hit);
    }
  }
  return null;
}

export function setCachedIdentify(hash, payload, phash) {
  if (!hash || !payload) return;
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(hash, { storedAt: Date.now(), payload: clone(payload), phash: phash || null });
}

export function clearIdentifyCache() {
  cache.clear();
}

export function identifyCacheSize() {
  return cache.size;
}
