import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadDataset } from '../scripts/cli.js';
import { createRelease } from '../src/release.js';

test('Python consumes actual Node publisher bytes for stocks, ETFs, aliases and empty releases', async () => {
  const source = await loadDataset();
  const folder = await mkdtemp(resolve(tmpdir(), 'tickerdata-interop-'));
  try {
    const empty = createRelease(source);
    for (const [name, bytes] of Object.entries(empty.files)) await writeFile(resolve(folder, name), bytes);
    execFileSync('python3', ['-c', 'import sys; from examples.consumer import load_snapshot; s=load_snapshot(sys.argv[1]); assert len(s._records)==0', folder]);

    // These synthetic labels/MICs test serialization, not the real securities' identities.
    const fixture = structuredClone(source);
    for (const record of fixture.instruments) {
      record.name.en = 'Synthetic interop fixture';
      record.symbol.mic = 'XNAS';
      record.review = { status: 'reviewed', reviewer: 'Test fixture only', reviewed_at: '2026-09-01T00:00:00Z' };
      if (!record.classification.primary_theme_id) {
        record.classification.primary_theme_id = 'ai-cloud';
        record.classification.source_ids = ['synthetic'];
        record.sources.push({ id: 'synthetic', kind: 'manual', label: 'Synthetic test rationale only', url: null, accessed_at: null, fields: ['/classification'] });
      }
    }
    const release = createRelease(fixture);
    for (const [name, bytes] of Object.entries(release.files)) await writeFile(resolve(folder, name), bytes);
    const output = execFileSync('python3', ['-c', [
      'import json, sys',
      'from examples.consumer import load_snapshot, UnknownSymbol',
      's=load_snapshot(sys.argv[1], sys.argv[2])',
      'assert len(s._records)==17',
      'assert s.lookup("GOOG")["instrument"]["id"] != s.lookup("GOOGL")["instrument"]["id"]',
      'assert s.lookup("SOXL")["instrument"]["etf"]["leverage_factor"]==3',
      'try: s.lookup("BRK-B", provider="other")',
      'except UnknownSymbol: pass',
      'else: raise AssertionError("Provider alias lost its scope")',
      'print(json.dumps(s.lookup("BRK-B", provider="yahoo")))',
    ].join('\n'), folder, release.version], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).instrument.symbol.canonical, 'BRK.B');
  } finally {
    await rm(folder, { recursive: true });
  }
});
