import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, stableStringify } from '../src/model.js';
import { validateDataset, validateLegacyDataset, validateLegacyShape } from '../src/validation.js';
import { sha256 } from '../src/release.js';
import { loadDataset } from './cli.js';
import { prepareImport, applyPreparedImport, datasetHash } from './import.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function assertValid(errors) {
  if (errors.length) throw new Error(errors.join('\n'));
}

function kindOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected a v1 instrument, vocabulary, or maintenance bundle');
  if ('data_version' in payload || 'manifest.json' in payload || 'files' in payload) throw new Error('Historical releases cannot be migrated or rewritten; migrate maintenance source data and publish a new release');
  if (payload.schema_version !== '1.0.0') throw new Error('Migration requires original schema_version 1.0.0; already migrated or unsupported protocol');
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

// This is only a validation context for old references, never a migrated output.
// The original payload is inserted after projection and strictly validated as v1.
function legacyContext(current) {
  const context = structuredClone(current);
  context.schema_version = '1.0.0';
  context.vocabulary.schema_version = '1.0.0';
  for (const system of context.vocabulary.industry_systems) {
    delete system.industry_groups;
    for (const industry of system.industries) delete industry.industry_group_id;
  }
  for (const record of context.instruments) {
    record.schema_version = '1.0.0';
    delete record.industry.industry_group_id;
  }
  return context;
}

function upgrade(payload, kind) {
  const result = structuredClone(payload);
  result.schema_version = SCHEMA_VERSION;
  if (kind === 'dataset') {
    result.vocabulary = upgrade(result.vocabulary, 'vocabulary');
    result.instruments = result.instruments.map((record) => upgrade(record, 'instrument'));
  } else if (kind === 'vocabulary') {
    for (const system of result.industry_systems) {
      system.industry_groups = [];
      for (const industry of system.industries) industry.industry_group_id = null;
    }
  } else result.industry.industry_group_id = null;
  return result;
}

function invalidateContextReviews(context, suppliedIds) {
  let changed;
  do {
    changed = false;
    const reviewed = new Set(context.instruments.filter((record) => record.review.status === 'reviewed').map((record) => record.id));
    for (const record of context.instruments) {
      // Imported review assertions must pass unchanged. Only existing dependents
      // outside the raw payload may lose review during contextual validation.
      if (!suppliedIds.has(record.id) && record.review.status === 'reviewed' &&
          record.related_instrument_ids.some((id) => !reviewed.has(id))) {
        record.review.status = 'needs_review';
        changed = true;
      }
    }
  } while (changed);
}

function invalidateReviews(current, candidate, invalidateVocabulary, migratedIds) {
  const before = new Map(current.instruments.map((record) => [record.id, record]));
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
    if ((record.review.status === 'reviewed' || prior?.review.status === 'reviewed') &&
        (invalidateVocabulary || migratedIds.has(record.id) || content(prior) !== content(record))) downgrade(record);
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
  assertValid(current.schema_version === '1.0.0' ? validateLegacyDataset(current) : validateDataset(current));
  if (kind !== 'dataset') assertValid(validateLegacyShape(payload, kind));
  const original = merge(current.schema_version === '1.0.0' ? current : legacyContext(current), payload, kind);
  if (kind === 'instrument') invalidateContextReviews(original, new Set([payload.id]));
  assertValid(validateLegacyDataset(original));
  const candidate = current.schema_version === '1.0.0'
    ? upgrade(original, 'dataset')
    : merge(current, upgrade(payload, kind), kind);
  const migratedIds = new Set(kind === 'instrument' ? [payload.id] : []);
  invalidateReviews(current, candidate, kind !== 'instrument' || current.schema_version === '1.0.0', migratedIds);
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
