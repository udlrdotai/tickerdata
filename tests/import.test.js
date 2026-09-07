import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepareImport, applyImport } from '../scripts/import.js';
import { loadDataset } from '../scripts/cli.js';
import { stableStringify } from '../src/model.js';

test('single record and vocabulary imports are validated without touching source objects', async () => {
  const current = await loadDataset();
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
  const folder = await mkdtemp(resolve(tmpdir(), 'tickerdata-import-test-'));
  try {
    await cp(new URL('../data', import.meta.url), resolve(folder, 'data'), { recursive: true });
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
