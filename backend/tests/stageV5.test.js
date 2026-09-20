import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyIdentifyCopy,
  failedIdentifyCopy,
  IDENTIFY_POLL_DEADLINE_MS,
  identifyStatusCopy,
  isIngestEmpty,
  timeoutIdentifyCopy,
} from '../../frontend/lib/identifyCopy.js';
import { clearIdentifyCache } from '../src/identifyCache.js';
import { getJob } from '../src/jobs.js';
import { startIdentifyJob } from '../src/pipeline.js';

const VIDEO_FILE = {
  buffer: Buffer.from('fake-mp4-v5'),
  originalname: 'clip.mp4',
  mimetype: 'video/mp4',
  size: 12,
};

const FRAMES = [
  'data:image/jpeg;base64,FRAME0',
  'data:image/jpeg;base64,FRAME1',
  'data:image/jpeg;base64,FRAME2',
];

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
  chip_key: '/tmp/fit-stealer-chips/jacket-v5.jpg',
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

function withMockEnv(t) {
  const previous = process.env.IDENTIFY_MOCK;
  process.env.IDENTIFY_MOCK = 'none';
  clearIdentifyCache();
  t.after(() => {
    if (previous === undefined) delete process.env.IDENTIFY_MOCK;
    else process.env.IDENTIFY_MOCK = previous;
    clearIdentifyCache();
  });
}

test('scan subtitle and empty copy are clip-aware', () => {
  assert.equal(IDENTIFY_POLL_DEADLINE_MS, 270_000);
  assert.equal(identifyStatusCopy('ingesting', 'video'), 'Pulling clear frames…');
  assert.equal(identifyStatusCopy('seeing', 'video'), 'Reading the outfit across frames…');
  assert.equal(identifyStatusCopy('retrying', 'video'), 'Refining the match…');
  assert.equal(identifyStatusCopy('retrying', 'video', 'searching the open web'), 'Searching the open web…');
  assert.equal(identifyStatusCopy('retrying', 'image', 'searching with a sharper query'), 'Searching with a sharper query…');
  assert.equal(identifyStatusCopy('ingesting', 'image'), 'Preparing media…');
  assert.match(timeoutIdentifyCopy('video'), /clip/);
  assert.ok(!timeoutIdentifyCopy('video').includes('screenshot'));

  const ingest = emptyIdentifyCopy({
    media_type: 'video',
    empty_reason: 'ingest',
    outfit_summary: "Couldn't find a clear enough view of the outfit in this clip.",
    items: [],
  });
  assert.equal(ingest.title, 'No frame in this clip was clear enough');
  assert.match(ingest.subtitle, /clip/);
  assert.ok(!ingest.subtitle.includes('screenshot'));

  const see = emptyIdentifyCopy({
    media_type: 'video',
    empty_reason: 'see',
    items: [],
    steps: [
      { status: 'ingesting', at: 't0' },
      { status: 'seeing', at: 't1' },
    ],
  });
  assert.equal(see.title, "We couldn't see a clear outfit.");
  assert.match(see.subtitle, /clip/);

  const photo = emptyIdentifyCopy({ media_type: 'image', empty_reason: 'see', items: [] });
  assert.match(photo.title, /photo/);
  assert.match(photo.subtitle, /screenshot/);

  assert.equal(isIngestEmpty({ empty_reason: 'ingest', steps: [{ status: 'ingesting' }] }), true);
  assert.equal(isIngestEmpty({ empty_reason: 'see', steps: [{ status: 'ingesting' }] }), false);
  assert.match(
    failedIdentifyCopy('This clip took too long to identify. Try another clip.', { media_type: 'video' }).subtitle,
    /clip/,
  );
});

test('empty ingest marks empty_reason ingest so the UI does not say try another screenshot', async (t) => {
  withMockEnv(t);
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: [],
        frames: [],
        keyframes: [],
        frame_count: 18,
        selected_frames: 0,
        outfit_summary: "Couldn't find a clear enough view of the outfit in this clip.",
      }),
      seeVideoFrames: async () => {
        throw new Error('see should not run');
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.items, []);
  assert.equal(done.empty_reason, 'ingest');
  assert.match(done.outfit_summary, /clear enough/);
  const statuses = (done.steps || []).map((item) => item.status);
  assert.ok(statuses.includes('ingesting'));
  assert.ok(!statuses.includes('seeing'));
});

test('empty See marks empty_reason see and keeps the keyframe strip', async (t) => {
  withMockEnv(t);
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
        frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.4, sharpness: 80 }],
        keyframes: FRAMES,
        frame_count: 6,
        selected_frames: 3,
        outfit_summary: '',
      }),
      seeVideoFrames: async (ingested) => ({
        garments: [],
        outfit_summary: 'dark room, no readable clothes',
        keyframes: ingested.keyframes,
      }),
      seeChips: async () => {
        throw new Error('see-chip should not run');
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.items, []);
  assert.equal(done.empty_reason, 'see');
  assert.deepEqual(done.keyframes, [
    `/jobs/${job.job_id}/frames/0`,
    `/jobs/${job.job_id}/frames/1`,
    `/jobs/${job.job_id}/frames/2`,
  ]);
  assert.equal(done.thumbnail_url, `/jobs/${job.job_id}/frames/0`);
});

test('video jobs publish all selected keyframes for the results strip', async (t) => {
  withMockEnv(t);
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
        frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.4, sharpness: 80 }],
        keyframes: FRAMES,
        frame_count: 6,
        selected_frames: 3,
      }),
      seeVideoFrames: async (ingested) => ({
        garments: [VIDEO_GARMENT],
        outfit_summary: 'black leather jacket',
        keyframes: ingested.keyframes,
      }),
      seeChips: async (garments) => garments,
      resolveSourceMode: async () => 'match-loop',
      matchOutfit: async (garments, _jobId, { onStep } = {}) => {
        await onStep?.('sourcing', 'searching catalogs');
        await onStep?.('judging', 'comparing');
        await onStep?.('retrying', 'searching the open web');
        await onStep?.('ranking', 'picking');
        return [{ garment: garments[0], matches: [] }];
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.keyframes, [
    `/jobs/${job.job_id}/frames/0`,
    `/jobs/${job.job_id}/frames/1`,
    `/jobs/${job.job_id}/frames/2`,
  ]);
  assert.equal(done.thumbnail_url, `/jobs/${job.job_id}/frames/0`);
  assert.equal(done.empty_reason, undefined);
});

test('identify-video fallback keeps ingest empty_reason', async (t) => {
  withMockEnv(t);
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      },
      perceiveVideo: async () => ({
        garments: [],
        outfit_summary: "Couldn't find a clear enough view of the outfit in this clip.",
        keyframes: [],
        frame_count: 0,
        empty_reason: 'ingest',
      }),
    },
  });
  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(done.empty_reason, 'ingest');
  assert.deepEqual(done.items, []);
});
