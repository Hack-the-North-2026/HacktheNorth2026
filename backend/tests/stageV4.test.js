import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearIdentifyCache } from '../src/identifyCache.js';
import { getJob } from '../src/jobs.js';
import { needsBrowse, matchOutfit, shouldEarlyExit } from '../src/matchingLoop.js';
import { startIdentifyJob } from '../src/pipeline.js';
import { chipPayload } from '../src/tools.js';

const CLIP_BYTES = Buffer.from('fake-mp4-v4');
const VIDEO_FILE = {
  buffer: CLIP_BYTES,
  originalname: 'clip.mp4',
  mimetype: 'video/mp4',
  size: CLIP_BYTES.length,
};

function chipDir() {
  const dir = path.join(os.tmpdir(), 'fit-stealer-chips');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function waitForJob(jobId, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(jobId);
    if (job?.status === 'done' || job?.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`job ${jobId} did not finish`);
}

test('chipPayload reads a video chip and falls back to alt, never an mp4', () => {
  const dir = chipDir();
  const primary = path.join(dir, 'v4-jacket.jpg');
  const alt = path.join(dir, 'v4-jacket-alt.jpg');
  const clip = path.join(dir, 'v4-clip.mp4');
  writeFileSync(primary, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(alt, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xd9]));
  writeFileSync(clip, Buffer.from('mp4-bytes'));

  const fromPrimary = chipPayload({ chip_key: primary, alt_chip_key: alt });
  assert.ok(fromPrimary?.data);
  assert.equal(fromPrimary.content_type, 'image/jpeg');

  const fromAlt = chipPayload({ chip_key: '/tmp/missing.jpg', alt_chip_key: alt });
  assert.ok(fromAlt?.data);
  assert.notEqual(fromAlt.data, fromPrimary.data);

  assert.equal(chipPayload({ chip_key: clip }), null);
});

test('video exact visual skips Browserbase; weak visual may browse', () => {
  assert.equal(shouldEarlyExit(0.91), true);
  assert.equal(needsBrowse(0.91, 6), false);
  assert.equal(needsBrowse(0.7, 6), false);
  assert.equal(needsBrowse(0.4, 6), true);
  assert.equal(needsBrowse(null, 0), true);
});

test('video garment with chip gets exact from visual, not title rhyme, and does not browse', async () => {
  const dir = chipDir();
  const chip = path.join(dir, 'v4-loop-jacket.jpg');
  writeFileSync(chip, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  let browseCalls = 0;
  const retrieved = [];
  const ranked = await matchOutfit(
    [
      {
        id: 'jacket-00-04-02-16-14',
        category: 'jacket',
        search_query: 'black leather jacket',
        queries: ['black leather jacket', 'silver zip bomber'],
        chip_key: chip,
        source_frame_index: 0,
      },
    ],
    'job-v4-exact',
    {
      resolveMode: async () => 'match-loop',
      retrieve: async (garment) => {
        retrieved.push(Boolean(chipPayload(garment)));
        return [
          {
            title: 'Black Leather Jacket',
            url: 'https://shop.example/jacket',
            image_url: 'https://cdn.example/j.jpg',
            source: 'shopify',
          },
        ];
      },
      judge: async () => ({
        visual_scores: [{ candidate_index: 0, score: 0.91, label: 'same_item' }],
        best: 0.91,
      }),
      browse: async () => {
        browseCalls += 1;
        return [];
      },
      rank: async (_garment, candidates, visualScores) => [
        {
          ...candidates[0],
          match_type: 'exact',
          confidence: 0.9,
          reason: 'same zip and leather as the chip',
          visual_score: visualScores[0].score,
          visual_label: visualScores[0].label,
        },
      ],
    },
  );
  assert.deepEqual(retrieved, [true]);
  assert.equal(browseCalls, 0);
  assert.equal(ranked[0].matches[0].match_type, 'exact');
  assert.equal(ranked[0].matches[0].visual_label, 'same_item');
  assert.ok(!String(ranked[0].matches[0].reason).includes('title'));
});

test('video pipeline hands the cropped chip to matchOutfit', async (t) => {
  const previous = process.env.IDENTIFY_MOCK;
  process.env.IDENTIFY_MOCK = 'none';
  clearIdentifyCache();
  t.after(() => {
    if (previous === undefined) delete process.env.IDENTIFY_MOCK;
    else process.env.IDENTIFY_MOCK = previous;
    clearIdentifyCache();
  });

  const dir = chipDir();
  const chip = path.join(dir, 'v4-pipeline-jacket.jpg');
  writeFileSync(chip, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  let seenChip = false;
  const job = startIdentifyJob({
    origin: 'app',
    file: { ...VIDEO_FILE, buffer: Buffer.from(CLIP_BYTES) },
    type: 'video',
    deps: {
      ingestVideo: async () => ({
        image_paths: [path.join(dir, 'frame-0.jpg')],
        frames: [{ path: path.join(dir, 'frame-0.jpg'), index: 0, timestamp: 0.4, sharpness: 80 }],
        keyframes: ['data:image/jpeg;base64,xx'],
        frame_count: 3,
        selected_frames: 1,
        duration: 6,
      }),
      seeVideoFrames: async () => ({
        garments: [
          {
            id: 'jacket-00-04-02-16-14',
            category: 'jacket',
            description: 'black leather jacket',
            search_query: 'black leather jacket',
            queries: ['black leather jacket'],
            attributes: { color: 'black', material: 'leather' },
            brand: null,
            brand_cues: [],
            confidence: 0.9,
            bbox: [0.2, 0.1, 0.8, 0.7],
            chip_key: chip,
            accessibility_line: 'black leather jacket',
            source_frame_index: 0,
          },
        ],
        outfit_summary: 'black leather jacket',
        keyframes: ['data:image/jpeg;base64,xx'],
      }),
      seeChips: async (garments) => garments,
      resolveSourceMode: async () => 'match-loop',
      matchOutfit: async (garments, _jobId, { onStep } = {}) => {
        seenChip = Boolean(chipPayload(garments[0]));
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
                match_type: 'exact',
                confidence: 0.9,
                reason: 'same zip as the chip',
                visual_score: 0.91,
                visual_label: 'same_item',
              },
            ],
          },
        ];
      },
    },
  });

  const done = await waitForJob(job.job_id);
  assert.equal(done.status, 'done');
  assert.equal(seenChip, true);
  assert.equal(done.items[0].matches[0].match_type, 'exact');
  assert.equal(done.items[0].matches[0].visual_score, 0.91);
});
