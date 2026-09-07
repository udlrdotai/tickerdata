import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { stableStringify } from '../src/model.js';
import { validateDataset } from '../src/validation.js';
import { createRelease } from '../src/release.js';
import { prepareImport } from '../scripts/import.js';

let browser;
let server;
let origin;
let downloads;
let initial;
const errors = [];

before(async () => {
  const root = resolve('dist');
  initial = JSON.parse(await readFile(resolve(root, 'source-data.json'), 'utf8'));
  downloads = await mkdtemp(resolve(tmpdir(), 'tickerdata-browser-'));
  server = createServer(async (request, response) => {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(request.url, 'http://localhost').pathname}`);
    if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(path);
      response.setHeader('Content-Type', { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' }[extname(path)] ?? 'application/octet-stream');
      response.end(bytes);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(error.message);
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
  if (downloads) await rm(downloads, { recursive: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(JSON.parse(await readFile('dist/source-data.json', 'utf8')), initial);
});

async function pageForTest(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith('blob:')) errors.push(`Unexpected external request ${request.url()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());
  t.after(() => context.close());
  await page.goto(origin);
  await page.getByRole('heading', { name: '证券目录', exact: true }).waitFor();
  return page;
}

async function downloadJson(page, button) {
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;
  const path = resolve(downloads, `${Date.now()}-${download.suggestedFilename()}`);
  await download.saveAs(path);
  return JSON.parse(await readFile(path, 'utf8'));
}

test('search/filter works at desktop and narrow mobile widths without an external service', async (t) => {
  const page = await pageForTest(t);
  assert.match(await page.locator('.status-line').textContent(), /17 条/);
  await page.getByLabel('搜索', { exact: true }).fill('BRK-B');
  assert.equal(await page.locator('aside .record-button').count(), 1);
  assert.match(await page.locator('aside .record-button').textContent(), /BRK.B/);
  await page.getByLabel('搜索', { exact: true }).fill('');
  await page.getByLabel('证券类型', { exact: true }).selectOption('etf');
  assert.equal(await page.locator('aside .record-button').count(), 7);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await page.evaluate(() => localStorage.length), 0);
});

test('record edit, explicit human review, downgrade, safe text, validation and export are real browser flows', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Synthetic browser fixture');
  await page.getByLabel('MIC 交易场所代码', { exact: true }).fill('XNAS');
  await page.getByLabel('维护备注', { exact: true }).fill('<img src=x onerror="window.injected=true">');
  await page.getByLabel('审核人', { exact: true }).fill('Browser test fixture only');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '预览当前表单差异', exact: true }).click();
  assert.equal(await page.locator('section[aria-label="编辑详情"] img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /未提交 GitHub/);
  const approved = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(approved.review.status, 'reviewed');
  assert.equal(approved.id, 'ins-000001');
  assert.deepEqual(validateDataset({ ...initial, instruments: initial.instruments.map((record) => record.id === approved.id ? approved : record) }), []);
  const imported = prepareImport(initial, approved).candidate;
  const release = createRelease(imported);
  const snapshot = resolve(downloads, 'browser-approved-release');
  await mkdir(snapshot);
  for (const [name, bytes] of Object.entries(release.files)) await writeFile(resolve(snapshot, name), bytes);
  const consumed = JSON.parse(execFileSync('python3', [
    'examples/consumer.py', 'NVDA', '--snapshot', snapshot, '--version', release.version,
  ], { encoding: 'utf8' }));
  assert.equal(consumed.instrument.id, approved.id);
  assert.equal(consumed.primary_theme.id, approved.classification.primary_theme_id);
  await page.getByLabel('英文名称', { exact: true }).fill('Corrected fixture name');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const edited = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(edited.review.status, 'needs_review');
  await page.getByLabel('分类来源 ID', { exact: true }).fill('');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /classification needs its own source/);
  await page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /未保存内容/);
});

test('adding ETF uses separate attributes and keeps identity stable when type changes', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '＋ 新增证券', exact: true }).click();
  await page.getByLabel('原始代码', { exact: true }).fill('TESTF');
  await page.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('etf');
  assert.equal(await page.getByLabel('行业体系', { exact: true }).count(), 0);
  await page.getByLabel('主主题（单选）', { exact: true }).selectOption('semiconductor-sector');
  await page.getByLabel('分类来源 ID', { exact: true }).fill('human');
  await page.getByLabel('ETF 来源 ID', { exact: true }).fill('human');
  await page.getByLabel('来源证据（JSON 数组）', { exact: true }).fill(JSON.stringify([
    { id: 'human', kind: 'manual', label: 'Synthetic fixture objective', url: null, accessed_at: null, fields: ['/classification', '/etf'] },
  ]));
  await page.getByLabel('杠杆倍数', { exact: true }).fill('3');
  await page.getByLabel('方向', { exact: true }).selectOption('long');
  await page.getByLabel('重置周期', { exact: true }).selectOption('daily');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const etf = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(etf.symbol.canonical, 'TESTF');
  assert.equal(etf.security_type, 'etf');
  assert.equal(etf.etf.leverage_factor, 3);
  assert.equal(etf.industry.industry_id, null);
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('stock');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const stock = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(stock.id, etf.id);
  assert.equal(stock.etf, null);
});

test('theme references block deletion and merged full bundle round-trips through browser import', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '主题 / 标签 / 行业词表', exact: true }).click();
  await page.locator('aside .record-button').filter({ hasText: 'semiconductor-ai' }).click();
  await page.getByRole('button', { name: '删除未被引用词条', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /拒绝删除/);
  await page.getByLabel('将当前词条并入', { exact: true }).selectOption('ai-cloud');
  await page.getByRole('button', { name: '预览并合并到目标 ID', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已原子合并/);
  const bundle = await downloadJson(page, page.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.equal(bundle.instruments.length, 17);
  assert.equal(bundle.vocabulary.themes.some((theme) => theme.id === 'semiconductor-ai'), false);
  assert.equal(bundle.instruments.find((record) => record.id === 'ins-000001').classification.primary_theme_id, 'ai-cloud');
  assert.equal(bundle.instruments.find((record) => record.id === 'ins-000002').review.status, 'needs_review');
  assert.deepEqual(validateDataset(bundle), []);
  const importedPage = await pageForTest(t);
  await importedPage.locator('input[type=file]').setInputFiles({
    name: 'tickerdata-maintenance-bundle.json', mimeType: 'application/json', buffer: Buffer.from(stableStringify(bundle)),
  });
  await importedPage.getByText('导入内容已通过全数据集校验。', { exact: false }).waitFor();
  const imported = await downloadJson(importedPage, importedPage.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.deepEqual(imported, bundle);
});

test('unsaved navigation cancellation retains edits and malformed import is visibly rejected', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Unsaved fixture');
  page.removeAllListeners('dialog');
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: /^CRWV ·/ }).click();
  assert.equal(await page.getByLabel('英文名称', { exact: true }).inputValue(), 'Unsaved fixture');
  page.removeAllListeners('dialog');
  page.on('dialog', (dialog) => dialog.accept());
  await page.locator('input[type=file]').setInputFiles({
    name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"schema_version":'),
  });
  await page.locator('#messages.error').waitFor();
  assert.match(await page.locator('#messages').textContent(), /导入失败/);
  assert.equal(await page.getByLabel('英文名称', { exact: true }).inputValue(), 'Unsaved fixture');
});
