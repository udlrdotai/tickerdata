import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareImport, applyImport } from '../scripts/import.js';
import { loadDataset } from '../scripts/cli.js';
import { stableStringify } from '../src/model.js';
import { createDatasetFixture } from './fixtures/dataset.js';

test('single record and vocabulary imports are validated without touching source objects', async () => {
  const current = createDatasetFixture();
  const before = stableStringify(current);
  const record = structuredClone(current.instruments[0]);
  record.notes = 'A local correction';
  const prepared = prepareImport(current, JSON.parse(stableStringify(record)));
  assert.equal(prepared.changed.length, 1);
  assert.equal(stableStringify(current), before);
  const vocabulary = structuredClone(current.vocabulary);
  vocabulary.themes[0].name_zh = 'Renamed display only';
  assert.equal(prepareImport(current, vocabulary).changed.length, 1);
  record.classification.primary_theme_id = 'missing';
  assert.throws(() => prepareImport(current, record), /unknown primary theme/);
  assert.throws(() => prepareImport(current, { ...current, instruments: [] }), /do not delete historical/);
});

test('full bundle applies dependent vocabulary and record edits together and blocks stale preview', async () => {
  const folder = await mkdtemp(resolve('.import-test-'));
  try {
    const fixture = createDatasetFixture();
    await mkdir(resolve(folder, 'data/instruments'), { recursive: true });
    await writeFile(resolve(folder, 'data/vocabulary.json'), stableStringify(fixture.vocabulary));
    for (const record of fixture.instruments) {
      await writeFile(resolve(folder, `data/instruments/${record.id}.json`), stableStringify(record));
    }
    const before = await loadDataset(folder);
    const bundle = structuredClone(before);
    const source = bundle.vocabulary.themes[0].id;
    const target = bundle.vocabulary.themes[1].id;
    bundle.vocabulary.themes = bundle.vocabulary.themes.filter((theme) => theme.id !== source);
    for (const record of bundle.instruments) {
      if (record.classification.primary_theme_id === source) {
        record.classification.primary_theme_id = target;
        record.review.status = 'needs_review';
      }
    }
    const preview = prepareImport(before, bundle);
    assert.ok(preview.changed.length >= 2);
    assert.throws(() => prepareImport(before, bundle.vocabulary), /unknown primary theme/);
    await assert.rejects(applyImport(folder, bundle, '0'.repeat(64)), /Source changed/);
    assert.deepEqual(await loadDataset(folder), before);
    await applyImport(folder, bundle, preview.expected);
    assert.deepEqual(await loadDataset(folder), bundle);
    await assert.rejects(applyImport(folder, before, preview.expected), /Source changed/);
    const onDisk = JSON.parse(await readFile(resolve(folder, 'data/instruments/ins-000001.json'), 'utf8'));
    assert.equal(onDisk.classification.primary_theme_id, target);
  } finally {
    await rm(folder, { recursive: true });
  }
});

test('reviewed record imports retain review protection and publish only after explicit re-review', () => {
  const current = createDatasetFixture();
  const record = current.instruments[0];
  record.name.en = 'Synthetic reviewed company';
  record.symbol.mic = 'XNAS';
  record.review = { status: 'reviewed', reviewer: 'Synthetic reviewer', reviewed_at: '2026-09-01T00:00:00Z' };
  const original = stableStringify(current);
  const edited = structuredClone(record);
  edited.notes = 'A correction after review';
  assert.throws(() => prepareImport(current, edited), /edited reviewed data must become needs_review/);
  edited.review.status = 'needs_review';
  assert.equal(prepareImport(current, edited).candidate.instruments[0].review.status, 'needs_review');
  edited.review.status = 'reviewed';
  edited.review.reviewed_at = '2026-09-02T00:00:00Z';
  assert.equal(prepareImport(current, edited).candidate.instruments[0].review.status, 'reviewed');
  assert.equal(stableStringify(current), original);
});
