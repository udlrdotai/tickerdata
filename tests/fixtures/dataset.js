import { createVocabularyFixture } from './vocabulary.js';

const semiconductor = 'semiconductors-semiconductor-equipment';
const telecommunications = 'diversified-telecommunication-services';
const stocks = [
  ['NVDA', semiconductor, 'semiconductor-ai', ['ai']],
  ['CRWV', 'software', 'ai-cloud', ['ai']],
  ['MSTR', 'software', 'bitcoin-treasury', ['digital-assets']],
  ['TSLA', 'automobiles'],
  ['GOOG', telecommunications],
  ['GOOGL', telecommunications],
  ['ARM', semiconductor],
  ['BABA', 'internet-direct-marketing-retail'],
  ['TSM', semiconductor, 'semiconductor-foundry'],
  ['BRK.B', 'insurance'],
];
const funds = [
  ['SPY', 'us-large-cap'],
  ['QQQ', 'nasdaq-100'],
  ['SOXL', 'semiconductor-sector', ['leveraged']],
  ['KWEB', 'china-internet'],
  ['GLD', 'gold'],
  ['TLT', 'us-long-treasury'],
  ['IBIT', 'bitcoin', ['digital-assets']],
];

function evidence(id, fields) {
  return { id, kind: 'manual', label: `Synthetic test-only evidence: ${id}.`, url: null, accessed_at: null, fields };
}

function record(index, symbol, theme = null, tags = []) {
  return {
    schema_version: '2.0.0',
    id: `ins-${String(index + 1).padStart(6, '0')}`,
    symbol: { original: symbol, canonical: symbol, mic: null, aliases: [], history: [] },
    name: { en: `Synthetic test-only ${symbol}`, zh: `仅供测试 ${symbol}` },
    issuer: { id: null, country: null },
    security_type: 'stock',
    listing_status: 'unknown',
    industry: { system_id: null, sector_id: null, industry_group_id: null, industry_id: null, source_ids: [] },
    classification: { primary_theme_id: theme, tag_ids: [...tags], source_ids: theme ? ['manual-example'] : [] },
    etf: null,
    related_instrument_ids: [],
    sources: theme ? [evidence('manual-example', ['/classification'])] : [],
    review: { status: 'pending', reviewer: null, reviewed_at: null },
    notes: 'Synthetic test-only record; not security research or publication data.',
  };
}

// Every call owns every nested object/array; no repository data or provider is read.
export function createDatasetFixture() {
  const vocabulary = createVocabularyFixture();
  const system = vocabulary.industry_systems.find((item) => item.id === 'financedatabase');
  const instruments = stocks.map(([symbol, industryId, theme, tags], index) => {
    const item = record(index, symbol, theme, tags);
    const industry = system.industries.find((entry) => entry.id === industryId);
    item.industry = {
      system_id: system.id,
      sector_id: industry.sector_id,
      industry_group_id: industry.industry_group_id,
      industry_id: industry.id,
      source_ids: ['financedatabase-equities'],
    };
    item.sources.unshift(evidence('financedatabase-equities', ['/industry']));
    if (symbol === 'GOOG' || symbol === 'GOOGL') item.issuer.id = 'issuer-000001';
    if (symbol === 'BRK.B') {
      item.symbol.original = 'BRK-B';
      item.symbol.aliases.push({ provider: 'yahoo', symbol: 'BRK-B' });
    }
    return item;
  });
  instruments.push(...funds.map(([symbol, theme, tags], index) => {
    const item = record(stocks.length + index, symbol, theme, tags);
    item.security_type = 'etf';
    item.sources[0].fields.push('/etf');
    item.etf = {
      asset_class: null,
      description: null,
      direction: symbol === 'SOXL' ? 'long' : null,
      exposure: [],
      fund_category: null,
      leverage_factor: symbol === 'SOXL' ? 3 : null,
      objective: `Synthetic test-only ${symbol} objective.`,
      reset_period: symbol === 'SOXL' ? 'daily' : null,
      source_ids: ['manual-example'],
    };
    return item;
  }));
  return { schema_version: '2.0.0', vocabulary, instruments };
}
