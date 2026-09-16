'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cp, mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const {
  lookup,
  UnknownSymbolError,
  AmbiguousSymbolError,
} = require('../reader.cjs');

test('looks up canonical and provider-scoped symbols without rewriting punctuation', () => {
  assert.equal(lookup(' nvda ').symbol.canonical, 'NVDA');
  assert.equal(lookup('BRK-B', { mic: 'xnys', provider: 'YAHOO' }).symbol.canonical, 'BRK.B');
  assert.throws(() => lookup('BRK-B', { provider: 'other' }), UnknownSymbolError);
  assert.throws(() => lookup('BRK.B', { mic: 'XNAS' }), UnknownSymbolError);
});

test('returns isolated records and validates query inputs', () => {
  const first = lookup('NVDA');
  first.name.en = 'mutated';
  assert.notEqual(lookup('NVDA').name.en, 'mutated');
  assert.throws(() => lookup(''), TypeError);
  assert.throws(() => lookup('NVDA', { mic: 'US' }), TypeError);
  assert.throws(() => lookup('NVDA', { provider: 'Yahoo!' }), TypeError);
  assert.throws(() => lookup('NVDA', { unknown: true }), TypeError);
  assert.throws(() => lookup('MISSING'), UnknownSymbolError);
});

test('reports ambiguity with stable candidate details', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tickerdata-node-'));
  try {
    await cp(join(__dirname, '..', 'reader.cjs'), join(directory, 'reader.cjs'));
    await mkdir(join(directory, 'data'));
    const envelope = { schema_version: '4.0.0', data_version: 'a'.repeat(64) };
    const instruments = [
      { id: 'ins-first', symbol: { mic: 'XNAS' }, listing_status: 'active' },
      { id: 'ins-second', symbol: { mic: 'XNYS' }, listing_status: 'active' },
    ];
    const entries = instruments.map((record) => ({
      symbol: 'SAME',
      mic: record.symbol.mic,
      provider: null,
      instrument_id: record.id,
      kind: 'canonical',
    }));
    await writeFile(join(directory, 'data', 'manifest.json'), JSON.stringify(envelope));
    await writeFile(join(directory, 'data', 'instruments.json'), JSON.stringify({ ...envelope, instruments }));
    await writeFile(join(directory, 'data', 'symbol-index.json'), JSON.stringify({ ...envelope, entries }));
    const fixture = require(join(directory, 'reader.cjs'));
    assert.throws(
      () => fixture.lookup('SAME'),
      (error) => error instanceof fixture.AmbiguousSymbolError &&
        error.candidates.map((item) => item.instrumentId).join(',') === 'ins-first,ins-second',
    );
    assert.equal(fixture.lookup('SAME', { mic: 'XNAS' }).id, 'ins-first');
    assert.ok(AmbiguousSymbolError);
  } finally {
    await rm(directory, { recursive: true });
  }
});
