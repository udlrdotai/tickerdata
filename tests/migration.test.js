import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emptyInstrument, stableStringify } from '../src/model.js';
import { recordHash } from '../src/release.js';
import { validateDataset, validateLegacyDataset, validateReviewTransitions, validateSuggestion, validateSuggestionShape } from '../src/validation.js';
import { prepareMigration, applyMigration } from '../scripts/migrate.js';
import { loadDataset } from '../scripts/cli.js';

const label = (id) => ({ id, name_zh: id, aliases: [], description: '' });
function legacyRecord(id = 'ins-first', status = 'pending') {
  const record = emptyInstrument(id);
  record.schema_version = '1.0.0';
  delete record.industry.industry_group_id;
  record.symbol = { original: id.toUpperCase(), canonical: id.toUpperCase(), mic: 'XNAS', aliases: [], history: [] };
  record.name.en = 'Legacy synthetic record';
  record.industry = { system_id: 'yahoo', sector_id: 'technology', industry_id: 'semiconductors', source_ids: ['human'] };
  record.classification = { primary_theme_id: 'theme', tag_ids: ['tag'], source_ids: ['human'] };
  record.sources = [{ id: 'human', kind: 'manual', label: 'Preserved original rationale', url: null, accessed_at: null, fields: ['/industry', '/classification'] }];
  record.review = status === 'reviewed'
    ? { status, reviewed_at: '2026-09-01T00:00:00Z', reviewer: 'Test reviewer' }
    : { status, reviewed_at: null, reviewer: null };
  return record;
}

function legacyDataset() {
  return {
    schema_version: '1.0.0',
    vocabulary: {
      schema_version: '1.0.0', themes: [label('theme')], tags: [label('tag')],
      industry_systems: [{
        ...label('yahoo'), sectors: [label('technology')],
        industries: [{ ...label('semiconductors'), sector_id: 'technology' }],
      }],
    },
    instruments: [legacyRecord(), legacyRecord('ins-second', 'reviewed')],
  };
}

test('explicit migration validates original v1 and preserves content while invalidating reviewed data', () => {
  const before = legacyDataset();
  assert.deepEqual(validateLegacyDataset(before), []);
  const bytes = stableStringify(before);
  const preview = prepareMigration(before, before);
  assert.equal(stableStringify(before), bytes);
  assert.equal(preview.changed.length, 3);
  assert.deepEqual(validateDataset(preview.candidate), []);
  assert.equal(preview.candidate.schema_version, '2.0.0');
  assert.equal(preview.candidate.instruments[0].review.status, 'pending');
  assert.deepEqual(preview.candidate.instruments[1].review, { ...before.instruments[1].review, status: 'needs_review' });
  assert.deepEqual(preview.candidate.instruments[0].sources, before.instruments[0].sources);
  assert.deepEqual(preview.candidate.instruments[0].classification, before.instruments[0].classification);
  assert.equal(preview.candidate.instruments[0].industry.industry_group_id, null);
  assert.deepEqual(preview.candidate.vocabulary.industry_systems[0].industry_groups, []);
  assert.equal(preview.candidate.vocabulary.industry_systems[0].industries[0].industry_group_id, null);
  assert.deepEqual(validateReviewTransitions(before, preview.candidate), []);
  const improperlyReviewed = structuredClone(preview.candidate);
  improperlyReviewed.instruments[1].review = before.instruments[1].review;
  assert.match(validateReviewTransitions(before, improperlyReviewed).join('\n'), /newer explicit human review/);
  assert.throws(() => prepareMigration(preview.candidate, preview.candidate), /already migrated/);
});

test('migration supports original single record and vocabulary, preserving a coherent dataset', () => {
  const original = legacyDataset();
  for (const payload of [original.instruments[0], original.vocabulary]) {
    const preview = prepareMigration(original, payload);
    assert.deepEqual(validateDataset(preview.candidate), []);
    assert.ok(preview.candidate.instruments.every((record) => record.schema_version === '2.0.0'));
  }
  const current = prepareMigration(original, original).candidate;
  const oldRecord = structuredClone(original.instruments[0]);
  oldRecord.notes = 'Explicit legacy correction';
  const recordPreview = prepareMigration(current, oldRecord);
  assert.equal(recordPreview.changed.length, 1);
  assert.equal(recordPreview.candidate.instruments[0].notes, oldRecord.notes);
  const oldVocabulary = structuredClone(original.vocabulary);
  oldVocabulary.themes[0].name_zh = 'Updated old label';
  const vocabularyPreview = prepareMigration(current, oldVocabulary);
  assert.equal(vocabularyPreview.changed.length, 1);
  assert.equal(vocabularyPreview.candidate.vocabulary.themes[0].name_zh, oldVocabulary.themes[0].name_zh);
});

