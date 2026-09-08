import validators from '../web/generated/validators.cjs';
import { normalizeSymbol, SCHEMA_VERSION, stableStringify } from './model.js';

function schemaErrors(validator, value, prefix) {
  if (validator(value)) return [];
  return validator.errors.map((error) => `${prefix}${error.instancePath || '/'}: ${error.message}`);
}

function uniqueLabels(labels, scope, errors) {
  const ids = new Set();
  const names = new Map();
  for (const label of labels) {
    if (ids.has(label.id)) errors.push(`${scope}: duplicate ID ${label.id}`);
    ids.add(label.id);
    for (const name of [label.name_zh, ...label.aliases]) {
      const normalized = name.trim().toLocaleLowerCase('en-US');
      if (!normalized) errors.push(`${scope}/${label.id}: empty display name or alias`);
      if (names.has(normalized)) errors.push(`${scope}: duplicate name/alias "${name}" (${names.get(normalized)}, ${label.id})`);
      names.set(normalized, label.id);
    }
  }
  return ids;
}

export function symbolEntries(record) {
  const originalIsScopedAlias = record.symbol.aliases.some((alias) => normalizeSymbol(alias.symbol) === normalizeSymbol(record.symbol.original)) &&
    normalizeSymbol(record.symbol.original) !== normalizeSymbol(record.symbol.canonical);
  return [
    { symbol: record.symbol.canonical, mic: record.symbol.mic, provider: null, kind: 'canonical' },
    ...(!originalIsScopedAlias ? [{ symbol: record.symbol.original, mic: record.symbol.mic, provider: null, kind: 'original' }] : []),
    ...record.symbol.aliases.map((alias) => ({ ...alias, mic: record.symbol.mic, kind: 'alias' })),
    ...record.symbol.history.map((item) => ({ symbol: item.symbol, mic: item.mic, provider: null, kind: 'historical' })),
  ].map((item) => ({ ...item, symbol: normalizeSymbol(item.symbol), instrument_id: record.id }));
}

function versionedDatasetShape(dataset, version) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset) ||
      dataset.schema_version !== version || !Array.isArray(dataset.instruments) ||
      Object.keys(dataset).some((key) => !['schema_version', 'instruments', 'vocabulary'].includes(key))) {
    return [`dataset: expected supported schema_version ${version}, instruments array and vocabulary`];
  }
  const schema = version === '1.0.0' ? { vocabulary: validators.vocabularyV1, instrument: validators.instrumentV1 } : validators;
  const errors = schemaErrors(schema.vocabulary, dataset.vocabulary, 'vocabulary');
  dataset.instruments.forEach((record, index) => {
    errors.push(...schemaErrors(schema.instrument, record, `instruments[${index}]`));
  });
  return errors;
}

export function validateDatasetShape(dataset) {
  return versionedDatasetShape(dataset, SCHEMA_VERSION);
}

export function validateDataset(dataset) {
  return validateVersionedDataset(dataset, SCHEMA_VERSION);
}

export function validateLegacyDataset(dataset) {
  return validateVersionedDataset(dataset, '1.0.0');
}

export function validateLegacyShape(payload, kind) {
  if (!['instrument', 'vocabulary'].includes(kind)) return ['Unsupported legacy payload kind'];
  return schemaErrors(validators[`${kind}V1`], payload, kind);
}

