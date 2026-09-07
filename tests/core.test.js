import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { emptyInstrument, emptyEtf, stableStringify } from '../src/model.js';
import { validateDataset, validateReviewTransitions, validateSuggestion, symbolEntries } from '../src/validation.js';
import { createRelease, sha256, recordHash } from '../src/release.js';
import { loadDataset } from '../scripts/cli.js';

const vocabulary = JSON.parse(await readFile(new URL('../data/vocabulary.json', import.meta.url), 'utf8'));

function record(id = 'ins-test', symbol = 'TEST', mic = 'XNAS') {
  const value = emptyInstrument(id);
  Object.assign(value.symbol, { original: symbol, canonical: symbol, mic });
  value.listing_status = 'active';
  value.name.en = 'Test security';
  value.classification = { primary_theme_id: 'semiconductor-ai', tag_ids: ['ai'], source_ids: ['human'] };
  value.sources = [{ id: 'human', kind: 'manual', label: 'Human judgment from reviewed reference materials.', url: null, accessed_at: null, fields: ['/classification'] }];
  value.review = { status: 'reviewed', reviewed_at: '2026-09-01T00:00:00Z', reviewer: 'Example reviewer' };
  return value;
}

function dataset(records = [record()]) {
  return { schema_version: '1.0.0', instruments: records, vocabulary: structuredClone(vocabulary) };
}

function expectInvalid(change, pattern) {
  const value = dataset();
  change(value);
  assert.match(validateDataset(value).join('\n'), pattern);
}

test('17 source examples are valid but none pretend to be reviewed', async () => {
  const value = await loadDataset();
  assert.equal(value.instruments.length, 17);
  assert.deepEqual(validateDataset(value), []);
  assert.ok(value.instruments.every((item) => item.review.status === 'pending'));
  assert.equal(value.instruments.find((item) => item.symbol.original === 'BRK-B').symbol.canonical, 'BRK.B');
  const goog = value.instruments.find((item) => item.symbol.original === 'GOOG');
  const googl = value.instruments.find((item) => item.symbol.original === 'GOOGL');
  assert.notEqual(goog.id, googl.id);
  assert.equal(goog.issuer.id, googl.issuer.id);
});

test('strict schema rejects malformed imports, unexpected properties and invalid dates', () => {
  assert.ok(validateDataset(null).length);
  assert.ok(validateDataset({}).length);
  expectInvalid((data) => { data.instruments[0].extra = true; }, /additional properties/);
  expectInvalid((data) => { data.instruments[0].review.reviewed_at = '2026-02-30T00:00:00Z'; }, /format/);
  expectInvalid((data) => { data.instruments[0].review.reviewed_at = '2026-09-01T23:59:60Z'; }, /pattern/);
  expectInvalid((data) => { data.instruments[0].symbol.mic = 'US'; }, /pattern/);
  expectInvalid((data) => { data.instruments[0].id = 'NVDA'; }, /pattern/);
  expectInvalid((data) => { data.instruments[0].sources[0].url = 'javascript:alert(1)'; }, /pattern/);
  expectInvalid((data) => { data.instruments[0].name.zh = ' '; }, /pattern/);
});

test('stable IDs, canonical identifiers and normalized aliases are unique', () => {
  expectInvalid((data) => data.instruments.push(structuredClone(data.instruments[0])), /duplicate stable ID/);
  expectInvalid((data) => data.instruments.push(record('ins-second')), /identifier conflict/);
  expectInvalid((data) => { data.instruments[0].symbol.canonical = 'test'; }, /canonical symbol/);
  expectInvalid((data) => { data.instruments[0].symbol.aliases = [{ provider: 'yahoo', symbol: 'alias' }, { provider: 'yahoo', symbol: 'ALIAS' }]; }, /duplicate normalized/);
  const second = record('ins-second', 'SECOND');
  second.symbol.aliases = [{ provider: 'yahoo', symbol: 'TEST' }];
  assert.match(validateDataset(dataset([record(), second])).join('\n'), /identifier conflict/);
});

test('MIC differentiates listings; country is not a US listing filter; historic reuse remains representable', () => {
  const first = record('ins-first', 'SAME', 'XNAS');
  first.issuer.country = 'TW';
  const second = record('ins-second', 'SAME', 'XNYS');
  assert.deepEqual(validateDataset(dataset([first, second])), []);
  second.symbol.mic = 'XNAS';
  second.listing_status = 'inactive';
  assert.deepEqual(validateDataset(dataset([first, second])), []);
  second.listing_status = 'active';
  second.symbol.canonical = 'NEW';
  second.symbol.original = 'NEW';
  second.symbol.history = [{ symbol: 'SAME', mic: 'XNAS', valid_from: '2000-01-01', valid_to: '2010-01-01' }];
  assert.deepEqual(validateDataset(dataset([first, second])), []);
});