test('malformed or semantically invalid old input is never silently coerced to v2', () => {
  const current = legacyDataset();
  for (const mutation of [
    (value) => { value.extra = true; },
    (value) => { delete value.sources; },
    (value) => { value.industry.industry_group_id = null; },
    (value) => { value.industry.industry_id = 'missing'; },
    (value) => { value.industry.source_ids = []; },
    (value) => { value.sources[0].fields = ['/classification']; },
    (value) => { value.classification.tag_ids = ['missing']; },
    (value) => { value.review.reviewed_at = '2026-02-30T00:00:00Z'; },
    (value) => { value.schema_version = '3.0.0'; },
  ]) {
    const record = structuredClone(current.instruments[0]);
    mutation(record);
    assert.throws(() => prepareMigration(current, record));
  }
  const brokenVocabulary = structuredClone(current.vocabulary);
  brokenVocabulary.industry_systems[0].industries[0].sector_id = 'missing';
  assert.throws(() => prepareMigration(current, brokenVocabulary), /unknown sector/);
  brokenVocabulary.industry_systems[0].industry_groups = [];
  assert.throws(() => prepareMigration(current, brokenVocabulary), /additional properties/);
  assert.throws(() => prepareMigration(current, { ...current, additional: true }), /dataset/);
  assert.throws(() => prepareMigration(current, { ...current, data_version: 'a'.repeat(64) }), /Historical releases/);
  assert.throws(() => prepareMigration(current, { schema_version: '1.0.0', instruments: [] }), /vocabulary/);
});

test('migration never grants review and propagates downgrades through reviewed relationships', () => {
  const original = legacyDataset();
  original.instruments = [legacyRecord('ins-first', 'reviewed'), legacyRecord('ins-second', 'reviewed'), legacyRecord('ins-third', 'reviewed')];
  original.instruments[1].related_instrument_ids = ['ins-first'];
  original.instruments[2].related_instrument_ids = ['ins-second'];
  const current = prepareMigration(original, original).candidate;
  for (let index = 0; index < current.instruments.length; index++) current.instruments[index].review = structuredClone(original.instruments[index].review);
  assert.deepEqual(validateDataset(current), []);
  const preview = prepareMigration(current, original.instruments[0]);
  assert.ok(preview.candidate.instruments.every((record) => record.review.status === 'needs_review'));
  for (let index = 0; index < original.instruments.length; index++) {
    assert.deepEqual(preview.candidate.instruments[index].review, { ...original.instruments[index].review, status: 'needs_review' });
  }
  const unreviewed = prepareMigration(original, original).candidate;
  unreviewed.instruments[0].review.status = 'pending';
  const importedReview = prepareMigration(unreviewed, original.instruments[0]);
  assert.equal(importedReview.candidate.instruments[0].review.status, 'needs_review');
});

test('legacy suggestions retain original strict shape and hashes, never v2 applicability', () => {
  const original = legacyDataset();
  const suggestion = {
    schema_version: '1.0.0', id: 'legacy-suggestion', instrument_id: 'ins-first',
    base_record_sha256: recordHash(original.instruments[0]), generated_at: '2026-09-01T00:00:00Z',
    generator: 'Test only', facts: [], inferences: [], missing: [], proposed: [],
    new_theme_proposals: [], decisions: [],
  };
  const bytes = stableStringify(suggestion);
  assert.deepEqual(validateSuggestionShape(suggestion), []);
  assert.deepEqual(validateSuggestion(suggestion, original, recordHash), []);
  const migrated = prepareMigration(original, original).candidate;
  assert.match(validateSuggestion(suggestion, migrated, recordHash).join('\n'), /protocol version differs/);
  assert.match(validateSuggestion(suggestion, migrated, recordHash).join('\n'), /stale base/);
  assert.equal(stableStringify(suggestion), bytes);
  assert.ok(validateSuggestionShape({ ...suggestion, extra: true }).length);
  assert.ok(validateSuggestionShape({ ...suggestion, schema_version: '3.0.0' }).length);
  const fresh = { ...suggestion, schema_version: '2.0.0', base_record_sha256: recordHash(migrated.instruments[0]) };
  assert.deepEqual(validateSuggestion(fresh, migrated, recordHash), []);
});

