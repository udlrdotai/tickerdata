import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDatasetFixture } from './fixtures/dataset.js';
import { createRelease, sha256 } from '../src/release.js';
import { emptyInstrument, emptyEtf, SCHEMA_VERSION, stableStringify } from '../src/model.js';
import { validateDataset } from '../src/validation.js';

test('Python consumes actual Node publisher bytes for stocks, ETFs, aliases and empty releases', async () => {
  const source = createDatasetFixture();
  const folder = await mkdtemp(resolve('.interop-test-'));
  try {
    const empty = createRelease(source);
    assert.deepEqual(Object.keys(empty.manifest.files).sort(), ['instruments.json', 'symbol-index.json', 'vocabulary.json']);
    assert.equal(Object.hasOwn(empty.files, 'themes.json'), false);
    for (const [name, bytes] of Object.entries(empty.files)) await writeFile(resolve(folder, name), bytes);
    execFileSync('python3', ['-c', 'import sys; from examples.consumer import load_snapshot; s=load_snapshot(sys.argv[1]); assert len(s._records)==0', folder]);

    // These synthetic labels/MICs test serialization, not the real securities' identities.
    const fixture = structuredClone(source);
    for (const record of fixture.instruments) {
      record.name.en = 'Synthetic interop fixture';
      record.symbol.mic = 'XNAS';
      record.review = { status: 'reviewed', reviewer: 'Test fixture only', reviewed_at: '2026-09-01T00:00:00Z' };
      if (record.classification.tag_ids.length && !record.classification.source_ids.length) {
        record.classification.source_ids = ['synthetic'];
        record.sources.push({ id: 'synthetic', kind: 'manual', label: 'Synthetic test rationale only', url: null, accessed_at: null, fields: ['/classification'] });
      }
    }
    fixture.instruments[0].classification.tag_ids = ['ai-cloud', 'semiconductor-ai'];
    fixture.instruments[0].classification.source_ids = ['synthetic-tags'];
    fixture.instruments[0].sources.push({
      id: 'synthetic-tags', kind: 'manual', label: 'Synthetic overlapping tags only',
      url: null, accessed_at: null, fields: ['/classification'],
    });
    fixture.instruments[1].classification = { tag_ids: [], source_ids: [] };
    const release = createRelease(fixture);
    for (const [name, bytes] of Object.entries(release.files)) await writeFile(resolve(folder, name), bytes);
    const output = execFileSync('python3', ['-c', [
      'import json, sys',
      'from examples.consumer import load_snapshot, UnknownSymbol',
      's=load_snapshot(sys.argv[1], sys.argv[2])',
      'assert len(s._records)==17',
      'assert s.lookup("GOOG")["instrument"]["id"] != s.lookup("GOOGL")["instrument"]["id"]',
      'assert s.lookup("SOXL")["instrument"]["etf"]["leverage_factor"]==3',
      'assert s.lookup("CRWV")["tags"]==[]',
      'r=s.lookup("NVDA")',
      'assert set(r)=={"instrument", "tags"}',
      'assert "primary_theme_id" not in r["instrument"]["classification"]',
      'assert [tag["id"] for tag in r["tags"]]==["ai-cloud", "semiconductor-ai"]',
      'r["tags"][0]["name_zh"]="MUTATED"',
      'assert s.lookup("NVDA")["tags"][0]["name_zh"]!="MUTATED"',
      'try: s.lookup("BRK-B", provider="other")',
      'except UnknownSymbol: pass',
      'else: raise AssertionError("Provider alias lost its scope")',
      'print(json.dumps(s.lookup("BRK-B", provider="yahoo")))',
    ].join('\n'), folder, release.version], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).instrument.symbol.canonical, 'BRK.B');
    fixture.instruments[1].review.status = 'pending';
    fixture.instruments[2].review.status = 'needs_review';
    const mixed = createRelease(fixture);
    for (const [name, bytes] of Object.entries(mixed.files)) await writeFile(resolve(folder, name), bytes);
    execFileSync('python3', ['-c', [
      'import sys',
      'from examples.consumer import load_snapshot, UnknownSymbol',
      's=load_snapshot(sys.argv[1], sys.argv[2])',
      'assert len(s._records)==15',
      'assert s.lookup("NVDA")["instrument"]["review"]["status"]=="reviewed"',
      'for symbol in ["CRWV", "MSTR"]:',
      '    try: s.lookup(symbol)',
      '    except UnknownSymbol: pass',
      '    else: raise AssertionError("Unreviewed record was published")',
    ].join('\n'), folder, mixed.version]);
  } finally {
    await rm(folder, { recursive: true });
  }
});

