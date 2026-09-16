'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MIC = /^[A-Z0-9]{4}$/;

function readJson(name) {
  return JSON.parse(readFileSync(join(__dirname, 'data', name), 'utf8'));
}

const manifest = readJson('manifest.json');
const instrumentsPayload = readJson('instruments.json');
const indexPayload = readJson('symbol-index.json');

if (manifest.schema_version !== '4.0.0' ||
    instrumentsPayload.schema_version !== manifest.schema_version ||
    indexPayload.schema_version !== manifest.schema_version ||
    instrumentsPayload.data_version !== manifest.data_version ||
    indexPayload.data_version !== manifest.data_version) {
  throw new Error('The embedded tickerdata snapshot has inconsistent versions');
}

const records = new Map(instrumentsPayload.instruments.map((record) => [record.id, record]));
const entriesBySymbol = new Map();
for (const entry of indexPayload.entries) {
  const entries = entriesBySymbol.get(entry.symbol) ?? [];
  entries.push(entry);
  entriesBySymbol.set(entry.symbol, entries);
}

class UnknownSymbolError extends Error {
  constructor(symbol, options) {
    super(`Unknown symbol ${JSON.stringify(symbol)} (MIC=${JSON.stringify(options.mic)}, provider=${JSON.stringify(options.provider)}, activeOnly=${!options.includeInactive})`);
    this.name = 'UnknownSymbolError';
    this.symbol = symbol;
  }
}

class AmbiguousSymbolError extends Error {
  constructor(symbol, candidates) {
    super(`Ambiguous symbol ${JSON.stringify(symbol)}: ${candidates.map((candidate) => `${candidate.instrumentId} (${candidate.mic ?? 'no MIC'})`).join(', ')}`);
    this.name = 'AmbiguousSymbolError';
    this.symbol = symbol;
    this.candidates = candidates;
  }
}

function normalizedOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const allowed = new Set(['mic', 'provider', 'includeInactive']);
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new TypeError(`Unexpected option: ${unexpected[0]}`);
  let mic = options.mic ?? null;
  if (mic !== null) {
    if (typeof mic !== 'string') throw new TypeError('mic must be a string or null');
    mic = mic.trim().toUpperCase();
    if (!MIC.test(mic)) throw new TypeError('mic must be a four-character MIC');
  }
  let provider = options.provider ?? null;
  if (provider !== null) {
    if (typeof provider !== 'string') throw new TypeError('provider must be a string or null');
    provider = provider.trim().toLowerCase();
    if (provider.length > 100 || !IDENTIFIER.test(provider)) {
      throw new TypeError('provider must be a lowercase identifier');
    }
  }
  const includeInactive = options.includeInactive ?? true;
  if (typeof includeInactive !== 'boolean') throw new TypeError('includeInactive must be a boolean');
  return { mic, provider, includeInactive };
}

function lookup(symbol, options = {}) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new TypeError('symbol must be a non-empty string');
  }
  const normalized = symbol.trim().toUpperCase();
  const query = normalizedOptions(options);
  const candidates = new Map();
  for (const entry of entriesBySymbol.get(normalized) ?? []) {
    const record = records.get(entry.instrument_id);
    if (!record) throw new Error(`Snapshot index references missing instrument ${entry.instrument_id}`);
    if (query.mic !== null && entry.mic !== query.mic) continue;
    if (query.provider !== null && entry.provider !== null && entry.provider !== query.provider) continue;
    if (!query.includeInactive && record.listing_status !== 'active') continue;
    candidates.set(record.id, record);
  }
  if (!candidates.size) throw new UnknownSymbolError(normalized, query);
  if (candidates.size > 1) {
    throw new AmbiguousSymbolError(normalized, [...candidates.values()]
      .map((record) => ({ instrumentId: record.id, mic: record.symbol.mic }))
      .sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)));
  }
  return structuredClone(candidates.values().next().value);
}

module.exports = { lookup, UnknownSymbolError, AmbiguousSymbolError };
