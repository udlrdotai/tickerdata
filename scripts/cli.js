import { readFile, readdir, mkdir, writeFile, cp, access } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { stableStringify, SCHEMA_VERSION } from '../src/model.js';
import { validateDataset, validateReviewTransitions, validateSuggestion, validateSuggestionShape } from '../src/validation.js';
import { createRelease, recordHash } from '../src/release.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

export async function loadDataset(directory = root) {
  const folder = resolve(directory, 'data/instruments');
  const files = (await readdir(folder)).filter((name) => name.endsWith('.json')).sort();
  const instruments = [];
  for (const name of files) {
    const record = await json(resolve(folder, name));
    if (name !== `${record.id}.json`) throw new Error(`Source filename must match immutable record ID: ${name}`);
    instruments.push(record);
  }
  return { schema_version: SCHEMA_VERSION, instruments, vocabulary: await json(resolve(directory, 'data/vocabulary.json')) };
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function loadBaseline(ref) {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(ref)) throw new Error('Baseline must be a full commit SHA');
  const files = git(['ls-tree', '-r', '--name-only', ref, '--', 'data/instruments']).split('\n').filter((file) => file.endsWith('.json'));
  return { instruments: files.map((file) => JSON.parse(git(['show', `${ref}:${file}`]))) };
}

function assertValid(errors) {
  if (errors.length) throw new Error(errors.join('\n'));
}

async function validateSuggestions() {
  const folder = resolve(root, 'suggestions');
  for (const name of (await readdir(folder)).filter((name) => name.endsWith('.json')).sort()) {
    const suggestion = await json(resolve(folder, name));
    // Historical suggestions retain their original vocabulary and base hash.
    assertValid(validateSuggestionShape(suggestion));
  }
}

function provenance() {
  const insideGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  const inRepo = insideGit.status === 0 && insideGit.stdout.trim() === 'true';
  if (inRepo && git(['status', '--porcelain', '--untracked-files=normal'])) {
    if (process.env.CI) throw new Error('Refusing a CI release from a dirty working tree');
    console.warn('Local working tree is dirty: source_commit is null, not a claim that HEAD contains these edits.');
    return { sourceCommit: null, generatedAt: epochTime(process.env.SOURCE_DATE_EPOCH ?? '0') };
  }
  const sourceCommit = inRepo ? git(['rev-parse', 'HEAD']) : null;
  const epoch = process.env.SOURCE_DATE_EPOCH ?? (inRepo ? git(['show', '-s', '--format=%ct', 'HEAD']) : '0');
  if (!inRepo) console.warn('No Git repository: local preview uses source_commit=null and deterministic epoch time.');
  return { sourceCommit, generatedAt: epochTime(epoch) };
}

function epochTime(epoch) {
  if (!/^\d+$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) throw new Error('SOURCE_DATE_EPOCH must be nonnegative integer seconds');
  return new Date(Number(epoch) * 1000).toISOString();
}

async function writeRelease(path, release) {
  await mkdir(path, { recursive: true });
  for (const [name, content] of Object.entries(release.files)) await writeFile(resolve(path, name), content);
}

async function buildSite(dataset) {
  const schemas = {};
  for (const filename of (await readdir(resolve(root, 'schemas'))).filter((name) => name.endsWith('.json')).sort()) schemas[filename] = await json(resolve(root, 'schemas', filename));
  const release = createRelease(dataset, { ...provenance(), schemas });
  const dist = resolve(root, 'dist');
  const immutablePath = resolve(dist, 'releases', release.version);
  try {
    await access(resolve(immutablePath, 'manifest.json'));
    for (const [name, content] of Object.entries(release.files)) {
      if (await readFile(resolve(immutablePath, name), 'utf8') !== content) throw new Error(`Immutable release collision: ${release.version}/${name}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeRelease(immutablePath, release);
  await writeRelease(resolve(dist, 'latest'), release);
  const siteConfig = await json(resolve(root, 'config/site.json'));
  if (siteConfig.repository_url !== null && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(siteConfig.repository_url)) throw new Error('repository_url must be null or a GitHub repository HTTPS URL');
  if (typeof siteConfig.branch !== 'string' || !siteConfig.branch.trim() || typeof siteConfig.pages_enabled !== 'boolean') throw new Error('Invalid site configuration');
  await writeFile(resolve(dist, 'source-data.json'), stableStringify(dataset));
  await writeFile(resolve(dist, 'site-config.json'), stableStringify(siteConfig));
  await writeFile(resolve(dist, 'release-info.json'), stableStringify(release.manifest));
  await cp(resolve(root, 'schemas'), resolve(dist, 'schemas'), { recursive: true });
  const notices = [];
  for (const dependency of ['ajv', 'ajv-formats', 'fast-deep-equal']) {
    notices.push(`${dependency}\n${await readFile(resolve(root, 'node_modules', dependency, 'LICENSE'), 'utf8')}`);
  }
  await writeFile(resolve(dist, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'));
  await cp(resolve(root, 'LICENSE'), resolve(dist, 'SOFTWARE_LICENSE.txt'));
  await cp(resolve(root, 'docs/licensing.md'), resolve(dist, 'DATA_AND_EXTERNAL_TERMS.md'));
  for (const name of ['index.html', 'style.css']) await cp(resolve(root, 'web', name), resolve(dist, name));
  await build({ entryPoints: [resolve(root, 'web/app.js')], outfile: resolve(dist, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'eof' });
  console.log(`Built ${release.version}: ${JSON.parse(release.files['instruments.json']).instruments.length} reviewed / ${dataset.instruments.length} source records. Pages is ${siteConfig.pages_enabled ? 'opted in' : 'disabled'}.`);
}

async function main() {
  const command = process.argv[2] ?? 'validate';
  const dataset = await loadDataset();
  assertValid(validateDataset(dataset));
  if (command === 'validate') {
    const args = process.argv.slice(3);
    if (args.length && (args.length !== 2 || args[0] !== '--base-ref')) throw new Error('Usage: npm run validate -- [--base-ref FULL_COMMIT_SHA]');
    if (args.length) assertValid(validateReviewTransitions(loadBaseline(args[1]), dataset));
    await validateSuggestions();
    console.log(`Valid: ${dataset.instruments.length} instruments; suggestions isolated from data.`);
  } else if (command === 'build') {
    await buildSite(dataset);
  } else if (command === 'suggestion') {
    const filename = process.argv[3];
    if (!filename || process.argv.length !== 4) throw new Error('Usage: npm run suggestion:validate -- path/to/suggestion.json');
    assertValid(validateSuggestion(await json(resolve(filename)), dataset, recordHash));
    console.log(`Valid suggestion ${basename(filename)}; no source data was modified.`);
  } else throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
