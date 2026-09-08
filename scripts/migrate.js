import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../src/model.js';
import { validateDataset, validateLegacyDataset, validateLegacyShape, validateLegacyInstrument } from '../src/validation.js';
import { isLegacyVersion, migrateDataset, migrateInstrument, migrateVocabulary } from '../src/migration.js';
import { sha256 } from '../src/release.js';
import { loadDataset } from './cli.js';
import { prepareImport, applyPreparedImport, datasetHash } from './import.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function assertValid(errors) {
  if (errors.length) throw new Error(errors.join('\n'));
}

function kindOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected a v1/v2 instrument, vocabulary, or maintenance bundle');
  if ('data_version' in payload || 'manifest.json' in payload || 'files' in payload) throw new Error('Historical releases cannot be migrated or rewritten; migrate maintenance source data and publish a new release');
  if (!isLegacyVersion(payload.schema_version)) throw new Error('Migration requires original schema_version 1.0.0 or 2.0.0; already migrated or unsupported protocol');
  if ('instruments' in payload) return 'dataset';
  if ('industry_systems' in payload) return 'vocabulary';
  return 'instrument';
}

function merge(current, payload, kind) {
  if (kind === 'dataset') return structuredClone(payload);
  const next = structuredClone(current);
  if (kind === 'vocabulary') next.vocabulary = structuredClone(payload);
  else {
    const index = next.instruments.findIndex((record) => record.id === payload.id);
    if (index === -1) next.instruments.push(structuredClone(payload));
    else next.instruments[index] = structuredClone(payload);
  }
  return next;
}

function legacyVocabularyContext(vocabulary, version) {
  const result = structuredClone(vocabulary);
  if (!isLegacyVersion(result.schema_version)) result.themes = structuredClone(result.tags);
  if (version === '1.0.0') {
    for (const system of result.industry_systems) {
      delete system.industry_groups;
      for (const industry of system.industries) delete industry.industry_group_id;
    }
  } else if (result.schema_version === '1.0.0') {
    for (const system of result.industry_systems) {
      system.industry_groups = [];
      for (const industry of system.industries) industry.industry_group_id = null;
    }
  }
  result.schema_version = version;
  return result;
}

function invalidateReviews(current, candidate) {
  const before = new Map(current.instruments.map((record) => [record.id, record]));
  const vocabularyChanged = stableStringify(current.vocabulary) !== stableStringify(candidate.vocabulary);
  const downgrade = (record) => {
    record.review.status = 'needs_review';
  };
  for (const record of candidate.instruments) {
    const prior = before.get(record.id);
    const content = (value) => {
      if (!value) return null;
      const { review, ...rest } = value;
      return stableStringify(rest);
    };
    if (record.review.status === 'reviewed' || prior?.review.status === 'reviewed') {
      if (!vocabularyChanged && content(prior) === content(record) &&
          prior?.review.status === 'reviewed' && record.review.status === 'reviewed') {
        record.review = structuredClone(prior.review);
      } else {
        // A legacy assertion is not a new human review of current data.
        if (prior) record.review = structuredClone(prior.review);
        downgrade(record);
      }
    }
  }
  let changed;
  do {
    changed = false;
    const reviewed = new Set(candidate.instruments.filter((record) => record.review.status === 'reviewed').map((record) => record.id));
    for (const record of candidate.instruments) {
      if (record.review.status === 'reviewed' && record.related_instrument_ids.some((id) => !reviewed.has(id))) {
        downgrade(record);
        changed = true;
      }
    }
  } while (changed);
}

export function prepareMigration(current, payload) {
  const kind = kindOf(payload);
  assertValid(isLegacyVersion(current.schema_version) ? validateLegacyDataset(current) : validateDataset(current));
  if (kind !== 'dataset') assertValid(validateLegacyShape(payload, kind));
  if (kind === 'dataset') assertValid(validateLegacyDataset(payload));
  else if (kind === 'vocabulary') assertValid(validateLegacyDataset({
    schema_version: payload.schema_version, vocabulary: payload, instruments: [],
  }));
  else assertValid(validateLegacyInstrument(payload,
    legacyVocabularyContext(current.vocabulary, payload.schema_version), current.instruments));
  if (kind === 'vocabulary' && isLegacyVersion(current.schema_version)) {
    assertValid(validateLegacyDataset({
      ...current, vocabulary: legacyVocabularyContext(payload, current.schema_version),
    }));
  }
  const baseline = isLegacyVersion(current.schema_version) ? migrateDataset(current) : structuredClone(current);
  const converted = kind === 'dataset' ? migrateDataset(payload)
    : kind === 'vocabulary' ? migrateVocabulary(payload) : migrateInstrument(payload);
  const candidate = merge(baseline, converted, kind);
  invalidateReviews(baseline, candidate);
  const prepared = prepareImport(current, candidate);
  const sourceHash = prepared.expected;
  // Bind approval to both source state and the exact legacy input, not just its filename.
  const expected = sha256(stableStringify({ sourceHash, payload }));
  return { ...prepared, expected, sourceHash };
}

export async function applyMigration(directory, payload, expected) {
  const prepared = prepareMigration(await loadDataset(directory), payload);
  if (!expected || expected !== prepared.expected) throw new Error('Source or migration input changed, or expected hash missing. Preview again before --apply --expect HASH.');
  if (datasetHash(await loadDataset(directory)) !== prepared.sourceHash) throw new Error('Concurrent source edit detected. Preview again.');
  await applyPreparedImport(directory, { ...prepared, expected: prepared.sourceHash }, prepared.sourceHash);
  return prepared;
}

async function main() {
  const [filename, ...args] = process.argv.slice(2);
  const applying = args.length === 3 && args[0] === '--apply' && args[1] === '--expect' && /^[a-f0-9]{64}$/.test(args[2]);
  if (!filename || (args.length && !applying)) throw new Error('Usage: npm run migrate -- legacy.json [--apply --expect HASH_FROM_PREVIEW]');
  const payload = JSON.parse(await readFile(resolve(filename), 'utf8'));
  const prepared = applying
    ? await applyMigration(root, payload, args[2])
    : prepareMigration(await loadDataset(), payload);
  for (const change of prepared.changed) console.log(`\n${change.path}\n--- BEFORE\n${stableStringify(change.before)}+++ AFTER\n${stableStringify(change.after)}`);
  console.log(`${applying ? 'Migrated local maintenance files only; no historical releases, suggestions, commits or publications changed.' : 'Preview only; no files changed.'}\nChanged files: ${prepared.changed.length}\nExpected migration hash: ${prepared.expected}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
