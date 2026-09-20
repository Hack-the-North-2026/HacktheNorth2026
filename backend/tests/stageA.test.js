import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  attachImageHash,
  downscaleUpload,
  perceptualHash,
  sha256Buffer,
} from '../src/downscale.js';
import {
  clearIdentifyCache,
  getCachedIdentify,
  identifyCacheSize,
  setCachedIdentify,
} from '../src/identifyCache.js';
import { canonicalizeQuery } from '../src/queryCanonicalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('canonicalizeQuery matches the Python Stage A rules', () => {
  assert.equal(
    canonicalizeQuery('The Oversized Grey Leather Jacket with a Silver Zip'),
    'oversized gray leather jacket silver zip',
  );
  assert.equal(canonicalizeQuery('navy blue wide-leg trousers'), 'navy wide-leg trousers');
  const once = canonicalizeQuery('A very cool maroon bomber jacket');
  assert.equal(once, 'burgundy bomber jacket');
  assert.equal(canonicalizeQuery(once), once);
});

test('identify cache returns a clone and is keyed by image hash', () => {
  clearIdentifyCache();
  const payload = {
    outfit_summary: 'street leather',
    items: [{ garment: { id: 'jacket-02-04-14-18', search_query: 'gray leather jacket' }, matches: [{ url: 'https://shop.example/j' }] }],
  };
  setCachedIdentify('abc123', payload);
  const hit = getCachedIdentify('abc123');
  assert.equal(hit.outfit_summary, 'street leather');
  hit.items[0].matches[0].url = 'mutated';
  const again = getCachedIdentify('abc123');
  assert.equal(again.items[0].matches[0].url, 'https://shop.example/j');
  assert.equal(getCachedIdentify('missing'), null);
  assert.equal(identifyCacheSize(), 1);
  clearIdentifyCache();
});

test('downscaled JPEG sha256 and pHash are stable for the same bytes', async () => {
  const fixture = path.join(__dirname, '../src/fixtures/identify-result.mock.json');
  assert.ok(readFileSync(fixture).length > 10);

  const file = {
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    originalname: 'tiny.jpg',
    mimetype: 'image/jpeg',
  };
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp({
    create: { width: 64, height: 80, channels: 3, background: { r: 40, g: 80, b: 120 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();

  const first = { buffer: Buffer.from(jpeg), originalname: 'a.jpg', mimetype: 'image/jpeg' };
  const second = { buffer: Buffer.from(jpeg), originalname: 'b.jpg', mimetype: 'image/jpeg' };
  await downscaleUpload(first, 'job-a');
  await downscaleUpload(second, 'job-b');
  assert.equal(first.image_hash, second.image_hash);
  assert.equal(first.sha256, sha256Buffer(first.buffer));
  assert.equal(first.phash, await perceptualHash(first.buffer));
  assert.equal(first.phash, second.phash);
  assert.equal(first.phash.length, 16);

  await attachImageHash(file);
  assert.ok(file.image_hash);
});
