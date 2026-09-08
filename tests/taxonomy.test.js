import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const vocabulary = await json('../data/vocabulary.json');
const system = vocabulary.industry_systems.find((item) => item.id === 'financedatabase');
const commit = 'ac05d03dbed851a6fd3905a2e92ee036d0397760';

// Label paths from the pinned categories.json, without its subindustry descriptions.
const expectedHierarchy = `
Communication Services|Media & Entertainment|Entertainment;Interactive Media & Services;Media
Communication Services|Telecommunication Services|Diversified Telecommunication Services;Wireless Telecommunication Services
Consumer Discretionary|Automobiles & Components|Auto Components;Automobiles
Consumer Discretionary|Consumer Durables & Apparel|Household Durables;Leisure Products;Textiles, Apparel & Luxury Goods
Consumer Discretionary|Consumer Services|Diversified Consumer Services;Hotels, Restaurants & Leisure
Consumer Discretionary|Retailing|Distributors;Internet & Direct Marketing Retail;Multiline Retail;Specialty Retail
Consumer Staples|Food & Staples Retailing|Food & Staples Retailing
Consumer Staples|Food, Beverage & Tobacco|Beverages;Food Products;Tobacco
Consumer Staples|Household & Personal Products|Household Products;Personal Products
Energy|Energy|Energy Equipment & Services;Oil, Gas & Consumable Fuels
Financials|Banks|Banks;Thrifts & Mortgage Finance
Financials|Diversified Financials|Capital Markets;Consumer Finance;Diversified Financial Services;Mortgage Real Estate Investment Trusts (REITs)
Financials|Insurance|Insurance
Health Care|Health Care Equipment & Services|Health Care Equipment & Supplies;Health Care Providers & Services;Health Care Technology
Health Care|Pharmaceuticals, Biotechnology & Life Sciences|Biotechnology;Life Sciences Tools & Services;Pharmaceuticals
Industrials|Capital Goods|Aerospace & Defense;Building Products;Construction & Engineering;Electrical Equipment;Industrial Conglomerates;Machinery;Trading Companies & Distributors
Industrials|Commercial & Professional Services|Commercial Services & Supplies;Professional Services
Industrials|Transportation|Air Freight & Logistics;Airlines;Marine;Road & Rail;Transportation Infrastructure
Information Technology|Semiconductors & Semiconductor Equipment|Semiconductors & Semiconductor Equipment
Information Technology|Software & Services|IT Services;Software
Information Technology|Technology Hardware & Equipment|Communications Equipment;Electronic Equipment, Instruments & Components;Technology Hardware, Storage & Peripherals
Materials|Materials|Chemicals;Construction Materials;Containers & Packaging;Metals & Mining;Paper & Forest Products
Real Estate|Real Estate|Equity Real Estate Investment Trusts (REITs);Real Estate Management & Development
Utilities|Utilities|Electric Utilities;Gas Utilities;Independent Power and Renewable Electricity Producers;Multi-Utilities;Water Utilities
`.trim().split('\n').map((line) => line.split('|'));

test('FinanceDatabase matches all 11/24/69 pinned English labels and parent paths', () => {
  assert.equal(vocabulary.schema_version, '2.0.0');
  assert.equal(system.sectors.length, 11);
  assert.equal(system.industry_groups.length, 24);
  assert.equal(system.industries.length, 69);
  assert.ok(system.description.includes(commit));
  assert.ok(system.description.includes('2026-09-08T01:03:47Z'));
  const name = (labels, id) => {
    const label = labels.find((item) => item.id === id);
    assert.ok(label, `Unknown parent ${id}`);
    assert.equal(label.aliases.length, 1);
    assert.ok(label.name_zh.trim());
    assert.ok(label.description.trim());
    return label.aliases[0];
  };
  const expectedSectors = [...new Set(expectedHierarchy.map(([sector]) => sector))].sort();
  const expectedGroups = expectedHierarchy.map(([sector, group]) => `${sector}|${group}`).sort();
  const expectedIndustries = expectedHierarchy.flatMap(([sector, group, industries]) =>
    industries.split(';').map((industry) => `${sector}|${group}|${industry}`)).sort();
  assert.deepEqual(system.sectors.map((item) => name(system.sectors, item.id)).sort(), expectedSectors);
  assert.deepEqual(system.industry_groups.map((group) =>
    `${name(system.sectors, group.sector_id)}|${name(system.industry_groups, group.id)}`).sort(), expectedGroups);
  assert.deepEqual(system.industries.map((industry) => {
    const group = system.industry_groups.find((item) => item.id === industry.industry_group_id);
    assert.equal(group?.sector_id, industry.sector_id);
    return `${name(system.sectors, industry.sector_id)}|${name(system.industry_groups, industry.industry_group_id)}|${name(system.industries, industry.id)}`;
  }).sort(), expectedIndustries);
  for (const labels of [system.sectors, system.industry_groups, system.industries]) {
    assert.equal(new Set(labels.map((item) => item.id)).size, labels.length);
  }
});

