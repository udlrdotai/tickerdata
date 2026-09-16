import { mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
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
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  run('npm', ['pack', './packages/node', '--pack-destination', artifacts]);
  run('python3', ['-m', 'build', '--outdir', artifacts, './packages/python']);
  const files = (await readdir(artifacts)).sort();
  if (!files.some((name) => name.endsWith('.tgz')) ||
      !files.some((name) => name.endsWith('.whl')) ||
      !files.some((name) => name.endsWith('.tar.gz'))) {
    throw new Error(`Missing package artifacts: ${files.join(', ')}`);
  }
  console.log(`Built package artifacts:\n${files.join('\n')}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
