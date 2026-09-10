import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFiles } from '../worker/index.js';
import { createDatasetFixture } from './fixtures/dataset.js';

test('worker reconstructs and validates an allowed submission', () => {
  const initial = createDatasetFixture();
  const record = structuredClone(initial.instruments[0]);
  record.name.en = 'Updated by worker test';
  record.review.status = 'needs_review';
  record.review.reviewer = null;
  record.review.reviewed_at = null;
  const candidate = applyFiles(initial, [{
    path: `data/instruments/${record.id}.json`,
    content: record,
  }]);
  assert.equal(candidate.instruments[0].name.en, 'Updated by worker test');
  assert.equal(initial.instruments[0].name.en === candidate.instruments[0].name.en, false);
});

test('worker rejects arbitrary paths, mismatched IDs, and invalid datasets', () => {
  const initial = createDatasetFixture();
  assert.throws(
    () => applyFiles(initial, [{ path: '.github/workflows/unsafe.yml', content: {} }]),
    /不允许提交文件/,
  );
  assert.throws(
    () => applyFiles(initial, [{ path: 'data/instruments/other.json', content: initial.instruments[0] }]),
    /不允许提交文件/,
  );
  const invalid = structuredClone(initial.instruments[0]);
  invalid.schema_version = 'invalid';
  assert.throws(
    () => applyFiles(initial, [{ path: `data/instruments/${invalid.id}.json`, content: invalid }]),
    /未通过数据校验/,
  );
});