test('valid pending legacy input downgrades contextual reviewed dependents without relaxing raw validation', () => {
  const legacy = legacyDataset();
  legacy.instruments = [legacyRecord('ins-first', 'reviewed'), legacyRecord('ins-second', 'reviewed'), legacyRecord('ins-third', 'reviewed')];
  legacy.instruments[1].related_instrument_ids = ['ins-first'];
  legacy.instruments[2].related_instrument_ids = ['ins-second'];
  const current = prepareMigration(legacy, legacy).candidate;
  current.instruments.forEach((record, index) => { record.review = structuredClone(legacy.instruments[index].review); });
  const pending = legacyRecord('ins-first');
  pending.notes = 'Legitimate pending legacy correction';
  const inputBytes = stableStringify(pending);
  for (const baseline of [legacy, current]) {
    const result = prepareMigration(baseline, pending);
    assert.deepEqual(validateDataset(result.candidate), []);
    assert.ok(result.candidate.instruments.every((record) => record.review.status === 'needs_review'));
    assert.equal(result.candidate.instruments[0].notes, pending.notes);
    assert.equal(stableStringify(pending), inputBytes);
    assert.deepEqual(result.candidate.instruments[1].review, { ...legacy.instruments[1].review, status: 'needs_review' });
    const invalid = structuredClone(pending);
    invalid.related_instrument_ids = ['ins-missing'];
    assert.throws(() => prepareMigration(baseline, invalid), /invalid related instrument/);
    invalid.related_instrument_ids = [];
    invalid.review = { status: 'reviewed', reviewer: null, reviewed_at: null };
    assert.throws(() => prepareMigration(baseline, invalid), /review time and reviewer/);
  }
  const independent = structuredClone(current);
  independent.instruments.forEach((record) => { record.related_instrument_ids = []; });
  independent.instruments[1].review.status = 'pending';
  const falseAssertion = legacyRecord('ins-first', 'reviewed');
  falseAssertion.related_instrument_ids = ['ins-second'];
  assert.throws(() => prepareMigration(independent, falseAssertion), /must also be reviewed/);
  const invalidBundle = structuredClone(legacy);
  invalidBundle.instruments[0] = pending;
  assert.throws(() => prepareMigration(current, invalidBundle), /must also be reviewed/);
});

test('migration apply binds source and input hashes, preserves historical releases, and writes v2 atomically', async () => {
  const folder = await mkdtemp(resolve('.migration-test-'));
  try {
    const original = legacyDataset();
    await mkdir(resolve(folder, 'data/instruments'), { recursive: true });
    await mkdir(resolve(folder, 'dist/releases/historical'), { recursive: true });
    await writeFile(resolve(folder, 'dist/releases/historical/instruments.json'), stableStringify(original));
    await writeFile(resolve(folder, 'data/vocabulary.json'), stableStringify(original.vocabulary));
    for (const record of original.instruments) await writeFile(resolve(folder, `data/instruments/${record.id}.json`), stableStringify(record));
    const onDisk = await loadDataset(folder);
    assert.deepEqual(onDisk, original);
    const preview = prepareMigration(onDisk, original);
    assert.deepEqual(await loadDataset(folder), original);
    await assert.rejects(applyMigration(folder, original, null), /expected hash missing/);
    await assert.rejects(applyMigration(folder, original, '0'.repeat(64)), /changed/);
    const changedPayload = structuredClone(original);
    changedPayload.instruments[0].notes = 'Changed after preview';
    await assert.rejects(applyMigration(folder, changedPayload, preview.expected), /input changed/);
    const editedRecord = { ...original.instruments[0], notes: 'Concurrent source edit' };
    await writeFile(resolve(folder, `data/instruments/${editedRecord.id}.json`), stableStringify(editedRecord));
    await assert.rejects(applyMigration(folder, original, preview.expected), /Source.*changed/);
    await writeFile(resolve(folder, `data/instruments/${editedRecord.id}.json`), stableStringify(original.instruments[0]));
    await applyMigration(folder, original, preview.expected);
    assert.deepEqual(await loadDataset(folder), preview.candidate);
    assert.equal(await readFile(resolve(folder, 'dist/releases/historical/instruments.json'), 'utf8'), stableStringify(original));
    await assert.rejects(applyMigration(folder, original, preview.expected), /changed/);
  } finally {
    await rm(folder, { recursive: true });
  }
});
