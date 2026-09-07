import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './cli.js';
import { stableStringify } from '../src/model.js';
import { sha256 } from '../src/release.js';
import { validateDataset, validateReviewTransitions } from '../src/validation.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export function datasetHash(dataset) {
  return sha256(stableStringify(dataset));
}

export function prepareImport(current, payload) {
  let candidate;
  if (payload && Array.isArray(payload.instruments) && payload.vocabulary) candidate = structuredClone(payload);
  else if (payload && Array.isArray(payload.themes) && Array.isArray(payload.industry_systems)) candidate = { ...structuredClone(current), vocabulary: structuredClone(payload) };
  else if (payload && typeof payload.id === 'string') {
    candidate = structuredClone(current);
    const index = candidate.instruments.findIndex((record) => record.id === payload.id);
    if (index < 0) candidate.instruments.push(structuredClone(payload));
    else candidate.instruments[index] = structuredClone(payload);
  } else throw new Error('Expected a single instrument, vocabulary, or full maintenance dataset JSON');
  const errors = validateDataset(candidate);
  if (!errors.length) errors.push(...validateReviewTransitions(current, candidate));
  if (errors.length) throw new Error(errors.join('\n'));
  const changed = [];
  for (const record of candidate.instruments) {
    const before = current.instruments.find((item) => item.id === record.id) ?? null;
    if (stableStringify(before) !== stableStringify(record)) changed.push({ path: `data/instruments/${record.id}.json`, before, after: record });
  }
  if (stableStringify(current.vocabulary) !== stableStringify(candidate.vocabulary)) changed.push({ path: 'data/vocabulary.json', before: current.vocabulary, after: candidate.vocabulary });
  return { candidate, changed, expected: datasetHash(current) };
}

export async function applyImport(directory, payload, expected) {
  const current = await loadDataset(directory);
  const prepared = prepareImport(current, payload);
  if (!expected || expected !== prepared.expected) throw new Error('Source changed or expected hash missing. Preview again before --apply --expect HASH.');
  if (!prepared.changed.length) return prepared;
  const cache = resolve(directory, '.cache');
  await mkdir(cache, { recursive: true });
  const transaction = await mkdtemp(resolve(cache, 'import-'));
  const staged = resolve(transaction, 'new-data');
  const backup = resolve(transaction, 'previous-data');
  const dataPath = resolve(directory, 'data');
  await cp(dataPath, staged, { recursive: true });
  for (const change of prepared.changed) {
    const relative = change.path.slice('data/'.length);
    await writeFile(resolve(staged, relative), stableStringify(change.after));
  }
  // Stage every dependent file first. If the directory swap fails, retain or restore the original.
  if (datasetHash(await loadDataset(directory)) !== expected) {
    await rm(transaction, { recursive: true });
    throw new Error('Concurrent source edit detected. Nothing was imported; preview again.');
  }
  await rename(dataPath, backup);
  try {
    await rename(staged, dataPath);
  } catch (error) {
    try {
      await rename(backup, dataPath);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Import interrupted. Original data retained at ${backup}; restore it before further work.`);
    }
    await rm(transaction, { recursive: true });
    throw error;
  }
  await rm(transaction, { recursive: true });
  return prepared;
}

async function main() {
  const [filename, ...args] = process.argv.slice(2);
  const applying = args.length === 3 && args[0] === '--apply' && args[1] === '--expect' && /^[a-f0-9]{64}$/.test(args[2]);
  if (!filename || (args.length && !applying)) throw new Error('Usage: npm run import -- draft.json [--apply --expect HASH_FROM_PREVIEW]');
  const payload = JSON.parse(await readFile(resolve(filename), 'utf8'));
  const prepared = applying
    ? await applyImport(root, payload, args[2])
    : prepareImport(await loadDataset(), payload);
  for (const change of prepared.changed) {
    console.log(`\n${change.path}\n--- BEFORE\n${stableStringify(change.before)}+++ AFTER\n${stableStringify(change.after)}`);
  }
  console.log(`${applying ? 'Imported local files only; not committed or published.' : 'Preview only; no files changed.'}\nChanged files: ${prepared.changed.length}\nExpected source hash: ${prepared.expected}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
