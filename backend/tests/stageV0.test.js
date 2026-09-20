import assert from 'node:assert/strict';
import test from 'node:test';
import { getJob } from '../src/jobs.js';
import { isVideoUpload, startIdentifyJob } from '../src/pipeline.js';

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
  queries: ['black leather jacket', 'silver zip bomber'],
  attributes: { color: 'black', material: 'leather' },
  brand: null,
  brand_cues: [],
  confidence: 0.9,
  bbox: [0.2, 0.1, 0.8, 0.7],
  chip_key: '/tmp/fit-stealer-chips/jacket-v0.jpg',
  accessibility_line: 'black leather jacket',
  source_frame_index: 1,
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

test('isVideoUpload accepts mp4/mov/webm clips', () => {
  assert.equal(isVideoUpload({ mimetype: 'video/mp4', originalname: 'clip.mp4' }), true);
  assert.equal(isVideoUpload({ mimetype: 'video/quicktime', originalname: 'clip.mov' }), true);
  assert.equal(isVideoUpload({ mimetype: 'image/jpeg', originalname: 'shot.jpg' }), false);
});

test('video jobs run perceiveVideo → SeeChip → matchOutfit with detailing/judging', async (t) => {
  withMockEnv(t);
  const calls = [];
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      perceive: async () => {
        throw new Error('screenshot perceive must not run on video');
      },
      ingestVideo: async () => {
        calls.push('ingestVideo');
        return {
          image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
          frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.4, sharpness: 90 }],
          keyframes: ['data:image/jpeg;base64,xx'],
          frame_count: 3,
          selected_frames: 1,
          outfit_summary: '',
        };
      },
      seeVideoFrames: async () => {
        calls.push('seeVideoFrames');
        return {
          garments: [VIDEO_GARMENT],
          outfit_summary: 'black leather jacket',
          keyframes: ['data:image/jpeg;base64,xx'],
        };
      },
      perceiveVideo: async () => {
        throw new Error('combined identify-video must not run when ingest is available');
      },
      seeChips: async (garments) => {
        calls.push('seeChips');
        return garments.map((garment) => ({
          ...garment,
          description: 'black leather jacket silver zip hardware',
          queries: ['black leather jacket', 'silver zip bomber'],
        }));
      },
      resolveSourceMode: async () => 'match-loop',
      matchOutfit: async (garments, _jobId, { onStep } = {}) => {
        calls.push('matchOutfit');
        await onStep?.('sourcing', 'searching catalogs');
        await onStep?.('judging', 'comparing product photos to the crop');
        await onStep?.('retrying', 'searching the open web');
        await onStep?.('ranking', 'picking the best matches');
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
                confidence: 0.71,
                reason: 'same silhouette',
                visual_score: 0.71,
                visual_label: 'similar',
              },
            ],
          },
        ];
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(done.media_type, 'video');
  assert.deepEqual(calls, ['ingestVideo', 'seeVideoFrames', 'seeChips', 'matchOutfit']);
  const statuses = (done.steps || []).map((item) => item.status);
  assert.ok(statuses.includes('detailing'), `missing detailing in ${statuses.join(',')}`);
  assert.ok(statuses.includes('judging'), `missing judging in ${statuses.join(',')}`);
  assert.ok(statuses.includes('retrying'), `missing retrying in ${statuses.join(',')}`);
  assert.equal(done.items[0].matches[0].visual_score, 0.71);
  assert.equal(done.items[0].matches[0].url, 'https://shop.example/jacket');
  assert.ok(!String(done.items[0].matches[0].url).includes('shopify.com/example'));
});

test('video live miss returns empty cards, not mock Shopify URLs', async (t) => {
  withMockEnv(t);
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(VIDEO_FILE.buffer) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: ['/tmp/fit-stealer-chips/frame-0.jpg'],
        frames: [{ path: '/tmp/fit-stealer-chips/frame-0.jpg', index: 0, timestamp: 0.4, sharpness: 90 }],
        keyframes: [],
        frame_count: 2,
        selected_frames: 1,
      }),
      seeVideoFrames: async () => ({
        garments: [VIDEO_GARMENT],
        outfit_summary: 'black leather jacket',
        keyframes: [],
      }),
      seeChips: async (garments) => garments,
      resolveSourceMode: async () => 'match-loop',
      matchOutfit: async (garments, _jobId, { onStep } = {}) => {
        await onStep?.('sourcing', 'searching catalogs');
        await onStep?.('judging', 'comparing product photos to the crop');
        await onStep?.('ranking', 'picking the best matches');
        return garments.map((garment) => ({ garment, matches: [] }));
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(done.items.length, 1);
  assert.deepEqual(done.items[0].matches, []);
  const blob = JSON.stringify(done);
  assert.ok(!blob.includes('shopify.com/example'));
  assert.ok(!blob.includes('picsum.photos'));
});
