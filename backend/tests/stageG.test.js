import assert from 'node:assert/strict';
import test from 'node:test';
import {
  diagnoseFailStage,
  exactCount,
  preferStrongExact,
} from '../src/matchDisplay.js';

test('preferStrongExact keeps one Found card over three similars', () => {
  const matches = preferStrongExact([
    { match_type: 'similar', url: 'https://s.example/a', visual_score: 0.7 },
    { match_type: 'exact', url: 'https://s.example/exact', visual_score: 0.91 },
    { match_type: 'similar', url: 'https://s.example/b', visual_score: 0.65 },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].url, 'https://s.example/exact');
});

test('preferStrongExact keeps up to three similars when nothing is exact', () => {
  const matches = preferStrongExact([
    { match_type: 'similar', url: 'https://s.example/a' },
    { match_type: 'similar', url: 'https://s.example/b' },
    { match_type: 'similar', url: 'https://s.example/c' },
    { match_type: 'similar', url: 'https://s.example/d' },
  ]);
  assert.equal(matches.length, 3);
});

test('diagnoseFailStage names seechip, retrieve, judge, or rank', () => {
  assert.equal(diagnoseFailStage([]), null);
  assert.equal(
    diagnoseFailStage([
      { garment: { id: 'j' }, matches: [{ match_type: 'similar', url: 'https://s.example/a' }] },
    ]),
    'seechip',
  );
  assert.equal(
    diagnoseFailStage([
      { garment: { id: 'j', search_query: 'jacket' }, matches: [] },
    ]),
    'retrieve',
  );
  assert.equal(
    diagnoseFailStage([
      {
        garment: { id: 'j', search_query: 'jacket' },
        matches: [{ match_type: 'similar', url: 'https://s.example/a', visual_score: 0.4 }],
      },
    ]),
    'judge',
  );
  assert.equal(
    diagnoseFailStage([
      {
        garment: { id: 'j', search_query: 'jacket' },
        matches: [{ match_type: 'similar', url: 'https://s.example/a', visual_score: 0.9 }],
      },
    ]),
    'rank',
  );
  assert.equal(
    diagnoseFailStage([
      {
        garment: { id: 'j', search_query: 'jacket' },
        matches: [{ match_type: 'exact', url: 'https://s.example/a', visual_score: 0.91 }],
      },
    ]),
    null,
  );
  assert.equal(exactCount([{ matches: [{ match_type: 'exact' }, { match_type: 'similar' }] }]), 1);
});
