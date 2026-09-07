import { createHash } from 'node:crypto';
import { stableStringify, SCHEMA_VERSION } from './model.js';
import { symbolEntries, validateDataset } from './validation.js';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function recordHash(record) {
  return sha256(stableStringify(record));
}

export function createRelease(dataset, { sourceCommit = null, generatedAt = '1970-01-01T00:00:00.000Z', schemas = {} } = {}) {
  const errors = validateDataset(dataset);
  if (errors.length) throw new Error(errors.join('\n'));
  if (sourceCommit !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) throw new Error('Invalid source commit');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(generatedAt) ||
      !Number.isFinite(Date.parse(generatedAt)) ||
      new Date(generatedAt).toISOString().replace('.000Z', 'Z') !== generatedAt.replace('.000Z', 'Z')) throw new Error('Invalid deterministic generation time');

  const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const normalized = {
    ...dataset,
    instruments: [...dataset.instruments].sort(compareId),
    vocabulary: {
      ...dataset.vocabulary,
      themes: [...dataset.vocabulary.themes].sort(compareId),
      tags: [...dataset.vocabulary.tags].sort(compareId),
      industry_systems: [...dataset.vocabulary.industry_systems].sort(compareId),
    },
  };
  const version = sha256(stableStringify({ dataset: normalized, schemas, sourceCommit, generatedAt }));
  const envelope = { schema_version: SCHEMA_VERSION, data_version: version };
  const instruments = normalized.instruments.filter((record) => record.review.status === 'reviewed');
  const entries = instruments.flatMap(symbolEntries);
  entries.sort((a, b) => {
    const left = stableStringify(a);
    const right = stableStringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const files = {
    'instruments.json': stableStringify({ ...envelope, instruments }),
    'themes.json': stableStringify({ ...envelope, themes: normalized.vocabulary.themes, tags: normalized.vocabulary.tags, industry_systems: normalized.vocabulary.industry_systems }),
    'symbol-index.json': stableStringify({ ...envelope, entries }),
  };
  const manifest = {
    ...envelope,
    source_commit: sourceCommit,
    generated_at: generatedAt,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { sha256: sha256(content), bytes: Buffer.byteLength(content) }])),
  };
  files['manifest.json'] = stableStringify(manifest);
  return { version, manifest, files };
}
