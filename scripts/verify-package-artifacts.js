import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');
const artifacts = resolve(root, '.cache/package-artifacts');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function main() {
  const names = (await readdir(artifacts)).sort();
  const npmArchive = names.find((name) => name.endsWith('.tgz'));
  const wheel = names.find((name) => name.endsWith('.whl'));
  const source = names.find((name) => name.endsWith('.tar.gz'));
  if (!npmArchive || !wheel || !source) throw new Error('Expected npm, wheel and sdist artifacts');

  const npmFiles = run('tar', ['-tzf', resolve(artifacts, npmArchive)]).trim().split('\n');
  for (const required of [
    'package/package.json',
    'package/reader.cjs',
    'package/index.js',
    'package/data/manifest.json',
    'package/data/instruments.json',
    'package/data/symbol-index.json',
    'package/data/vocabulary.json',
    'package/LICENSE-MIT',
    'package/LICENSE-ODC-BY',
    'package/NOTICE.md',
  ]) {
    if (!npmFiles.includes(required)) throw new Error(`npm archive is missing ${required}`);
  }
  if (npmFiles.some((name) => name.includes('/test/'))) throw new Error('npm archive contains tests');

  const stage = await mkdtemp(join(tmpdir(), 'tickerdata-packages-'));
  try {
    run('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as archive:',
      ' names = archive.namelist()',
      ' required = ["tickerdata/__init__.py", "tickerdata/reader.py", "tickerdata/data/manifest.json", "tickerdata/data/instruments.json", "tickerdata/data/symbol-index.json", "tickerdata/data/vocabulary.json"]',
      ' missing = [name for name in required if name not in names]',
      ' assert not missing, missing',
      ' assert not any("/tests/" in name for name in names), names',
    ].join('\n'), resolve(artifacts, wheel)]);

    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(stage, 'node'), resolve(artifacts, npmArchive)]);
    run('node', ['-e', "const {lookup}=require('tickerdata'); if(lookup('NVDA').symbol.canonical!=='NVDA') process.exit(1)"], {
      cwd: join(stage, 'node'),
    });

    run('python3', ['-m', 'venv', join(stage, 'python')]);
    const python = join(stage, 'python', 'bin', 'python');
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', resolve(artifacts, wheel)]);
    run(python, ['-c', "from tickerdata import lookup; assert lookup('NVDA')['symbol']['canonical']=='NVDA'"]);

    const sourceList = run('tar', ['-tzf', resolve(artifacts, source)]);
    if (!sourceList.includes('/src/tickerdata/data/manifest.json')) {
      throw new Error('Python sdist is missing the embedded snapshot');
    }
    const builtManifest = await readFile(resolve(root, 'dist/latest/manifest.json'));
    if (!builtManifest.length) throw new Error('Built manifest is empty');
  } finally {
    await rm(stage, { recursive: true });
  }
  console.log('Package contents and clean-environment installs are valid.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
