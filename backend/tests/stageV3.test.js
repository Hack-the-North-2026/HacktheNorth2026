import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTempPaths, scrubChipKeys } from '../src/cleanup.js';
import { matchOutfit, withAltChip } from '../src/matchingLoop.js';

test('collectTempPaths and scrub include alt video chips', () => {
  const paths = collectTempPaths({
    garments: [
      {
        chip_key: '/tmp/fit-stealer-chips/jacket.jpg',
        alt_chip_key: '/tmp/fit-stealer-chips/jacket-alt.jpg',
      },
    ],
  });
  assert.deepEqual(paths.sort(), [
    '/tmp/fit-stealer-chips/jacket-alt.jpg',
    '/tmp/fit-stealer-chips/jacket.jpg',
  ]);

  const scrubbed = scrubChipKeys([
    {
      garment: {
        id: 'jacket-01-05-05-15-15',
        chip_key: '/tmp/fit-stealer-chips/jacket.jpg',
        alt_chip_key: '/tmp/fit-stealer-chips/jacket-alt.jpg',
      },
      matches: [],
    },
  ]);
  assert.equal(scrubbed[0].garment.chip_key, 'jacket-01-05-05-15-15');
  assert.equal(scrubbed[0].garment.alt_chip_key, '');
});

test('withAltChip swaps in the second-angle chip', () => {
  const garment = { chip_key: '/tmp/fit-stealer-chips/a.jpg', alt_chip_key: '/tmp/fit-stealer-chips/b.jpg' };
  assert.equal(withAltChip(garment).chip_key, '/tmp/fit-stealer-chips/b.jpg');
  assert.equal(withAltChip({ chip_key: '/tmp/a.jpg' }).chip_key, '/tmp/a.jpg');
});

test('mid-band visual re-judges with the alt chip', async () => {
  const judgedChips = [];
  const ranked = await matchOutfit(
    [
      {
        id: 'jacket-1',
        category: 'jacket',
        search_query: 'black leather jacket',
        queries: ['black leather jacket', 'silver zip bomber'],
        chip_key: '/tmp/fit-stealer-chips/side.jpg',
        alt_chip_key: '/tmp/fit-stealer-chips/front.jpg',
      },
    ],
    'job-v3-alt',
    {
      resolveMode: async () => 'match-loop',
      retrieve: async () => [{ title: 'Jacket', url: 'https://shop.example/j', image_url: 'https://cdn.example/j.jpg' }],
      judge: async (garment) => {
        judgedChips.push(garment.chip_key);
        if (garment.chip_key.includes('front.jpg')) {
          return { visual_scores: [{ candidate_index: 0, score: 0.91, label: 'same_item' }], best: 0.91 };
        }
        return { visual_scores: [{ candidate_index: 0, score: 0.7, label: 'similar' }], best: 0.7 };
      },
      browse: async () => {
        throw new Error('browse should not run after alt chip confirms');
      },
      rank: async (_garment, candidates) => [
        { ...candidates[0], match_type: 'exact', confidence: 0.9, reason: 'same item' },
      ],
    },
  );
  assert.deepEqual(judgedChips, [
    '/tmp/fit-stealer-chips/side.jpg',
    '/tmp/fit-stealer-chips/front.jpg',
  ]);
  assert.equal(ranked[0].matches[0].url, 'https://shop.example/j');
});
