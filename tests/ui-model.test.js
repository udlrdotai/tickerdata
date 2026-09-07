import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyInstrument } from '../src/model.js';
import { validateDataset, validateReviewTransitions } from '../src/validation.js';
import { clone, matchesRecord, prepareRecord, references, applyVocabulary, mergeVocabulary, changedFiles, githubLinks, prepareImportedDataset, downgradeRelatedReviews } from '../web/editor-model.js';

function fixture() {
  const record = emptyInstrument('ins-example');
  record.symbol = {
    original: 'EXM', canonical: 'EXM', mic: 'XNAS',
    aliases: [{ provider: 'example-provider', symbol: 'EXM.O' }],
    history: [{ symbol: 'OLD', mic: 'XNYS', valid_from: null, valid_to: null }],
  };
  record.name = { en: 'Example Company', zh: '示例公司' };
  record.classification = { primary_theme_id: 'theme-old', tag_ids: ['tag-old', 'tag-target'], source_ids: [] };
  record.review = { status: 'reviewed', reviewed_at: '2026-01-01T00:00:00.000Z', reviewer: 'Maintainer' };
  const label = (id, name_zh) => ({ id, name_zh, aliases: [], description: '' });
  return {
    schema_version: '1.0.0',
    instruments: [record],
    vocabulary: {
      schema_version: '1.0.0', industry_systems: [],
      themes: [label('theme-old', '旧主题'), label('theme-target', '目标主题')],
      tags: [label('tag-old', '旧标签'), label('tag-target', '目标标签')],
    },
  };
}

test('search includes ticker, names, provider aliases, historical symbols and MIC', () => {
  const record = fixture().instruments[0];
  for (const query of ['exm', 'Example Company', '示例', 'EXM.O', 'example-provider', 'old', 'xnys']) {
    assert.equal(matchesRecord(record, { query }), true, query);
  }
  assert.equal(matchesRecord(record, { query: 'missing' }), false);
  assert.equal(matchesRecord(record, { type: 'etf' }), false);
  assert.equal(matchesRecord(record, { theme: 'theme-old', tag: 'tag-old', review: 'reviewed' }), true);
  assert.equal(matchesRecord(record, { theme: '__none' }), false);
  record.classification.primary_theme_id = null;
  assert.equal(matchesRecord(record, { theme: '__none' }), true);
});

test('stable IDs cannot be changed and reviewed edits require explicit re-review', () => {
  const before = fixture().instruments[0];
  const edited = clone(before);
  edited.name.zh = '更新名称';
  assert.equal(prepareRecord(before, edited).review.status, 'needs_review');
  assert.equal(prepareRecord(before, before).review.status, 'reviewed');
  assert.equal(before.review.status, 'reviewed');
  assert.throws(() => prepareRecord(before, { ...edited, id: 'ins-replaced' }), /ID/);
  const startedAt = Date.now();
  const approved = prepareRecord(before, edited, true);
  const finishedAt = Date.now();
  assert.equal(approved.review.status, 'reviewed');
  assert.ok(Date.parse(approved.review.reviewed_at) > Date.parse(before.review.reviewed_at));
  assert.ok(Date.parse(approved.review.reviewed_at) >= startedAt);
  assert.ok(Date.parse(approved.review.reviewed_at) <= finishedAt);
});

test('import cannot silently claim a new human review', () => {
  const record = fixture().instruments[0];
  assert.equal(prepareRecord(undefined, record).review.status, 'needs_review');
  const previous = clone(record);
  previous.review.status = 'pending';
  assert.equal(prepareRecord(previous, record).review.status, 'needs_review');
  assert.equal(prepareRecord(undefined, emptyInstrument('ins-new')).review.status, 'pending');
});