test('legacy Yahoo labels keep their original IDs and do not invent industry groups', () => {
  const yahoo = vocabulary.industry_systems.find((item) => item.id === 'yahoo');
  assert.deepEqual(yahoo.industry_groups, []);
  assert.deepEqual(yahoo.sectors.map((item) => [item.id, ...item.aliases]), [['technology', 'Technology']]);
  assert.deepEqual(yahoo.industries.map((item) => [item.id, item.sector_id, item.industry_group_id, ...item.aliases]), [
    ['semiconductors', 'technology', null, 'Semiconductors'],
    ['software-infrastructure', 'technology', null, 'Software - Infrastructure'],
  ]);
});

test('ten stock source paths match the pinned provider, without promoting review or replacing themes', async () => {
  const chip = ['information-technology', 'semiconductors-semiconductor-equipment', 'semiconductors-semiconductor-equipment'];
  const software = ['information-technology', 'software-services', 'software'];
  const telecom = ['communication-services', 'telecommunication-services', 'diversified-telecommunication-services'];
  const expected = [
    ['NVDA', chip, 'NMS', 'semiconductor-ai'],
    ['CRWV', software, 'NMS', 'ai-cloud'],
    ['MSTR', software, 'NMS', 'bitcoin-treasury'],
    ['TSLA', ['consumer-discretionary', 'automobiles-components', 'automobiles'], 'NMS', null],
    ['GOOG', telecom, 'NMS', null],
    ['GOOGL', telecom, 'NMS', null],
    ['ARM', chip, 'NMS', null],
    ['BABA', ['consumer-discretionary', 'retailing', 'internet-direct-marketing-retail'], 'NYQ', null],
    ['TSM', chip, 'NYQ', 'semiconductor-foundry'],
    ['BRK.B', ['financials', 'insurance', 'insurance'], 'NYQ', null],
  ];
  for (const [index, [symbol, path, exchange, theme]] of expected.entries()) {
    const record = await json(`../data/instruments/ins-${String(index + 1).padStart(6, '0')}.json`);
    assert.equal(record.schema_version, '2.0.0');
    assert.equal(record.symbol.canonical, symbol);
    assert.equal(record.security_type, 'stock');
    assert.equal(record.industry.system_id, 'financedatabase');
    assert.deepEqual([record.industry.sector_id, record.industry.industry_group_id, record.industry.industry_id], path);
    assert.deepEqual(record.review, { reviewed_at: null, reviewer: null, status: 'pending' });
    assert.equal(record.classification.primary_theme_id, theme);
    assert.deepEqual(record.classification.source_ids, theme ? ['manual-example'] : []);
    if (theme) assert.equal(record.sources.find((source) => source.id === 'manual-example').kind, 'manual');
    assert.deepEqual(record.industry.source_ids, ['financedatabase-equities']);
    const source = record.sources.find((item) => item.id === 'financedatabase-equities');
    assert.equal(source.kind, 'provider');
    assert.equal(source.url, `https://github.com/JerBouma/FinanceDatabase/blob/${commit}/database/equities/${exchange}.csv`);
    assert.equal(source.accessed_at, '2026-09-08T01:03:47Z');
    assert.deepEqual(source.fields, ['/industry']);
    assert.ok(source.label.includes(symbol === 'BRK.B' ? 'BRK-B' : symbol));
    for (const [labels, id] of [[system.sectors, path[0]], [system.industry_groups, path[1]], [system.industries, path[2]]]) {
      assert.ok(source.label.includes(labels.find((item) => item.id === id).aliases[0]));
    }
    if (symbol === 'GOOG' || symbol === 'GOOGL') {
      assert.match(record.notes, /\u884c\u4e1a\u7591\u70b9/);
      assert.ok(record.notes.includes('Diversified Telecommunication Services'));
    }
    if (symbol === 'BRK.B') assert.deepEqual(record.symbol.aliases, [{ provider: 'yahoo', symbol: 'BRK-B' }]);
    assert.equal(record.name.en, null);
    assert.equal(record.symbol.mic, null);
    assert.equal(record.listing_status, 'unknown');
  }
});

test('the seven ETFs keep empty company hierarchy and their independent themes', async () => {
  const themes = ['us-large-cap', 'nasdaq-100', 'semiconductor-sector', 'china-internet', 'gold', 'us-long-treasury', 'bitcoin'];
  for (const [index, theme] of themes.entries()) {
    const record = await json(`../data/instruments/ins-${String(index + 11).padStart(6, '0')}.json`);
    assert.equal(record.schema_version, '2.0.0');
    assert.equal(record.security_type, 'etf');
    assert.deepEqual(record.industry, { system_id: null, sector_id: null, industry_group_id: null, industry_id: null, source_ids: [] });
    assert.equal(record.classification.primary_theme_id, theme);
    assert.deepEqual(record.review, { reviewed_at: null, reviewer: null, status: 'pending' });
    assert.ok(record.etf);
  }
  const files = await readdir(new URL('../data/instruments/', import.meta.url));
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 17);
});