test('JS and Python agree on strict three-level hierarchy and protocol edge cases', () => {
  const label = (id) => ({ id, name_zh: id, aliases: [], description: '' });
  const item = emptyInstrument('ins-interop');
  Object.assign(item.symbol, { original: 'TEST', canonical: 'TEST', mic: 'XNAS' });
  item.name.en = 'Synthetic protocol fixture';
  item.review = { status: 'reviewed', reviewer: 'Test only', reviewed_at: '2026-09-01T00:00:00Z' };
  item.classification = { tag_ids: ['cloud', 'ai'], source_ids: ['human'] };
  item.industry = { system_id: 'financedatabase', sector_id: 'first-sector', industry_group_id: 'first-group', industry_id: 'first-industry', source_ids: ['human'] };
  item.sources = [{ id: 'human', kind: 'manual', label: 'Synthetic only', fields: ['/classification', '/industry'], url: null, accessed_at: null }];
  const original = {
    schema_version: SCHEMA_VERSION, instruments: [item],
    vocabulary: {
      schema_version: SCHEMA_VERSION, tags: [label('cloud'), label('ai')],
      industry_systems: [{
        ...label('financedatabase'),
        sectors: [label('first-sector'), label('second-sector')],
        industry_groups: [
          { ...label('first-group'), sector_id: 'first-sector' },
          { ...label('second-group'), sector_id: 'second-sector' },
        ],
        industries: [{ ...label('first-industry'), sector_id: 'first-sector', industry_group_id: 'first-group' }],
      }],
    },
  };
  const mutations = [
    ['complete hierarchy', true, () => {}],
    ['reviewed without tags', true, (data) => { data.instruments[0].classification = { tag_ids: [], source_ids: [] }; }],
    ['empty tags with valid source', true, (data) => { data.instruments[0].classification.tag_ids = []; }],
    ['unknown tag', false, (data) => { data.instruments[0].classification.tag_ids = ['missing']; }],
    ['duplicate tag', false, (data) => { data.instruments[0].classification.tag_ids = ['ai', 'ai']; }],
    ['tags without source', false, (data) => { data.instruments[0].classification.source_ids = []; }],
    ['unknown classification source', false, (data) => { data.instruments[0].classification.source_ids = ['missing']; }],
    ['missing classification coverage', false, (data) => { data.instruments[0].sources[0].fields = ['/industry']; }],
    ['empty tags still validate source', false, (data) => { data.instruments[0].classification = { tag_ids: [], source_ids: ['missing'] }; }],
    ['legacy primary theme forbidden', false, (data) => { data.instruments[0].classification.primary_theme_id = 'cloud'; }],
    ['legacy themes vocabulary forbidden', false, (data) => { data.vocabulary.themes = []; }],
    ['duplicate vocabulary tag', false, (data) => { data.vocabulary.tags.push(structuredClone(data.vocabulary.tags[0])); }],
    ['omitted ancestors', true, (data) => { data.instruments[0].industry.sector_id = null; data.instruments[0].industry.industry_group_id = null; }],
    ['group only', true, (data) => { data.instruments[0].industry.sector_id = null; data.instruments[0].industry.industry_id = null; }],
    ['missing record group field', false, (data) => { delete data.instruments[0].industry.industry_group_id; }],
    ['missing vocabulary groups', false, (data) => { delete data.vocabulary.industry_systems[0].industry_groups; }],
    ['missing industry parent field', false, (data) => { delete data.vocabulary.industry_systems[0].industries[0].industry_group_id; }],
    ['unknown record group', false, (data) => { data.instruments[0].industry.industry_group_id = 'missing'; }],
    ['group and sector mismatch', false, (data) => { data.instruments[0].industry.industry_id = null; data.instruments[0].industry.sector_id = 'second-sector'; }],
    ['industry and group mismatch', false, (data) => { data.instruments[0].industry.sector_id = null; data.instruments[0].industry.industry_group_id = 'second-group'; }],
    ['industry and sector mismatch', false, (data) => { data.instruments[0].industry.industry_group_id = null; data.instruments[0].industry.sector_id = 'second-sector'; }],
    ['group without system', false, (data) => { data.instruments[0].industry.system_id = null; }],
    ['group without source', false, (data) => { data.instruments[0].industry.industry_id = null; data.instruments[0].industry.sector_id = null; data.instruments[0].industry.source_ids = []; }],
    ['source coverage', false, (data) => { data.instruments[0].sources[0].fields = ['/classification']; }],
    ['group extra field', false, (data) => { data.vocabulary.industry_systems[0].industry_groups[0].extra = true; }],
    ['duplicate group', false, (data) => { data.vocabulary.industry_systems[0].industry_groups.push(structuredClone(data.vocabulary.industry_systems[0].industry_groups[0])); }],
    ['null group sector', false, (data) => { data.vocabulary.industry_systems[0].industry_groups[0].sector_id = null; }],
    ['unknown group sector', false, (data) => { data.vocabulary.industry_systems[0].industry_groups[0].sector_id = 'missing'; }],
    ['unknown industry group', false, (data) => { data.vocabulary.industry_systems[0].industries[0].industry_group_id = 'missing'; }],
    ['inconsistent vocabulary parents', false, (data) => { data.vocabulary.industry_systems[0].industries[0].industry_group_id = 'second-group'; }],
    ['FinanceDatabase missing group parent', false, (data) => { data.vocabulary.industry_systems[0].industries[0].industry_group_id = null; }],
    ['FinanceDatabase missing sector parent', false, (data) => { data.vocabulary.industry_systems[0].industries[0].sector_id = null; }],
    ['ETF group forbidden', false, (data) => { data.instruments[0].security_type = 'etf'; data.instruments[0].etf = emptyEtf(); }],
    ['legacy record rejected', false, (data) => { data.instruments[0].schema_version = '1.0.0'; delete data.instruments[0].industry.industry_group_id; }],
    ['schema two record rejected', false, (data) => { data.instruments[0].schema_version = '2.0.0'; }],
    ['legacy Yahoo without groups', true, (data) => {
      const system = data.vocabulary.industry_systems[0];
      system.id = 'yahoo';
      system.industry_groups = [];
      system.industries[0].industry_group_id = null;
      data.instruments[0].industry.system_id = 'yahoo';
      data.instruments[0].industry.industry_group_id = null;
    }],
    ...[false, true].map((consistent) => [
      `selected group and industry's inferred sectors ${consistent ? 'agree' : 'conflict'}`,
      consistent,
      (data) => {
        const system = data.vocabulary.industry_systems[0];
        system.id = 'custom-system';
        system.industries[0].industry_group_id = null;
        data.instruments[0].industry.system_id = system.id;
        data.instruments[0].industry.sector_id = null;
        data.instruments[0].industry.industry_group_id = consistent ? 'first-group' : 'second-group';
      },
    ]),
  ];
  const release = createRelease(original);
  const cases = mutations.map(([name, valid, mutate]) => {
    const data = structuredClone(original);
    mutate(data);
    assert.equal(validateDataset(data).length === 0, valid, `JS: ${name}`);
    const files = { ...release.files };
    const envelope = { schema_version: SCHEMA_VERSION, data_version: release.version };
    files['instruments.json'] = stableStringify({ ...envelope, instruments: data.instruments });
    const { schema_version, ...vocabulary } = data.vocabulary;
    files['vocabulary.json'] = stableStringify({ ...envelope, ...vocabulary });
    const manifest = structuredClone(release.manifest);
    for (const filename of Object.keys(manifest.files)) {
      manifest.files[filename] = { sha256: sha256(files[filename]), bytes: Buffer.byteLength(files[filename]) };
    }
    files['manifest.json'] = stableStringify(manifest);
    return { name, valid, files };
  });
  execFileSync('python3', ['-c', [
    'import json,sys',
    'from examples.consumer import Snapshot, SnapshotError',
    'for case in json.load(sys.stdin):',
    '    try:',
    '        Snapshot({name: raw.encode("utf-8") for name,raw in case["files"].items()})',
    '        valid = True',
    '    except SnapshotError:',
    '        valid = False',
    '    assert valid == case["valid"], case["name"]',
  ].join('\n')], { input: JSON.stringify(cases) });
});