test('provider aliases do not rewrite punctuation or become unscoped original tickers', () => {
  const value = record('ins-class-b', 'BRK.B', 'XNYS');
  value.symbol.original = 'BRK-B';
  value.symbol.aliases = [{ provider: 'yahoo', symbol: 'BRK-B' }];
  assert.deepEqual(symbolEntries(value).filter((entry) => entry.symbol === 'BRK-B').map((entry) => entry.provider), ['yahoo']);
  const hongKong = record('ins-hk', '0700.HK', 'XHKG');
  assert.ok(symbolEntries(hongKong).every((entry) => entry.symbol === '0700.HK'));
});

test('one primary theme, multiple unique tags and stable vocabulary IDs', () => {
  const value = dataset();
  value.instruments[0].classification.tag_ids = ['ai', 'digital-assets'];
  assert.deepEqual(validateDataset(value), []);
  value.vocabulary.themes.find((theme) => theme.id === 'semiconductor-ai').name_zh = '新显示名称';
  assert.deepEqual(validateDataset(value), []);
  expectInvalid((data) => { data.instruments[0].classification.primary_theme_id = ['semiconductor-ai']; }, /string/);
  expectInvalid((data) => { data.instruments[0].classification.tag_ids = ['ai', 'ai']; }, /duplicate items/);
  expectInvalid((data) => { data.instruments[0].classification.tag_ids = ['unknown']; }, /unknown tag/);
  expectInvalid((data) => { data.vocabulary.themes = []; }, /unknown primary theme/);
  expectInvalid((data) => { data.vocabulary.themes.push({ id: 'same-name', name_zh: 'AI云算力', description: '', aliases: [] }); }, /duplicate name\/alias/);
});

test('industry taxonomy and field-level sources are independently validated', () => {
  const value = dataset();
  value.instruments[0].industry = { system_id: 'yahoo', sector_id: 'technology', industry_id: 'semiconductors', source_ids: ['yahoo-source'] };
  value.instruments[0].sources.push({ id: 'yahoo-source', kind: 'provider', label: 'A manually checked provider field', url: 'https://finance.yahoo.com/', accessed_at: '2026-09-01T00:00:00Z', fields: ['/industry'] });
  assert.deepEqual(validateDataset(value), []);
  value.instruments[0].industry.source_ids = ['human'];
  assert.match(validateDataset(value).join('\n'), /does not cover this field/);
  value.instruments[0].industry.industry_id = 'missing';
  assert.match(validateDataset(value).join('\n'), /unknown industry/);
  expectInvalid((data) => { data.instruments[0].classification.source_ids = []; }, /classification needs/);
});

test('ETF has no company industry, needs no holdings, and may have unknown attributes', () => {
  const value = dataset();
  const etf = value.instruments[0];
  etf.security_type = 'etf';
  etf.etf = emptyEtf();
  assert.deepEqual(validateDataset(value), []);
  etf.etf = { ...emptyEtf(), leverage_factor: 3, direction: 'long', reset_period: 'daily', source_ids: ['fund'] };
  etf.sources.push({ id: 'fund', kind: 'issuer', label: 'Fund objective', url: 'https://example.com/fund', accessed_at: null, fields: ['/etf'] });
  assert.deepEqual(validateDataset(value), []);
  etf.etf.reset_period = null;
  assert.match(validateDataset(value).join('\n'), /reset period/);
  etf.industry.system_id = 'yahoo';
  assert.match(validateDataset(value).join('\n'), /ETF cannot use company/);
  expectInvalid((data) => { data.instruments[0].etf = emptyEtf(); }, /non-ETF/);
  expectInvalid((data) => { data.instruments[0].security_type = 'etf'; }, /ETF must/);
});

