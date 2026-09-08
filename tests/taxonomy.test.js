import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatasetFixture } from './fixtures/dataset.js';
import { validateDataset } from '../src/validation.js';
import { createRelease } from '../src/release.js';
import { prepareRecord } from '../web/editor-model.js';

const vocabulary = createDatasetFixture().vocabulary;
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

test('the independent FinanceDatabase fixture matches all 11/24/69 pinned label paths', () => {
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

function reviewFixture(record) {
  const edited = structuredClone(record);
  edited.name.en = `Synthetic reviewed ${record.symbol.canonical}`;
  edited.symbol.mic = 'XNAS';
  edited.review.reviewer = 'Synthetic reviewer';
  if (!edited.classification.primary_theme_id) {
    edited.classification.primary_theme_id = 'ai-cloud';
    edited.classification.source_ids = ['synthetic-review'];
    edited.sources.push({
      id: 'synthetic-review', kind: 'manual', label: 'Synthetic review rationale only',
      url: null, accessed_at: null, fields: ['/classification'],
    });
  }
  return prepareRecord(record, edited, true);
}

test('stock review publishes the selected fixture without replacing its industry or existing evidence', () => {
  const fixture = createDatasetFixture();
  const before = structuredClone(fixture);
  for (const record of fixture.instruments.filter((item) => item.security_type === 'stock')) {
    const reviewed = reviewFixture(record);
    assert.equal(record.industry.system_id, 'financedatabase');
    assert.equal(reviewed.review.status, 'reviewed');
    assert.deepEqual(reviewed.industry, record.industry);
    assert.deepEqual(reviewed.symbol.aliases, record.symbol.aliases);
    assert.deepEqual(reviewed.classification.tag_ids, record.classification.tag_ids);
    if (record.classification.primary_theme_id) {
      assert.deepEqual(reviewed.classification, record.classification);
    }
    for (const source of record.sources) {
      assert.deepEqual(reviewed.sources.find((item) => item.id === source.id), source);
    }
    const candidate = { ...fixture, instruments: fixture.instruments.map((item) => item.id === record.id ? reviewed : item) };
    assert.deepEqual(validateDataset(candidate), []);
    assert.deepEqual(JSON.parse(createRelease(candidate).files['instruments.json']).instruments, [reviewed]);
  }
  assert.deepEqual(fixture, before);
});

test('ETF review preserves independent attributes and still rejects company industry assignments', () => {
  const fixture = createDatasetFixture();
  for (const record of fixture.instruments.filter((item) => item.security_type === 'etf')) {
    const reviewed = reviewFixture(record);
    assert.deepEqual(reviewed.industry, { system_id: null, sector_id: null, industry_group_id: null, industry_id: null, source_ids: [] });
    assert.deepEqual(reviewed.classification, record.classification);
    assert.deepEqual(reviewed.etf, record.etf);
    const candidate = { ...fixture, instruments: [reviewed] };
    assert.deepEqual(validateDataset(candidate), []);
    assert.deepEqual(JSON.parse(createRelease(candidate).files['instruments.json']).instruments, [reviewed]);
    reviewed.industry.system_id = 'financedatabase';
    assert.match(validateDataset(candidate).join('\n'), /ETF cannot use company/);
  }
});
