import assert from 'node:assert/strict';
import test from 'node:test';
import { attachClipHash, clipCacheKey, sha256Buffer } from '../src/downscale.js';
import { clearIdentifyCache, getCachedIdentify } from '../src/identifyCache.js';
import { getJob } from '../src/jobs.js';
import { startIdentifyJob } from '../src/pipeline.js';

const CLIP_BYTES = Buffer.from('fake-mp4-same-clip');
const VIDEO_FILE = {
  buffer: CLIP_BYTES,
  originalname: 'clip.mp4',
  mimetype: 'video/mp4',
  size: CLIP_BYTES.length,
};

const VIDEO_GARMENT = {
  id: 'jacket-00-04-02-16-14',
  category: 'jacket',
  description: 'black leather jacket',
  search_query: 'black leather jacket',
  queries: ['black leather jacket'],
  attributes: { color: 'black' },
  brand: null,
  brand_cues: [],
  confidence: 0.9,
  bbox: [0.2, 0.1, 0.8, 0.7],
  chip_key: '/tmp/fit-stealer-chips/jacket-v2.jpg',
  accessibility_line: 'black leather jacket',
  source_frame_index: 0,
};

async function waitForJob(jobId, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(jobId);
    if (job?.status === 'done' || job?.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`job ${jobId} did not finish`);
}

function withMockEnv(t, value = 'none') {
  const previous = process.env.IDENTIFY_MOCK;
  process.env.IDENTIFY_MOCK = value;
  t.after(() => {
    if (previous === undefined) delete process.env.IDENTIFY_MOCK;
    else process.env.IDENTIFY_MOCK = previous;
  });
}

function liveVideoDeps(calls) {
  return {
    ingestVideo: async () => {
      calls.push('ingestVideo');
      return {
        image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
        frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.5, sharpness: 88 }],
        keyframes: ['data:image/jpeg;base64,V2'],
        frame_count: 5,
        selected_frames: 1,
        duration: 8.4,
        outfit_summary: '',
      };
    },
    seeVideoFrames: async (ingested) => {
      calls.push('seeVideoFrames');
      return {
        garments: [VIDEO_GARMENT],
        outfit_summary: 'black leather jacket',
        keyframes: ingested.keyframes,
        duration: ingested.duration,
      };
    },
    seeChips: async (garments) => garments,
    resolveSourceMode: async () => 'match-loop',
    matchOutfit: async (garments, _jobId, { onStep } = {}) => {
      calls.push('matchOutfit');
      await onStep?.('sourcing', 'searching catalogs');
      await onStep?.('judging', 'comparing');
      await onStep?.('ranking', 'picking');
      return [
        {
          garment: garments[0],
          matches: [
            {
              title: 'Leather Jacket',
              url: 'https://shop.example/jacket',
              image_url: 'https://cdn.example/j.jpg',
              source: 'shopify',
              match_type: 'similar',
              confidence: 0.8,
              reason: 'same silhouette',
              visual_score: 0.8,
              visual_label: 'similar',
            },
          ],
        },
      ];
    },
    perceiveVideo: async () => {
      throw new Error('identify-video fallback should not run');
    },
  };
}

test('attachClipHash is sha256 of the uploaded bytes and never pHashes the container', () => {
  const file = { buffer: Buffer.from(CLIP_BYTES), originalname: 'clip.mp4', mimetype: 'video/mp4' };
  attachClipHash(file);
  assert.equal(file.sha256, sha256Buffer(CLIP_BYTES));
  assert.equal(file.image_hash, file.sha256);
  assert.equal(file.clip_hash, file.sha256);
  assert.equal(file.phash, null);
});

test('clipCacheKey includes rounded ffprobe duration', () => {
  const hash = 'abc123';
  assert.equal(clipCacheKey(hash), 'abc123');
  assert.equal(clipCacheKey(hash, 8.41), 'abc123:d84');
  assert.equal(clipCacheKey(hash, 8.44), 'abc123:d84');
  assert.equal(clipCacheKey(null, 8.4), null);
});

test('same clip x3 hits cache on 2 and 3 and skips ffmpeg', async (t) => {
  withMockEnv(t);
  clearIdentifyCache();
  t.after(() => clearIdentifyCache());

  const calls = [];
  const deps = liveVideoDeps(calls);
  const first = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(CLIP_BYTES) },
    type: 'video',
    deps,
  });
  const firstDone = await waitForJob(first.job_id);
  assert.equal(firstDone.status, 'done');
  assert.deepEqual(calls, ['ingestVideo', 'seeVideoFrames', 'matchOutfit']);
  assert.equal(firstDone.items[0].matches[0].url, 'https://shop.example/jacket');
  assert.equal(firstDone.keyframes[0], 'data:image/jpeg;base64,V2');

  const cached = getCachedIdentify(sha256Buffer(CLIP_BYTES));
  assert.equal(cached.items[0].matches[0].url, 'https://shop.example/jacket');
  assert.equal(cached.clip_duration, 8.4);

  for (let i = 0; i < 2; i += 1) {
    const job = startIdentifyJob({
      origin: 'app',
      file: { ...VIDEO_FILE, buffer: Buffer.from(CLIP_BYTES) },
      type: 'video',
      deps,
    });
    const done = await waitForJob(job.job_id);
    assert.equal(done.status, 'done');
    assert.equal(done.items[0].matches[0].url, 'https://shop.example/jacket');
    assert.equal(done.keyframes[0], 'data:image/jpeg;base64,V2');
    assert.equal(done.items[0].garment.id, firstDone.items[0].garment.id);
  }
  assert.deepEqual(calls, ['ingestVideo', 'seeVideoFrames', 'matchOutfit']);
});

test('different clip bytes miss the cache', async (t) => {
  withMockEnv(t);
  clearIdentifyCache();
  t.after(() => clearIdentifyCache());

  const calls = [];
  const first = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(CLIP_BYTES) },
    type: 'video',
    deps: liveVideoDeps(calls),
  });
  await waitForJob(first.job_id);

  const otherCalls = [];
  const second = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from('a-different-mp4') },
    type: 'video',
    deps: liveVideoDeps(otherCalls),
  });
  const done = await waitForJob(second.job_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(otherCalls, ['ingestVideo', 'seeVideoFrames', 'matchOutfit']);
});

test('IDENTIFY_MOCK results are not cached', async (t) => {
  withMockEnv(t, 'see');
  clearIdentifyCache();
  t.after(() => clearIdentifyCache());

  let ingestCalls = 0;
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(CLIP_BYTES) },
    type: 'video',
    deps: {
      ingestVideo: async () => {
        ingestCalls += 1;
        throw new Error('mock see should not ingest');
      },
      resolveSourceMode: async () => 'mock',
    },
  });
  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(ingestCalls, 0);
  assert.equal(getCachedIdentify(sha256Buffer(CLIP_BYTES)), null);
});

test('mock shop cards are not cached for a live clip hash', async (t) => {
  withMockEnv(t);
  clearIdentifyCache();
  t.after(() => clearIdentifyCache());

  const calls = [];
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(CLIP_BYTES) },
    type: 'video',
    deps: {
      ...liveVideoDeps(calls),
      resolveSourceMode: async () => 'mock',
    },
  });
  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.ok(String(JSON.stringify(done)).includes('shopify.com/example') || done.items[0].matches.length > 0);
  assert.equal(getCachedIdentify(sha256Buffer(CLIP_BYTES)), null);
});