function validateVersionedDataset(dataset, version) {
  const errors = versionedDatasetShape(dataset, version);
  // Shape validation must complete before traversing untrusted imports.
  if (errors.length) return errors;

  const vocabulary = dataset.vocabulary;
  const themes = uniqueLabels(vocabulary.themes, 'themes', errors);
  const tags = uniqueLabels(vocabulary.tags, 'tags', errors);
  uniqueLabels(vocabulary.industry_systems, 'industry_systems', errors);
  const systems = new Map();
  for (const system of vocabulary.industry_systems) {
    const sectors = uniqueLabels(system.sectors, `${system.id}/sectors`, errors);
    const groups = version === '1.0.0' ? [] : system.industry_groups;
    const industryGroups = uniqueLabels(groups, `${system.id}/industry_groups`, errors);
    const industries = uniqueLabels(system.industries, `${system.id}/industries`, errors);
    for (const group of groups) {
      if (!sectors.has(group.sector_id)) errors.push(`${system.id}/${group.id}: unknown sector ${group.sector_id}`);
    }
    for (const industry of system.industries) {
      if (industry.sector_id !== null && !sectors.has(industry.sector_id)) {
        errors.push(`${system.id}/${industry.id}: unknown sector ${industry.sector_id}`);
      }
      if (version !== '1.0.0') {
        const group = groups.find((item) => item.id === industry.industry_group_id);
        if (industry.industry_group_id !== null && !industryGroups.has(industry.industry_group_id)) errors.push(`${system.id}/${industry.id}: unknown industry group ${industry.industry_group_id}`);
        if (group && industry.sector_id !== null && group.sector_id !== industry.sector_id) errors.push(`${system.id}/${industry.id}: industry group does not belong to selected sector`);
        if (system.id === 'financedatabase' && (industry.sector_id === null || industry.industry_group_id === null)) errors.push(`${system.id}/${industry.id}: FinanceDatabase industry requires sector and industry group parents`);
      }
    }
    systems.set(system.id, { system, sectors, industries, industryGroups, groups });
  }

  const ids = new Set();
  const identifiers = new Map();
  for (const record of dataset.instruments) {
    const fail = (message) => errors.push(`${record.id}: ${message}`);
    if (ids.has(record.id)) fail('duplicate stable ID');
    ids.add(record.id);
    if (normalizeSymbol(record.symbol.canonical) !== record.symbol.canonical) fail('canonical symbol must be trimmed uppercase; punctuation is preserved');
    if (record.symbol.history.some((item) => item.valid_from && item.valid_to && item.valid_from > item.valid_to)) fail('symbol history start is after end');

    const sourceIds = new Map();
    for (const source of record.sources) {
      if (sourceIds.has(source.id)) fail(`duplicate source ID ${source.id}`);
      sourceIds.set(source.id, source);
      if (!source.label.trim()) fail(`source ${source.id} needs a rationale or label`);
    }
    for (const field of ['industry', 'classification', 'etf']) {
      for (const id of record[field]?.source_ids ?? []) {
        const source = sourceIds.get(id);
        if (!source) fail(`${field}: unknown source ${id}`);
        else if (!source.fields.includes(`/${field}`)) fail(`${field}: source ${id} does not cover this field`);
      }
    }

    const industry = record.industry;
    const system = systems.get(industry.system_id);
    if (industry.system_id !== null && !system) fail(`unknown industry system ${industry.system_id}`);
    if (industry.sector_id !== null && !system?.sectors.has(industry.sector_id)) fail(`unknown sector ${industry.sector_id}`);
    if (version !== '1.0.0' && industry.industry_group_id !== null && !system?.industryGroups.has(industry.industry_group_id)) fail(`unknown industry group ${industry.industry_group_id}`);
    if (industry.industry_id !== null && !system?.industries.has(industry.industry_id)) fail(`unknown industry ${industry.industry_id}`);
    const industryLabel = system?.system.industries.find((item) => item.id === industry.industry_id);
    if (industryLabel?.sector_id && industry.sector_id && industryLabel.sector_id !== industry.sector_id) fail('industry does not belong to selected sector');
    const group = system?.groups.find((item) => item.id === industry.industry_group_id);
    const parentGroup = system?.groups.find((item) => item.id === industryLabel?.industry_group_id);
    if (group && industry.sector_id !== null && group.sector_id !== industry.sector_id) fail('industry group does not belong to selected sector');
    if (group && industryLabel?.sector_id && group.sector_id !== industryLabel.sector_id) fail('selected industry group and industry belong to different sectors');
    if (industryLabel?.industry_group_id && industry.industry_group_id && industryLabel.industry_group_id !== industry.industry_group_id) fail('industry does not belong to selected industry group');
    if (parentGroup && industry.sector_id !== null && parentGroup.sector_id !== industry.sector_id) fail('industry parent group does not belong to selected sector');
    const hierarchy = [industry.system_id, industry.sector_id, industry.industry_id, ...(version === '1.0.0' ? [] : [industry.industry_group_id])];
    if (hierarchy.some((value) => value !== null) && !industry.source_ids.length) fail('standard industry needs its own source');

    if (record.classification.primary_theme_id !== null && !themes.has(record.classification.primary_theme_id)) fail('unknown primary theme');
    for (const id of record.classification.tag_ids) {
      if (!tags.has(id)) fail(`unknown tag ${id}`);
    }
    if ((record.classification.primary_theme_id !== null || record.classification.tag_ids.length) && !record.classification.source_ids.length) fail('classification needs its own source');

    if (record.security_type === 'etf') {
      if (record.etf === null) fail('ETF must have an ETF object (unknown attributes may be null)');
      if (hierarchy.some((value) => value !== null) || industry.source_ids.length) fail('ETF cannot use company sector/industry');
      if (record.etf) {
        const etf = record.etf;
        if (Object.entries(etf).some(([key, value]) => key !== 'source_ids' && value !== null && (!Array.isArray(value) || value.length)) && !etf.source_ids.length) fail('ETF attributes need an ETF source');
        if (etf.leverage_factor !== null && (etf.direction === null || etf.reset_period === null)) fail('leverage factor requires direction and reset period');
        if (etf.leverage_factor > 1 && (etf.direction === 'neutral' || etf.reset_period === 'none')) fail('leveraged ETF requires a directional exposure and reset period');
      }
    } else if (record.etf !== null) fail('non-ETF must not have ETF attributes');

    if (record.review.status === 'reviewed') {
      if (!record.review.reviewed_at || !record.review.reviewer?.trim()) fail('reviewed record needs UTC review time and reviewer');
      if (!record.name.en?.trim() || !record.symbol.mic) fail('reviewed record needs English name and listing MIC');
      if (!record.classification.primary_theme_id || !record.classification.source_ids.length) fail('reviewed record needs a primary theme and rationale source');
    }

    const ownAliases = new Set();
    for (const alias of record.symbol.aliases) {
      const key = `${alias.provider}|${normalizeSymbol(alias.symbol)}`;
      if (ownAliases.has(key)) fail(`duplicate normalized provider alias ${key}`);
      ownAliases.add(key);
    }
    if (record.listing_status !== 'inactive') {
      for (const entry of symbolEntries(record).filter((item) => item.kind !== 'historical')) {
        const key = JSON.stringify([entry.symbol, entry.mic]);
        const prior = identifiers.get(key) ?? [];
        for (const candidate of prior) {
          if (candidate.instrument_id !== record.id &&
              (candidate.provider === null || entry.provider === null || candidate.provider === entry.provider)) {
            fail(`identifier conflict ${key} with ${candidate.instrument_id}; use explicit MIC/provider or archive historical securities`);
          }
        }
        prior.push(entry);
        identifiers.set(key, prior);
      }
    }
  }
  for (const record of dataset.instruments) {
    for (const id of record.related_instrument_ids) {
      if (id === record.id || !ids.has(id)) errors.push(`${record.id}: invalid related instrument ${id}`);
      else if (record.review.status === 'reviewed' && !dataset.instruments.some((item) => item.id === id && item.review.status === 'reviewed')) errors.push(`${record.id}: reviewed related instrument ${id} must also be reviewed before publication`);
    }
  }
  return errors;
}

