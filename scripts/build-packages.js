import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/release.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const releaseDirectory = resolve(root, 'dist/latest');
const dataFiles = ['instruments.json', 'vocabulary.json', 'symbol-index.json'];
const snapshotFiles = ['manifest.json', ...dataFiles];
const destinations = [
  resolve(root, 'packages/node/data'),
  resolve(root, 'packages/python/src/tickerdata/data'),
];
const packageRoots = [
  resolve(root, 'packages/node'),
  resolve(root, 'packages/python'),
];

async function packageVersions() {
  const nodePackage = JSON.parse(await readFile(resolve(root, 'packages/node/package.json'), 'utf8'));
  const pythonProject = await readFile(resolve(root, 'packages/python/pyproject.toml'), 'utf8');
  const match = pythonProject.match(/^version = "([^"]+)"$/m);
  if (!match) throw new Error('Python package version is missing');
  if (nodePackage.version !== match[1]) {
    throw new Error(`Package versions differ: npm=${nodePackage.version}, PyPI=${match[1]}`);
  }
  return nodePackage.version;
}

async function readSnapshot() {
  const files = Object.fromEntries(await Promise.all(snapshotFiles.map(async (name) => [
    name,
    await readFile(resolve(releaseDirectory, name)),
  ])));
  const manifest = JSON.parse(files['manifest.json']);
  if (manifest.schema_version !== '4.0.0' || !/^[a-f0-9]{64}$/.test(manifest.data_version)) {
    throw new Error('Package snapshot has an unsupported schema or invalid data version');
  }
  if (Object.keys(manifest.files).sort().join('\n') !== dataFiles.slice().sort().join('\n')) {
    throw new Error('Package snapshot manifest has unexpected files');
  }
  for (const name of dataFiles) {
    const expected = manifest.files[name];
    if (files[name].byteLength !== expected.bytes || sha256(files[name]) !== expected.sha256) {
      throw new Error(`${name} does not match manifest`);
    }
    const payload = JSON.parse(files[name]);
    if (payload.schema_version !== manifest.schema_version ||
        payload.data_version !== manifest.data_version) {
      throw new Error(`${name} version does not match manifest`);
    }
  }
  const instruments = JSON.parse(files['instruments.json']).instruments;
  if (instruments.some((record) => record.review.status !== 'reviewed')) {
    throw new Error('Package snapshot contains an unreviewed instrument');
  }
  return { files, manifest, instrumentCount: instruments.length };
}

async function main() {
  const version = await packageVersions();
  const snapshot = await readSnapshot();
  for (const destination of destinations) {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    for (const name of snapshotFiles) {
      await copyFile(resolve(releaseDirectory, name), resolve(destination, name));
    }
  }
  for (const destination of packageRoots) {
    await copyFile(resolve(root, 'LICENSE'), resolve(destination, 'LICENSE-MIT'));
    await copyFile(resolve(root, 'LICENSE-ODC-BY'), resolve(destination, 'LICENSE-ODC-BY'));
    await copyFile(resolve(root, 'PACKAGE-NOTICE.md'), resolve(destination, 'NOTICE.md'));
  }
  console.log(`Prepared tickerdata ${version} with data ${snapshot.manifest.data_version} (${snapshot.instrumentCount} reviewed instruments).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