test('review requires explicit human metadata and is invalidated by changes', () => {
  expectInvalid((data) => { data.instruments[0].review.reviewer = null; }, /review time and reviewer/);
  expectInvalid((data) => { data.instruments[0].classification.primary_theme_id = null; }, /reviewed record needs a primary theme/);
  const before = dataset();
  const after = structuredClone(before);
  after.instruments[0].name.en = 'New company name, same security';
  assert.match(validateReviewTransitions(before, after).join('\n'), /newer explicit human review/);
  after.instruments[0].review.status = 'needs_review';
  assert.deepEqual(validateReviewTransitions(before, after), []);
  after.instruments[0].review.status = 'reviewed';
  after.instruments[0].review.reviewed_at = '2026-09-02T00:00:00Z';
  assert.deepEqual(validateReviewTransitions(before, after), []);
  after.instruments[0].review.reviewed_at = '2026-09-01T00:00:00.001Z';
  assert.deepEqual(validateReviewTransitions(before, after), []);
  before.instruments[0].review.reviewed_at = '2026-09-01T00:00:00.500Z';
  after.instruments[0].review.reviewed_at = '2026-09-01T00:00:00Z';
  assert.match(validateReviewTransitions(before, after).join('\n'), /newer explicit human review/);
  after.instruments = [];
  assert.match(validateReviewTransitions(before, after).join('\n'), /do not delete/);
});

test('reviewed relationships cannot leak dangling unpublished IDs', () => {
  expectInvalid((data) => { data.instruments[0].related_instrument_ids = ['ins-missing']; }, /invalid related/);
  const value = dataset([record(), record('ins-second', 'SECOND')]);
  value.instruments[0].related_instrument_ids = ['ins-second'];
  value.instruments[1].review.status = 'pending';
  assert.match(validateDataset(value).join('\n'), /must also be reviewed/);
});

test('export and import round trip; release bytes and all file versions are deterministic and coherent', () => {
  const value = dataset([record(), record('ins-second', 'SECOND')]);
  assert.deepEqual(JSON.parse(stableStringify(value)), value);
  const first = createRelease(value);
  const second = createRelease(JSON.parse(stableStringify(value)));
  assert.deepEqual(first, second);
  assert.deepEqual(first, createRelease({ ...value, instruments: [...value.instruments].reverse() }));
  for (const [name, info] of Object.entries(first.manifest.files)) {
    assert.equal(sha256(first.files[name]), info.sha256);
    assert.equal(Buffer.byteLength(first.files[name]), info.bytes);
    assert.equal(JSON.parse(first.files[name]).data_version, first.version);
  }
  assert.notEqual(first.version, createRelease(value, { sourceCommit: 'a'.repeat(40) }).version);
  assert.throws(() => createRelease(value, { generatedAt: '2026-02-30T00:00:00Z' }), /generation time/);
  assert.throws(() => createRelease(value, { sourceCommit: 'main' }), /source commit/);
});

test('pending and needs_review records never enter official data or index', () => {
  const value = dataset([record(), record('ins-pending', 'PENDING'), record('ins-stale', 'STALE')]);
  value.instruments[1].review.status = 'pending';
  value.instruments[2].review.status = 'needs_review';
  const release = createRelease(value);
  assert.deepEqual(JSON.parse(release.files['instruments.json']).instruments.map((item) => item.id), ['ins-test']);
  assert.ok(JSON.parse(release.files['symbol-index.json']).entries.every((item) => item.instrument_id === 'ins-test'));
});

test('suggestions cannot mutate authority; existing IDs, stale bases and decisions are checked', () => {
  const value = dataset();
  const before = stableStringify(value);
  const suggestion = {
    schema_version: '1.0.0', id: 'suggestion-example', instrument_id: 'ins-test',
    base_record_sha256: recordHash(value.instruments[0]), generated_at: '2026-09-01T00:00:00Z', generator: 'manual-test',
    facts: [], inferences: ['A hypothesis, not a confirmed fact'], missing: ['Independent source verification'],
    proposed: [{ field: '/classification/primary_theme_id', value: 'ai-cloud', reason: 'Human must assess this reasoning.' }],
    new_theme_proposals: [], decisions: [{ proposal_index: 0, decision: 'accepted', reviewer: 'Human', decided_at: '2026-09-02T00:00:00Z', note: 'Still requires a separate source edit.' }],
  };
  assert.deepEqual(validateSuggestion(suggestion, value, recordHash), []);
  assert.equal(stableStringify(value), before);
  assert.equal(JSON.parse(createRelease(value).files['instruments.json']).instruments[0].classification.primary_theme_id, 'semiconductor-ai');
  suggestion.proposed[0].value = 'invented-new-id';
  assert.match(validateSuggestion(suggestion, value, recordHash).join('\n'), /existing ID/);
  suggestion.base_record_sha256 = '0'.repeat(64);
  assert.match(validateSuggestion(suggestion, value, recordHash).join('\n'), /stale base/);
  suggestion.decisions[0].proposal_index = 9;
  assert.match(validateSuggestion(suggestion, value).join('\n'), /decision index/);
});
