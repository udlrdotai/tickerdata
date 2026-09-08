export const SCHEMA_VERSION = '3.0.0';

export function normalizeSymbol(value) {
  return value.trim().toUpperCase();
}

export function emptyInstrument(id = '') {
  return {
    schema_version: SCHEMA_VERSION,
    id,
    symbol: { original: '', canonical: '', mic: null, aliases: [], history: [] },
    name: { en: null, zh: null },
    security_type: 'stock',
    issuer: { id: null, country: null },
    listing_status: 'unknown',
    industry: { system_id: null, sector_id: null, industry_group_id: null, industry_id: null, source_ids: [] },
    classification: { tag_ids: [], source_ids: [] },
    etf: null,
    related_instrument_ids: [],
    notes: '',
    sources: [],
    review: { status: 'pending', reviewed_at: null, reviewer: null },
  };
}

export function emptyEtf() {
  return {
    objective: null,
    asset_class: null,
    exposure: [],
    leverage_factor: null,
    direction: null,
    reset_period: null,
    fund_category: null,
    description: null,
    source_ids: [],
  };
}

export function stableStringify(value) {
  const sorted = (item) => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sorted(item[key])]));
    }
    return item;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}