export function validateReviewTransitions(previous, next) {
  const errors = [];
  const nextById = new Map(next.instruments.map((record) => [record.id, record]));
  for (const before of previous.instruments) {
    const after = nextById.get(before.id);
    if (!after) {
      errors.push(`${before.id}: do not delete historical securities or replace stable IDs; mark inactive`);
      continue;
    }
    const content = (record) => {
      const { review, ...rest } = record;
      return stableStringify(rest);
    };
    if (before.review.status === 'reviewed' && after.review.status === 'reviewed' &&
        content(before) !== content(after) &&
        (!after.review.reviewed_at || Date.parse(after.review.reviewed_at) <= Date.parse(before.review.reviewed_at))) {
      errors.push(`${before.id}: edited reviewed data must become needs_review or receive a newer explicit human review`);
    }
  }
  return errors;
}

export function validateSuggestionShape(suggestion) {
  return schemaErrors(suggestion?.schema_version === '1.0.0' ? validators.suggestionV1 : validators.suggestion, suggestion, 'suggestion');
}

export function validateSuggestion(suggestion, dataset, recordHash) {
  const errors = validateSuggestionShape(suggestion);
  if (errors.length) return errors;
  if (suggestion.schema_version !== dataset.schema_version) errors.push('suggestion: protocol version differs from dataset; preserve historical hashes and regenerate or reassess manually');
  const record = dataset.instruments.find((item) => item.id === suggestion.instrument_id);
  if (!record) errors.push('suggestion: unknown instrument');
  else if (recordHash && suggestion.base_record_sha256 !== recordHash(record)) errors.push('suggestion: stale base record; regenerate or reassess manually');
  const fields = new Set();
  for (const proposal of suggestion.proposed) {
    if (fields.has(proposal.field)) errors.push('suggestion: duplicate proposed field');
    fields.add(proposal.field);
    if (proposal.field === '/classification/primary_theme_id') {
      if (proposal.value !== null && (typeof proposal.value !== 'string' || !dataset.vocabulary.themes.some((theme) => theme.id === proposal.value))) {
        errors.push('suggestion: primary theme must use an existing ID; new themes belong only in new_theme_proposals');
      }
    } else if (!Array.isArray(proposal.value) || proposal.value.some((id) => !dataset.vocabulary.tags.some((tag) => tag.id === id))) {
      errors.push('suggestion: tags must be existing tag IDs');
    }
  }
  const decisions = new Set();
  for (const decision of suggestion.decisions) {
    if (decision.proposal_index >= suggestion.proposed.length || decisions.has(decision.proposal_index)) errors.push('suggestion: invalid or duplicate decision index');
    decisions.add(decision.proposal_index);
  }
  uniqueLabels(suggestion.new_theme_proposals, 'suggestion/new_themes', errors);
  const themeNames = new Set(dataset.vocabulary.themes.flatMap((item) => [item.name_zh, ...item.aliases]).map((name) => name.trim().toLowerCase()));
  for (const theme of suggestion.new_theme_proposals) {
    if (dataset.vocabulary.themes.some((existing) => existing.id === theme.id) ||
        [theme.name_zh, ...theme.aliases].some((name) => themeNames.has(name.trim().toLowerCase()))) errors.push('suggestion: proposed new theme duplicates existing vocabulary');
  }
  return errors;
}
