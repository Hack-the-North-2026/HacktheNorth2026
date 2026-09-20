import assert from 'node:assert/strict';
import test from 'node:test';
  import {
  EXACT_VISUAL_THRESHOLD,
  matchOutfit,
  mergeBrowse,
  needsBrowse,
  needsReformulate,
  shouldEarlyExit,
} from '../src/matchingLoop.js';

test('early-exit skips Browserbase when visual score is high', () => {
  assert.equal(shouldEarlyExit(0.91), true);
  assert.equal(shouldEarlyExit(EXACT_VISUAL_THRESHOLD), true);
  assert.equal(shouldEarlyExit(0.81), false);
  assert.equal(needsBrowse(0.91, 8), false);
  assert.equal(needsBrowse(0.4, 8), true);
  assert.equal(needsBrowse(null, 8), true);
  assert.equal(needsBrowse(0.9, 0), true);
  assert.equal(needsReformulate(0.7), true);
  assert.equal(needsReformulate(0.91), false);
  assert.equal(needsReformulate(0.4), false);
});

test('mergeBrowse prefers catalog URLs on collision and photos first', () => {
  const merged = mergeBrowse(
    [
      { title: 'Catalog', url: 'https://shop.example/j?utm_source=x', image_url: 'https://cdn.example/a.jpg' },
      { title: 'No photo', url: 'https://shop.example/plain' },
    ],
    [
      { title: 'Grailed', url: 'https://www.grailed.com/listings/1', image_url: 'https://cdn.grailed/1.jpg', source: 'browserbase' },
      { title: 'Dup', url: 'https://shop.example/j', image_url: 'https://cdn.example/b.jpg' },
    ],
  );
  assert.equal(merged[0].title, 'Catalog');
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((item) => String(item.url).includes('shop.example/j')).length, 1);
  assert.ok(merged.some((item) => item.title === 'Grailed'));
});

test('match-loop early-exit does not browse when the judge is sure', async () => {
  const steps = [];
  let browseCalls = 0;
  const ranked = await matchOutfit(
    [{ id: 'jacket-1', category: 'jacket', search_query: 'gray leather jacket' }],
    'job-early',
    {
      resolveMode: async () => 'match-loop',
      retrieve: async () => [{ title: 'Leather Jacket', url: 'https://shop.example/j', image_url: 'https://cdn.example/j.jpg' }],
      judge: async () => ({ visual_scores: [{ candidate_index: 0, score: 0.91, label: 'same_item' }], best: 0.91 }),
      browse: async () => {
        browseCalls += 1;
        return [{ title: 'Should not appear', url: 'https://grailed.com/x' }];
      },
      rank: async (_garment, candidates) => candidates.slice(0, 1).map((item) => ({ ...item, match_type: 'exact', confidence: 0.9, reason: 'same item' })),
      onStep: async (status, note) => {
        steps.push({ status, note });
      },
    },
  );
  assert.equal(browseCalls, 0);
  assert.deepEqual(
    steps.map((item) => item.status),
    ['sourcing', 'judging', 'ranking'],
  );
  assert.equal(ranked[0].matches[0].url, 'https://shop.example/j');
});

test('match-loop browses and re-judges when visual scores are weak', async () => {
  const steps = [];
  let judgeCalls = 0;
  const ranked = await matchOutfit(
    [{ id: 'pants-1', category: 'pants', search_query: 'cream trousers' }],
    'job-weak',
    {
      resolveMode: async () => 'match-loop',
      retrieve: async () => [{ title: 'Similar Pants', url: 'https://shop.example/p', image_url: 'https://cdn.example/p.jpg' }],
      judge: async (_garment, candidates) => {
        judgeCalls += 1;
        if (candidates.some((item) => item.source === 'browserbase')) {
          return { visual_scores: [{ candidate_index: 0, score: 0.88, label: 'same_item' }], best: 0.88 };
        }
        return { visual_scores: [{ candidate_index: 0, score: 0.4, label: 'similar' }], best: 0.4 };
      },
      browse: async () => [
        {
          title: 'Exact Pants',
          url: 'https://www.grailed.com/listings/99',
          image_url: 'https://cdn.grailed/99.jpg',
          source: 'browserbase',
        },
      ],
      rank: async (_garment, candidates) => {
        const hit = candidates.find((item) => item.source === 'browserbase') || candidates[0];
        return [{ ...hit, match_type: 'similar', confidence: 0.7, reason: 'close' }];
      },
      onStep: async (status) => {
        steps.push(status);
      },
    },
  );
  assert.equal(judgeCalls, 2);
  assert.ok(steps.includes('retrying'));
  assert.equal(ranked[0].matches[0].url, 'https://www.grailed.com/listings/99');
});

test('match-loop reformulates mid-band visual before browsing', async () => {
  const steps = [];
  const queries = [];
  let browseCalls = 0;
  let judgeCalls = 0;
  const ranked = await matchOutfit(
    [
      {
        id: 'jacket-1',
        category: 'jacket',
        search_query: 'black leather jacket',
        queries: ['black leather jacket', 'silver zip hardware bomber'],
      },
    ],
    'job-mid',
    {
      resolveMode: async () => 'match-loop',
      retrieve: async (garment) => {
        queries.push(garment.search_query);
        if (garment.search_query === 'silver zip hardware bomber') {
          return [{ title: 'Hardware Jacket', url: 'https://shop.example/hw', image_url: 'https://cdn.example/hw.jpg' }];
        }
        return [{ title: 'Close Jacket', url: 'https://shop.example/j', image_url: 'https://cdn.example/j.jpg' }];
      },
      judge: async (_garment, candidates) => {
        judgeCalls += 1;
        if (candidates.some((item) => String(item.url).includes('/hw'))) {
          return { visual_scores: [{ candidate_index: 0, score: 0.91, label: 'same_item' }], best: 0.91 };
        }
        return { visual_scores: [{ candidate_index: 0, score: 0.7, label: 'similar' }], best: 0.7 };
      },
      browse: async () => {
        browseCalls += 1;
        return [];
      },
      rank: async (_garment, candidates) => {
        const hit = candidates.find((item) => String(item.url).includes('/hw')) || candidates[0];
        return [{ ...hit, match_type: 'exact', confidence: 0.9, reason: 'same' }];
      },
      onStep: async (status) => {
        steps.push(status);
      },
    },
  );
  assert.deepEqual(queries, ['black leather jacket', 'silver zip hardware bomber']);
  assert.equal(browseCalls, 0);
  assert.equal(judgeCalls, 2);
  assert.ok(steps.includes('retrying'));
  assert.equal(ranked[0].matches[0].url, 'https://shop.example/hw');
});
