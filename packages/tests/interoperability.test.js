import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const nodeReader = require('../node/reader.cjs');

test('Node and Python packages return identical records', () => {
  const queries = [
    ['NVDA', {}],
    ['BRK.B', { mic: 'XNYS' }],
    ['BRK-B', { mic: 'XNYS', provider: 'yahoo' }],
  ];
  const nodeResults = queries.map(([symbol, options]) => nodeReader.lookup(symbol, options));
  const python = [
    'import json, sys',
    'from tickerdata import lookup',
    'queries = json.load(sys.stdin)',
    'print(json.dumps([lookup(item[0], mic=item[1].get("mic"), provider=item[1].get("provider")) for item in queries], sort_keys=True))',
  ].join('\n');
  const pythonResults = JSON.parse(execFileSync('python3', ['-c', python], {
    cwd: resolve('.'),
    env: { ...process.env, PYTHONPATH: resolve('packages/python/src') },
    input: JSON.stringify(queries),
    encoding: 'utf8',
  }));
  assert.deepEqual(pythonResults, nodeResults);
});
