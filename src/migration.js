import { SCHEMA_VERSION, stableStringify } from './model.js';

export const isLegacyVersion = (version) => ['1.0.0', '2.0.0'].includes(version);

// Callers must validate the original protocol and references before conversion.
export function migrateInstrument(record) {
  const result = structuredClone(record);
  if (!isLegacyVersion(result.schema_version)) throw new Error('Expected original v1 or v2 instrument');
  if (result.schema_version === '1.0.0') result.industry.industry_group_id = null;
  const { primary_theme_id, ...classification } = result.classification;
  if (primary_theme_id !== null) classification.tag_ids = [...new Set([...classification.tag_ids, primary_theme_id])];
  result.classification = classification;
  result.schema_version = SCHEMA_VERSION;
  return result;
}

export function migrateVocabulary(vocabulary) {
  const result = structuredClone(vocabulary);
  if (!isLegacyVersion(result.schema_version)) throw new Error('Expected original v1 or v2 vocabulary');
  const labels = new Map(result.tags.map((tag) => [tag.id, tag]));
  const names = new Map();
  const normalize = (name) => name.trim().toLocaleLowerCase('en-US');
  for (const tag of result.tags) {
    for (const name of [tag.name_zh, ...tag.aliases]) names.set(normalize(name), tag.id);
  }
  for (const theme of result.themes) {
    const existing = labels.get(theme.id);
    if (existing) {
      if (stableStringify(existing) === stableStringify(theme)) continue;
      throw new Error(`Theme/tag ID collision "${theme.id}": labels differ; resolve explicitly before migration (no data was written)`);
    }
    for (const name of [theme.name_zh, ...theme.aliases]) {
      const collision = names.get(normalize(name));
      if (collision) throw new Error(`Theme/tag label collision "${name}" (${collision}, ${theme.id}): resolve IDs/names explicitly before migration (no data was written)`);
    }
    result.tags.push(theme);
    labels.set(theme.id, theme);
    for (const name of [theme.name_zh, ...theme.aliases]) names.set(normalize(name), theme.id);
  }
  delete result.themes;
  if (result.schema_version === '1.0.0') {
    for (const system of result.industry_systems) {
      system.industry_groups = [];
      for (const industry of system.industries) industry.industry_group_id = null;
    }
  }
  result.schema_version = SCHEMA_VERSION;
  return result;
}

export function migrateDataset(dataset) {
  return {
    schema_version: SCHEMA_VERSION,
    vocabulary: migrateVocabulary(dataset.vocabulary),
    instruments: dataset.instruments.map(migrateInstrument),
  };
}
