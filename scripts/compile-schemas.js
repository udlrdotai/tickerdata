import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import standaloneCode from 'ajv/dist/standalone/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function compileSchemas() {
  const ajv = new Ajv({ allErrors: true, strict: true, code: { source: true } });
  addFormats(ajv, { mode: 'full', formats: ['date', 'date-time', 'uri'] });
  for (const name of ['common', 'instrument', 'vocabulary', 'suggestion']) {
    ajv.addSchema(JSON.parse(await readFile(`${root}schemas/${name}.schema.json`, 'utf8')));
  }
  const code = standaloneCode(ajv, {
    instrument: 'https://tickerdata.local/schemas/instrument',
    vocabulary: 'https://tickerdata.local/schemas/vocabulary',
    suggestion: 'https://tickerdata.local/schemas/suggestion',
  });
  await mkdir(`${root}web/generated`, { recursive: true });
  await writeFile(`${root}web/generated/validators.cjs`, code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await compileSchemas();
