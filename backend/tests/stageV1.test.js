import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTempPaths } from '../src/cleanup.js';
import { getJob } from '../src/jobs.js';
import { startIdentifyJob } from '../src/pipeline.js';

const VIDEO_FILE = {
  buffer: Buffer.from('fake-mp4'),
  originalname: 'clip.mp4',
  mimetype: 'video/mp4',
  size: 8,
};

const VIDEO_GARMENT = {
  id: 'jacket-02-04-14-18',
  category: 'jacket',
  description: 'black leather jacket',
  search_query: 'black leather jacket',
  queries: ['black leather jacket'],
  attributes: { color: 'black' },
  brand: null,
  brand_cues: [],
  confidence: 0.9,
  bbox: [0.2, 0.1, 0.8, 0.7],
  chip_key: '/tmp/fit-stealer-chips/jacket-v1.jpg',
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
  t.after(() => {
    if (previous === undefined) delete process.env.IDENTIFY_MOCK;
    else process.env.IDENTIFY_MOCK = previous;
  });
}

test('collectTempPaths keeps persisted video frames', () => {
  const paths = collectTempPaths({
    image_path: '/tmp/fit-stealer-chips/thumb.jpg',
    image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg', '/etc/passwd'],
    frames: [{ path: '/tmp/fit-stealer-chips/frame-1.jpg' }],
    garments: [{ chip_key: '/tmp/fit-stealer-chips/jacket.jpg' }],
  });
  assert.deepEqual(paths.sort(), [
    '/tmp/fit-stealer-chips/frame-0.jpg',
    '/tmp/fit-stealer-chips/frame-1.jpg',
    '/tmp/fit-stealer-chips/jacket.jpg',
    '/tmp/fit-stealer-chips/thumb.jpg',
  ]);
});

test('video jobs move ingesting → seeing → detailing and publish keyframes after ingest', async (t) => {
  withMockEnv(t);
  const calls = [];
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => {
        calls.push('ingestVideo');
        return {
          image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
          frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.5, sharpness: 88 }],
          keyframes: ['data:image/jpeg;base64,INGEST'],
          frame_count: 5,
          selected_frames: 1,
          outfit_summary: '',
        };
      },
      seeVideoFrames: async (ingested) => {
        calls.push('seeVideoFrames');
        assert.equal(ingested.keyframes[0], 'data:image/jpeg;base64,INGEST');
        return {
          garments: [VIDEO_GARMENT],
          outfit_summary: 'black leather jacket',
          keyframes: ingested.keyframes,
        };
      },
      seeChips: async (garments) => garments,
      resolveSourceMode: async () => 'match-loop',
      matchOutfit: async (garments, _jobId, { onStep } = {}) => {
        calls.push('matchOutfit');
        await onStep?.('sourcing', 'searching catalogs');
        await onStep?.('judging', 'comparing');
        await onStep?.('ranking', 'picking');
        return [{ garment: garments[0], matches: [] }];
      },
      perceiveVideo: async () => {
        throw new Error('identify-video fallback should not run');
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.deepEqual(calls, ['ingestVideo', 'seeVideoFrames', 'matchOutfit']);
  const statuses = (done.steps || []).map((item) => item.status);
  assert.ok(statuses.indexOf('ingesting') < statuses.indexOf('seeing'), `${statuses.join(' → ')}`);
  assert.ok(statuses.indexOf('seeing') < statuses.indexOf('detailing'), `${statuses.join(' → ')}`);
  assert.equal(done.keyframes[0], 'data:image/jpeg;base64,INGEST');
  const ingestStep = (done.steps || []).find((item) => item.status === 'ingesting');
  const seeStep = (done.steps || []).find((item) => item.status === 'seeing');
  assert.equal(ingestStep.note, 'pulling clear frames');
  assert.equal(seeStep.note, 'reading the outfit across frames');
});

test('empty ingest finishes without See', async (t) => {
  withMockEnv(t);
  let seeCalls = 0;
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: [],
        frames: [],
        keyframes: [],
        frame_count: 12,
        selected_frames: 0,
        outfit_summary: "Couldn't find a clear enough view of the outfit in this clip.",
      }),
      seeVideoFrames: async () => {
        seeCalls += 1;
        throw new Error('see should not run');
      },
      seeChips: async () => {
        throw new Error('see-chip should not run');
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(seeCalls, 0);
  assert.deepEqual(done.items, []);
  assert.match(done.outfit_summary, /clear enough view/);
  const statuses = (done.steps || []).map((item) => item.status);
  assert.ok(statuses.includes('ingesting'));
  assert.ok(!statuses.includes('seeing'));
});
