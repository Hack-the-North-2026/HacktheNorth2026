import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseFailStage } from '../src/matchDisplay.js';
import { clearIdentifyCache } from '../src/identifyCache.js';
import { getJob } from '../src/jobs.js';
import { startIdentifyJob } from '../src/pipeline.js';

const VIDEO_FILE = {
  buffer: Buffer.from('fake-mp4-v6'),
  originalname: 'clip.mp4',
  mimetype: 'video/mp4',
  size: 12,
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

test('diagnoseFailStage names ingest when a clip has no usable frames', () => {
  assert.equal(diagnoseFailStage([], { empty_reason: 'ingest', media_type: 'video' }), 'ingest');
  assert.equal(diagnoseFailStage([], { empty_reason: 'see', media_type: 'video' }), 'see');
  assert.equal(diagnoseFailStage([], { media_type: 'video' }), null);
});

test('empty video ingest finishes with empty_reason ingest for Sentry', async (t) => {
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
        frame_count: 20,
        selected_frames: 0,
        outfit_summary: "Couldn't find a clear enough view of the outfit in this clip.",
      }),
    },
  });
  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(done.media_type, 'video');
  assert.equal(done.empty_reason, 'ingest');
  assert.equal(diagnoseFailStage(done.items, { empty_reason: done.empty_reason, media_type: done.media_type }), 'ingest');
});

test('empty video See is fail_stage see, not ingest', async (t) => {
  withMockEnv(t);
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
        frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.4, sharpness: 70 }],
        keyframes: ['data:image/jpeg;base64,V6'],
        frame_count: 4,
        selected_frames: 1,
      }),
      seeVideoFrames: async (ingested) => ({
        garments: [],
        outfit_summary: 'empty room',
        keyframes: ingested.keyframes,
      }),
    },
  });
  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(done.empty_reason, 'see');
  assert.deepEqual(done.keyframes, [`/jobs/${job.job_id}/frames/0`]);
  assert.equal(diagnoseFailStage(done.items, { empty_reason: done.empty_reason, media_type: 'video' }), 'see');
});