test('full maintenance bundle reimport preserves all dependent edits and rejects malformed shape', () => {
  const current = fixture();
  const record = current.instruments[0];
  record.classification.source_ids = ['manual'];
  record.sources = [{ id: 'manual', kind: 'manual', label: 'Fixture rationale', url: null, accessed_at: null, fields: ['/classification'] }];
  const bundle = mergeVocabulary(current, 'themes', 'theme-old', 'theme-target');
  const imported = prepareImportedDataset(current, JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(validateDataset(imported), []);
  assert.deepEqual(imported, bundle);
  assert.deepEqual(validateReviewTransitions(current, imported), []);
  assert.throws(() => prepareImportedDataset(current, { instruments: [null] }), /导入结构无效/);
});

test('record review downgrade cascades through related reviewed securities', () => {
  const current = fixture();
  const dependent = clone(current.instruments[0]);
  dependent.id = 'ins-dependent';
  dependent.related_instrument_ids = ['ins-example'];
  current.instruments.push(dependent);
  current.instruments[0].review.status = 'needs_review';
  downgradeRelatedReviews(current);
  assert.equal(current.instruments[1].review.status, 'needs_review');
});

test('explicit re-review refuses future or invalid prior timestamps instead of fabricating dates', () => {
  const record = fixture().instruments[0];
  record.review.reviewed_at = '2099-01-01T00:00:00.000Z';
  assert.throws(() => prepareRecord(record, record, true), /不会自动生成未来审核时间/);
  record.review.reviewed_at = 'not-a-timestamp';
  assert.throws(() => prepareRecord(record, record, true), /原审核时间无效/);
  const edited = clone(record);
  edited.notes = '原审核时间待核实';
  assert.equal(prepareRecord(record, edited).review.status, 'needs_review');
});

test('renaming a vocabulary label preserves IDs and flags references', () => {
  const initial = fixture();
  const vocabulary = clone(initial.vocabulary);
  vocabulary.themes[0].name_zh = '新显示名称';
  const current = applyVocabulary(initial, vocabulary);
  assert.equal(current.vocabulary.themes[0].id, 'theme-old');
  assert.equal(current.instruments[0].classification.primary_theme_id, 'theme-old');
  assert.equal(current.instruments[0].review.status, 'needs_review');
  assert.equal(initial.instruments[0].review.status, 'reviewed');
  assert.deepEqual(changedFiles(initial, current).map((file) => file.path), ['data/vocabulary.json', 'data/instruments/ins-example.json']);
});

test('referenced deletion is refused; unreferenced deletion is allowed', () => {
  const initial = fixture();
  let vocabulary = clone(initial.vocabulary);
  vocabulary.themes = vocabulary.themes.filter((item) => item.id !== 'theme-old');
  assert.throws(() => applyVocabulary(initial, vocabulary), /不能删除被引用/);
  vocabulary = clone(initial.vocabulary);
  vocabulary.themes = vocabulary.themes.filter((item) => item.id !== 'theme-target');
  assert.equal(applyVocabulary(initial, vocabulary).vocabulary.themes.length, 1);
  assert.equal(references(initial, 'themes', 'theme-old').length, 1);
});

test('theme merging is immutable, atomic, preserves aliases and exports every changed file', () => {
  const initial = fixture();
  const targetRecord = clone(initial.instruments[0]);
  targetRecord.id = 'ins-target';
  targetRecord.classification.primary_theme_id = 'theme-target';
  initial.instruments.push(targetRecord);
  const current = mergeVocabulary(initial, 'themes', 'theme-old', 'theme-target');
  assert.equal(initial.vocabulary.themes.length, 2);
  assert.equal(current.vocabulary.themes.length, 1);
  assert.equal(current.instruments[0].classification.primary_theme_id, 'theme-target');
  assert.deepEqual(current.instruments.map((record) => record.review.status), ['needs_review', 'needs_review']);
  assert.deepEqual(current.vocabulary.themes[0].aliases, ['旧主题']);
  assert.deepEqual(changedFiles(initial, current).map((file) => file.path), [
    'data/vocabulary.json', 'data/instruments/ins-example.json', 'data/instruments/ins-target.json',
  ]);
});

test('tag merging deduplicates targets and rejects invalid IDs', () => {
  const initial = fixture();
  const current = mergeVocabulary(initial, 'tags', 'tag-old', 'tag-target');
  assert.deepEqual(current.instruments[0].classification.tag_ids, ['tag-target']);
  assert.equal(current.instruments[0].review.status, 'needs_review');
  assert.throws(() => mergeVocabulary(initial, 'tags', 'tag-old', 'tag-old'), /不同/);
  assert.throws(() => mergeVocabulary(initial, 'tags', 'missing', 'tag-target'), /存在/);
  assert.throws(() => mergeVocabulary(initial, 'industry_systems', 'a', 'b'), /只支持/);
});

test('atomic merge cascades related review dependencies and passes actual dataset validation', () => {
  const initial = fixture();
  const record = initial.instruments[0];
  record.classification.source_ids = ['src-manual'];
  record.sources = [{
    id: 'src-manual', kind: 'manual', label: '人工分类依据', url: null,
    accessed_at: null, fields: ['/classification'],
  }];
  initial.vocabulary.themes.push({ id: 'theme-other', name_zh: '其他主题', description: '', aliases: [] });
  const dependent = clone(record);
  dependent.id = 'ins-dependent';
  dependent.symbol = { original: 'DEP', canonical: 'DEP', mic: 'XNAS', aliases: [], history: [] };
  dependent.classification.primary_theme_id = 'theme-other';
  dependent.related_instrument_ids = [record.id];
  const indirect = clone(dependent);
  indirect.id = 'ins-indirect';
  indirect.symbol = { original: 'IND', canonical: 'IND', mic: 'XNAS', aliases: [], history: [] };
  indirect.related_instrument_ids = [dependent.id];
  initial.instruments.push(indirect, dependent);
  assert.deepEqual(validateDataset(initial), []);
  const merged = mergeVocabulary(initial, 'themes', 'theme-old', 'theme-target');
  assert.deepEqual(merged.instruments.map((item) => item.review.status), ['needs_review', 'needs_review', 'needs_review']);
  assert.deepEqual(validateDataset(merged), []);
  assert.deepEqual(validateReviewTransitions(initial, merged), []);
  assert.equal(changedFiles(initial, merged).length, 4);
  const vocabulary = clone(initial.vocabulary);
  vocabulary.themes[0].description = '更新主题定义';
  const renamed = applyVocabulary(initial, vocabulary);
  assert.deepEqual(validateDataset(renamed), []);
  assert.equal(changedFiles(initial, renamed).length, 4);
});

test('a reviewed edit is valid only with downgrade or a newer explicit review', () => {
  const initial = fixture();
  const record = initial.instruments[0];
  record.classification.source_ids = ['src-manual'];
  record.sources = [{
    id: 'src-manual', kind: 'manual', label: '人工分类依据', url: null,
    accessed_at: null, fields: ['/classification'],
  }];
  const next = clone(initial);
  next.instruments[0].notes = '更新信息';
  assert.notEqual(validateReviewTransitions(initial, next).length, 0);
  next.instruments[0] = prepareRecord(record, next.instruments[0]);
  assert.deepEqual(validateDataset(next), []);
  assert.deepEqual(validateReviewTransitions(initial, next), []);
  next.instruments[0] = prepareRecord(record, next.instruments[0], true);
  assert.deepEqual(validateDataset(next), []);
  assert.deepEqual(validateReviewTransitions(initial, next), []);
});

test('change list compares against initial source, includes new files and contains detached content', () => {
  const initial = fixture();
  assert.deepEqual(changedFiles(initial, clone(initial)), []);
  const current = clone(initial);
  current.instruments.push(emptyInstrument('ins-new'));
  const files = changedFiles(initial, current);
  assert.deepEqual(files.map((file) => file.path), ['data/instruments/ins-new.json']);
  files[0].content.notes = 'do not mutate the current draft';
  assert.equal(current.instruments[1].notes, '');
});

test('GitHub links require a valid repository and encode branch and file paths', () => {
  for (const repository_url of [null, '', 'javascript:alert(1)', 'https://evil.test/a/b', 'https://github.com/a/b?query=1', 'https://github.com/a/b/extra']) {
    assert.deepEqual(githubLinks({ repository_url, branch: 'main' }, 'data/vocabulary.json'), []);
  }
  const config = { repository_url: 'https://github.com/owner/repo/', branch: 'feature/中文' };
  const links = githubLinks(config, 'data/中文 file.json');
  assert.equal(links.length, 3);
  assert.equal(links[0][1], 'https://github.com/owner/repo/blob/feature%2F%E4%B8%AD%E6%96%87/data/%E4%B8%AD%E6%96%87%20file.json');
  assert.ok(links[2][1].includes('/commits/feature%2F'));
  assert.equal(githubLinks(config, 'data/instruments/ins-new.json', false)[0][1],
    'https://github.com/owner/repo/new/feature%2F%E4%B8%AD%E6%96%87?filename=data%2Finstruments%2Fins-new.json');
});
