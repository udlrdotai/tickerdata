import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { stableStringify } from '../src/model.js';
import { validateDataset } from '../src/validation.js';
import { createRelease } from '../src/release.js';
import { createDatasetFixture } from '../tests/fixtures/dataset.js';

let browser;
let server;
let origin;
let downloads;
let initial;
let sourceSnapshot;
const errors = [];

before(async () => {
  const root = resolve('dist');
  sourceSnapshot = await readFile(resolve(root, 'source-data.json'));
  initial = createDatasetFixture();
  const fixtureJson = JSON.stringify(initial);
  downloads = resolve(`.browser-test-artifacts-${process.pid}-${Date.now()}`);
  await mkdir(downloads);
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/source-data.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(fixtureJson);
      return;
    }
    const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const path = resolve(root, `.${relativePath}`);
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
  assert.deepEqual(await readFile('dist/source-data.json'), sourceSnapshot);
});

async function pageForTest(t, options = {}, source = null, allowExternalRequests = []) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('blob:') && !allowExternalRequests.some((prefix) => url.startsWith(prefix))) {
      errors.push(`Unexpected external request ${url}`);
    }
  });
  page.on('dialog', (dialog) => dialog.accept());
  t.after(() => context.close());
  if (source !== null) {
    await page.route(`${origin}/source-data.json`, (route) => route.fulfill({
      contentType: 'application/json',
      body: Buffer.isBuffer(source) ? source : JSON.stringify(source),
    }));
  }
  await page.goto(`${origin}/maintenance/`);
  await page.getByRole('heading', { name: '证券目录', exact: true }).waitFor();
  return page;
}

async function catalogPageForTest(t) {
  const source = createDatasetFixture();
  for (const record of source.instruments) {
    record.symbol.mic = 'XNAS';
    record.review = { status: 'reviewed', reviewer: 'Synthetic reviewer', reviewed_at: '2026-01-02T03:04:05Z' };
  }
  source.instruments.find((record) => record.symbol.canonical === 'TSLA').review =
    { status: 'pending', reviewer: null, reviewed_at: null };
  const release = createRelease(source, { generatedAt: '2026-01-02T03:04:05Z' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(origin)) errors.push(`Unexpected external request ${request.url()}`);
  });
  t.after(() => context.close());
  for (const name of ['instruments.json', 'vocabulary.json', 'manifest.json']) {
    await page.route(`${origin}/latest/${name}`, (route) => route.fulfill({
      contentType: 'application/json',
      body: release.files[name],
    }));
  }
  await page.goto(origin);
  await page.getByRole('heading', { name: '标的目录', exact: true }).waitFor();
  return page;
}

async function detailAfterJson(page) {
  return JSON.parse(await page.locator('section[aria-label="编辑详情"] .diff pre').last().textContent());
}

function vocabularyRow(page, id) {
  return page.locator('aside tbody tr').filter({
    has: page.getByRole('cell', { name: id, exact: true }),
  });
}

test('search/filter works at desktop and narrow mobile widths without an external service', async (t) => {
  const page = await pageForTest(t);
  assert.equal(await page.getByRole('table').count(), 1);
  assert.deepEqual(await page.getByRole('columnheader').allTextContents(),
    ['证券代码', '名称', 'MIC', '类型', '行业', '标签', '审核状态', '操作']);
  assert.equal(await page.locator('section[aria-label="编辑详情"]').getAttribute('class'), 'panel editor-drawer');
  assert.match(await page.locator('.status-line').textContent(), /17 条/);
  await page.getByLabel('搜索', { exact: true }).fill('BRK-B');
  assert.equal(await page.locator('aside .record-button').count(), 1);
  assert.match(await page.locator('aside .record-button').textContent(), /BRK.B/);
  await page.locator('aside .record-button').click();
  assert.match(await page.locator('section[aria-label="编辑详情"]').getAttribute('class'), /\bopen\b/);
  await page.getByRole('button', { name: '关闭编辑面板', exact: true }).last().click();
  assert.doesNotMatch(await page.locator('section[aria-label="编辑详情"]').getAttribute('class'), /\bopen\b/);
  await page.getByLabel('搜索', { exact: true }).fill('');
  await page.getByLabel('证券类型', { exact: true }).selectOption('etf');
  assert.equal(await page.locator('aside .record-button').count(), 7);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await page.evaluate(() => localStorage.length), 0);
});

test('public catalog shows only reviewed release records and supports filters', async (t) => {
  const page = await catalogPageForTest(t);
  assert.match(await page.locator('.summary').textContent(), /共 16 条已审核标的/);
  assert.equal(await page.getByText('TSLA', { exact: true }).count(), 0);
  await page.getByLabel('搜索', { exact: true }).fill('BRK-B');
  assert.equal(await page.getByText('BRK.B', { exact: true }).count(), 1);
  await page.getByLabel('搜索', { exact: true }).fill('');
  await page.getByLabel('证券类型', { exact: true }).selectOption('etf');
  assert.match(await page.locator('.summary').textContent(), /7 条结果/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(await page.evaluate(() => localStorage.length), 0);
});

test('only tags and industry remain in the UI and multi-select tags save to the PR draft', async (t) => {
  const source = createDatasetFixture();
  const page = await pageForTest(t, {}, source);
  assert.equal(await page.getByLabel('主主题', { exact: true }).count(), 0);
  assert.equal(await page.locator('.badge').filter({ hasText: '未分类' }).count(), 0);
  await page.getByLabel('标签', { exact: true }).selectOption('ai');
  assert.equal(await page.locator('aside .record-button').count(), 2);
  await page.getByLabel('标签', { exact: true }).selectOption('');
  await page.getByRole('button', { name: /^NVDA$/ }).click();
  assert.deepEqual(await page.locator('form [required]').evaluateAll((controls) =>
    controls.map((control) => control.labels[0].textContent.trim())), ['原始代码', '规范代码', '证券类型', '上市状态', '审核状态']);
  assert.equal(await page.locator('form label.required').count(), 5);
  assert.deepEqual(await page.getByLabel('MIC 交易场所代码', { exact: true }).evaluate((input) =>
    [...document.getElementById(input.getAttribute('list')).options].map((option) => option.value)),
  ['XNAS', 'XNYS', 'ARCX', 'BATS', 'XASE']);
  assert.equal(await page.getByLabel('主主题（单选）', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '主题 / 标签 / 行业词表', exact: true }).count(), 0);
  assert.doesNotMatch((await page.locator('form legend').allTextContents()).join('\n'), /主主题|交易主题|与主题独立/);
  const selection = ['ai', 'semiconductor-ai', 'digital-assets'];
  const tags = page.getByRole('group', { name: '标签（多选）', exact: true });
  for (const value of selection) await tags.locator(`input[value="${value}"]`).check();
  assert.match(await page.locator('#form-state').textContent(), /未保存修改/);
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const saved = await detailAfterJson(page);
  assert.equal(saved.schema_version, '4.0.0');
  assert.deepEqual([...saved.classification.tag_ids].sort(), selection.sort());
  assert.deepEqual(Object.keys(saved.classification).sort(), ['tag_ids']);
  assert.deepEqual(saved.industry, initial.instruments[0].industry);
  assert.deepEqual(saved.sources, source.instruments[0].sources);
  await page.getByRole('button', { name: '标签 / 行业词表', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '主主题', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '主题、标签与标准行业词表', exact: true }).count(), 0);
  await page.getByRole('button', { name: '行业体系', exact: true }).click();
  await page.locator('aside .record-button').first().click();
  assert.equal(await page.getByLabel('将当前词条并入', { exact: true }).count(), 0);
});

test('reviewers can explicitly approve records without tags or classification evidence', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^TSLA$/ }).click();
  const original = initial.instruments.find((record) => record.symbol.canonical === 'TSLA');
  assert.deepEqual(original.classification, { tag_ids: [] });
  await page.getByLabel('MIC 交易场所代码', { exact: true }).fill('XNAS');
  await page.getByLabel('审核人', { exact: true }).fill('Synthetic optional-tag reviewer');
  assert.equal(await page.getByLabel('审核时间（UTC ISO）', { exact: true }).isEditable(), false);
  assert.equal(await page.getByLabel('审核时间（UTC ISO）', { exact: true }).inputValue(), '');
  await page.getByRole('checkbox', { name: /我已人工核验/ }).check();
  assert.deepEqual(await page.locator('form [required]').evaluateAll((controls) =>
    controls.map((control) => control.labels[0].textContent.trim())),
  ['原始代码', '规范代码', 'MIC 交易场所代码', '证券类型', '上市状态', '英文名称', '审核状态', '审核人']);
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已通过校验/);
  const reviewed = await detailAfterJson(page);
  assert.equal(reviewed.review.status, 'reviewed');
  assert.equal(reviewed.review.reviewer, 'Synthetic optional-tag reviewer');
  assert.ok(Number.isFinite(Date.parse(reviewed.review.reviewed_at)));
  assert.deepEqual(reviewed.classification, original.classification);
  assert.deepEqual(reviewed.industry, original.industry);
  assert.deepEqual(reviewed.sources, original.sources);
  assert.deepEqual(validateDataset({ ...initial, instruments: [reviewed] }), []);
  assert.deepEqual(JSON.parse(createRelease({ ...initial, instruments: [reviewed] }).files['instruments.json']).instruments, [reviewed]);
});

test('current built maintenance source loads without assuming sample counts or review states', async (t) => {
  const source = JSON.parse(sourceSnapshot);
  const page = await pageForTest(t, {}, sourceSnapshot);
  assert.ok((await page.locator('.status-line').textContent()).includes(`${source.instruments.length} 条`));
  assert.equal(await page.locator('aside .record-button').count(), source.instruments.length);
  const record = source.instruments.find((item) => item.review.status === 'reviewed') ?? source.instruments[0];
  if (record) {
    const index = source.instruments.findIndex((item) => item.id === record.id);
    await page.locator('aside .record-button').nth(index).click();
    assert.equal(await page.locator('section[aria-label="编辑详情"]').getByLabel('审核状态', { exact: true }).inputValue(), record.review.status);
    assert.equal(await page.getByLabel('英文名称', { exact: true }).inputValue(), record.name.en ?? '');
    assert.deepEqual(await detailAfterJson(page), record);
  }
});

test('normalization remains available for new records and unconfigured GitHub links', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '＋ 新增证券', exact: true }).click();
  let actions = page.getByRole('group', { name: '证券操作', exact: true });
  assert.equal(await actions.getByRole('link').count(), 0);
  await page.getByLabel('原始代码', { exact: true }).fill(' new.test ');
  await actions.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'NEW.TEST');
  await page.route(`${origin}/site-config.json`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ repository_url: null, branch: 'main', pages_enabled: false }),
  }));
  await page.reload();
  await page.getByRole('button', { name: /^CRWV$/ }).click();
  actions = page.getByRole('group', { name: '证券操作', exact: true });
  assert.equal(await actions.getByRole('link').count(), 0);
  await actions.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'CRWV');
  assert.match(await page.locator('#form-state').textContent(), /未保存修改/);
});

test('direct PR submission is the only persistence path', async (t) => {
  const page = await pageForTest(t);
  await page.route(`${origin}/api/auth/session`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      enabled: true,
      authenticated: true,
      user: {
        login: 'fixture-maintainer',
        avatarUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
        profileUrl: 'https://github.com/fixture-maintainer',
      },
    }),
  }));
  await page.reload();
  await page.getByRole('button', { name: /^NVDA$/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Direct PR flow fixture');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  await page.getByRole('button', { name: '关闭编辑面板', exact: true }).last().click();
  await page.getByText('直接提交 GitHub PR', { exact: true }).click();
  assert.equal(await page.getByLabel('新分支名', { exact: true }).inputValue() !== '', true);
  assert.equal(await page.getByLabel('提交信息（commit message）', { exact: true }).inputValue() !== '', true);
  assert.equal(await page.getByLabel('PR 标题', { exact: true }).inputValue() !== '', true);
  assert.match(await page.getByLabel('PR 描述', { exact: true }).inputValue(), /变更文件/);
  assert.equal(await page.getByText('已登录 GitHub：fixture-maintainer', { exact: true }).count(), 1);
  assert.equal(await page.getByText('GitHub 已登录：fixture-maintainer', { exact: true }).count(), 1);
  assert.equal(await page.getByLabel(/GitHub Token/).count(), 0);
  await page.getByRole('button', { name: '提交 PR', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /请先确认本次将提交全部变更文件/);
  await page.getByRole('checkbox', { name: /我已确认将一次性提交以上/ }).check();
  assert.equal(await page.getByText(/导出|导入/).count(), 0);
  assert.equal(await page.locator('input[type=file]').count(), 0);
});

test('records already reviewed at startup downgrade on edit unless explicitly re-reviewed', async (t) => {
  for (const explicit of [false, true]) {
    await t.test(explicit ? 'explicit re-review' : 'ordinary edit', async (subtest) => {
      const source = createDatasetFixture();
      const nvda = source.instruments.find((item) => item.symbol.canonical === 'NVDA');
      nvda.symbol.mic = 'XNAS';
      nvda.review = { status: 'reviewed', reviewer: 'Synthetic prior reviewer', reviewed_at: '2026-01-02T03:04:05Z' };
      assert.deepEqual(validateDataset(source), []);
      const page = await pageForTest(subtest, {}, source);
      await page.getByRole('button', { name: /^NVDA$/ }).click();
      assert.equal(await page.locator('section[aria-label="编辑详情"]').getByLabel('审核状态', { exact: true }).inputValue(), 'reviewed');
      assert.equal(await page.getByRole('checkbox', { name: /我已人工核验/ }).isChecked(), false);
      await page.getByLabel('英文名称', { exact: true }).fill('Synthetic edited startup record');
      if (explicit) {
        await page.getByLabel('审核人', { exact: true }).fill('Synthetic replacement reviewer');
        await page.getByRole('checkbox', { name: /我已人工核验/ }).check();
      }
      await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
      const edited = await detailAfterJson(page);
      assert.equal(edited.review.status, explicit ? 'reviewed' : 'needs_review');
      assert.equal(edited.name.en, 'Synthetic edited startup record');
      assert.equal(edited.id, nvda.id);
      assert.deepEqual(edited.classification, nvda.classification);
      if (explicit) {
        assert.equal(edited.review.reviewer, 'Synthetic replacement reviewer');
        assert.ok(edited.review.reviewed_at);
      }
      assert.deepEqual(validateDataset({
        ...source, instruments: source.instruments.map((item) => item.id === edited.id ? edited : item),
      }), []);
    });
  }
});

test('record edit, explicit human review, downgrade, safe text and validation are real browser flows', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA$/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Synthetic browser fixture');
  await page.getByLabel('MIC 交易场所代码', { exact: true }).fill('XNAS');
  await page.getByLabel('维护备注', { exact: true }).fill('<img src=x onerror="window.injected=true">');
  await page.getByLabel('审核人', { exact: true }).fill('Browser test fixture only');
  await page.getByRole('checkbox', { name: /我已人工核验/ }).check();
  await page.getByRole('button', { name: '预览当前表单差异', exact: true }).click();
  assert.equal(await page.locator('section[aria-label="编辑详情"] img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /未提交 GitHub/);
  const approved = await detailAfterJson(page);
  assert.equal(approved.review.status, 'reviewed');
  assert.equal(approved.id, 'ins-000001');
  assert.deepEqual(validateDataset({ ...initial, instruments: initial.instruments.map((record) => record.id === approved.id ? approved : record) }), []);
  const candidate = { ...initial, instruments: initial.instruments.map((record) => record.id === approved.id ? approved : record) };
  const release = createRelease(candidate);
  const snapshot = resolve(downloads, 'browser-approved-release');
  await mkdir(snapshot);
  for (const [name, bytes] of Object.entries(release.files)) await writeFile(resolve(snapshot, name), bytes);
  const consumed = JSON.parse(execFileSync('python3', [
    'examples/consumer.py', 'NVDA', '--snapshot', snapshot, '--version', release.version,
  ], { encoding: 'utf8' }));
  assert.equal(consumed.instrument.id, approved.id);
  assert.deepEqual(consumed.tags.map((tag) => tag.id).sort(), [...approved.classification.tag_ids].sort());
  assert.equal('primary_theme' in consumed, false);
  assert.ok(release.files['vocabulary.json']);
  assert.equal('themes.json' in release.files, false);
  await page.getByLabel('英文名称', { exact: true }).fill('Corrected fixture name');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const edited = await detailAfterJson(page);
  assert.equal(edited.review.status, 'needs_review');
  await page.getByRole('group', { name: '标签（多选）', exact: true })
    .locator('input[value="us-large-cap"]').check();
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.doesNotMatch(await page.locator('#messages').textContent(), /classification/);
});

test('adding ETF uses separate attributes and keeps identity stable when type changes', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '＋ 新增证券', exact: true }).click();
  await page.getByLabel('原始代码', { exact: true }).fill('TESTF');
  await page.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('etf');
  assert.equal(await page.getByLabel('行业体系', { exact: true }).count(), 0);
  const tags = page.getByRole('group', { name: '标签（多选）', exact: true });
  await tags.locator('input[value="semiconductor-sector"]').check();
  await tags.locator('input[value="leveraged"]').check();
  await page.getByLabel('ETF 来源 ID', { exact: true }).fill('human');
  await page.getByLabel('来源证据（JSON 数组）', { exact: true }).fill(JSON.stringify([
    { id: 'human', kind: 'manual', label: 'Synthetic fixture objective', url: null, accessed_at: null, fields: ['/etf'] },
  ]));
  await page.getByLabel('杠杆倍数', { exact: true }).fill('3');
  await page.getByLabel('方向', { exact: true }).selectOption('long');
  await page.getByLabel('重置周期', { exact: true }).selectOption('daily');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const etf = await detailAfterJson(page);
  assert.equal(etf.symbol.canonical, 'TESTF');
  assert.equal(etf.security_type, 'etf');
  assert.equal(etf.etf.leverage_factor, 3);
  assert.equal(etf.industry.industry_id, null);
  assert.equal(etf.industry.industry_group_id, null);
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('stock');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const stock = await detailAfterJson(page);
  assert.equal(stock.id, etf.id);
  assert.equal(stock.etf, null);
});

test('three-level selection preserves initial values, cascades and backfills', async (t) => {
  const page = await pageForTest(t);
  const record = initial.instruments.find((item) => item.symbol.canonical === 'NVDA');
  const system = initial.vocabulary.industry_systems.find((item) => item.id === 'financedatabase');
  const software = system.industries.find((item) => item.aliases.includes('Software'));
  const otherSector = system.sectors.find((item) => item.id !== record.industry.sector_id);
  await page.getByRole('button', { name: /^NVDA$/ }).click();
  const systemControl = page.getByLabel('行业体系', { exact: true });
  const sectorControl = page.getByLabel('板块 / Sector', { exact: true });
  const groupControl = page.getByLabel('行业组 / Industry Group', { exact: true });
  const industryControl = page.getByLabel('行业 / Industry', { exact: true });
  assert.equal(await systemControl.inputValue(), record.industry.system_id);
  assert.equal(await sectorControl.inputValue(), record.industry.sector_id);
  assert.equal(await groupControl.inputValue(), record.industry.industry_group_id);
  assert.equal(await industryControl.inputValue(), record.industry.industry_id);
  await sectorControl.selectOption(record.industry.sector_id);
  assert.equal(await industryControl.inputValue(), record.industry.industry_id);
  await sectorControl.selectOption(otherSector.id);
  assert.equal(await groupControl.inputValue(), '');
  assert.equal(await industryControl.inputValue(), '');
  const allowedGroups = system.industry_groups.filter((item) => item.sector_id === otherSector.id).map((item) => item.id);
  assert.deepEqual(await groupControl.locator('option').evaluateAll((items) => items.map((item) => item.value).filter(Boolean)), allowedGroups);
  await systemControl.selectOption('yahoo');
  await systemControl.selectOption('financedatabase');
  assert.equal(await sectorControl.inputValue(), '');
  assert.equal(await groupControl.inputValue(), '');
  await industryControl.selectOption(software.id);
  assert.equal(await sectorControl.inputValue(), software.sector_id);
  assert.equal(await groupControl.inputValue(), software.industry_group_id);
  await groupControl.selectOption(software.industry_group_id);
  assert.equal(await industryControl.inputValue(), software.id);
  const otherGroup = system.industry_groups.find((item) => item.sector_id === software.sector_id && item.id !== software.industry_group_id);
  await groupControl.selectOption(otherGroup.id);
  assert.equal(await industryControl.inputValue(), '');
  await groupControl.selectOption('');
  await industryControl.selectOption(software.id);
  await page.getByLabel('行业来源 ID', { exact: true }).fill('');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /standard industry needs its own source/);
  await page.getByLabel('行业来源 ID', { exact: true }).fill(record.industry.source_ids.join(', '));
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已通过校验/);
  const edited = await detailAfterJson(page);
  assert.equal(edited.schema_version, '4.0.0');
  assert.equal(edited.industry.industry_id, software.id);
  assert.equal(edited.industry.industry_group_id, software.industry_group_id);
  assert.deepEqual(edited.classification, record.classification);
  assert.deepEqual(edited.sources, record.sources);
  assert.deepEqual(validateDataset({
    ...initial,
    instruments: initial.instruments.map((item) => item.id === edited.id ? edited : item),
  }), []);
});

test('empty records allow no classification, Yahoo needs no group and ETF clears all hierarchy fields', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '＋ 新增证券', exact: true }).click();
  const systemControl = page.getByLabel('行业体系', { exact: true });
  const groupControl = page.getByLabel('行业组 / Industry Group', { exact: true });
  assert.equal(await systemControl.inputValue(), '');
  assert.equal(await systemControl.locator('option').nth(1).getAttribute('value'), 'financedatabase');
  await page.getByLabel('原始代码', { exact: true }).fill('HIERARCHY');
  await page.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const blank = await detailAfterJson(page);
  assert.deepEqual(blank.industry, { system_id: null, sector_id: null, industry_group_id: null, industry_id: null, source_ids: [] });
  await systemControl.selectOption('yahoo');
  assert.equal(await groupControl.isDisabled(), true);
  assert.match(await groupControl.textContent(), /此体系无行业组/);
  await page.getByLabel('行业 / Industry', { exact: true }).selectOption('semiconductors');
  assert.equal(await page.getByLabel('板块 / Sector', { exact: true }).inputValue(), 'technology');
  await page.getByLabel('行业来源 ID', { exact: true }).fill('human');
  await page.getByLabel('来源证据（JSON 数组）', { exact: true }).fill(JSON.stringify([
    { id: 'human', kind: 'manual', label: 'Synthetic hierarchy fixture', url: null, accessed_at: null, fields: ['/industry'] },
  ]));
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const yahoo = await detailAfterJson(page);
  assert.equal(yahoo.industry.system_id, 'yahoo');
  assert.equal(yahoo.industry.industry_group_id, null);
  assert.equal(yahoo.industry.industry_id, 'semiconductors');
  await systemControl.selectOption('financedatabase');
  const system = initial.vocabulary.industry_systems.find((item) => item.id === 'financedatabase');
  await page.getByLabel('行业 / Industry', { exact: true }).selectOption(system.industries[0].id);
  assert.notEqual(await groupControl.inputValue(), '');
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('etf');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const etf = await detailAfterJson(page);
  assert.deepEqual(etf.industry, blank.industry);
  assert.deepEqual(etf.classification, yahoo.classification);
  assert.equal(etf.id, yahoo.id);
});

test('industry vocabulary is browsable in three levels and group edits flag reviewed references', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA$/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Synthetic hierarchy fixture');
  await page.getByLabel('MIC 交易场所代码', { exact: true }).fill('XNAS');
  await page.getByLabel('审核人', { exact: true }).fill('Synthetic hierarchy reviewer');
  await page.getByRole('checkbox', { name: /我已人工核验/ }).check();
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已通过校验/);
  await page.getByRole('button', { name: '标签 / 行业词表', exact: true }).click();
  await page.getByRole('button', { name: '行业体系', exact: true }).click();
  await vocabularyRow(page, 'financedatabase').locator('.record-button').click();
  assert.match(await page.locator('.industry-tree > summary').textContent(), /11 板块 \/ 24 行业组 \/ 69 行业/);
  await page.locator('.industry-tree > details > summary').first().click();
  await page.locator('.industry-tree > details').first().locator('details > summary').first().click();
  assert.ok(await page.locator('.industry-tree li:visible').count() > 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const vocabulary = JSON.parse(JSON.stringify(initial.vocabulary));
  vocabulary.industry_systems.find((item) => item.id === 'financedatabase').industry_groups[0].description += ' Synthetic reviewed change.';
  await page.getByText('高级：编辑完整词表 JSON（含行业体系 / 板块 / 行业组 / 行业）', { exact: true }).click();
  await page.getByLabel('完整 vocabulary.json', { exact: true }).fill(stableStringify(vocabulary));
  await page.getByRole('button', { name: '校验并保存完整词表草稿', exact: true }).click();
  const savedVocabulary = await detailAfterJson(page);
  assert.deepEqual(savedVocabulary, vocabulary);
  assert.match(await page.getByText('data/instruments/ins-000001.json', { exact: true }).textContent(), /ins-000001/);
  await page.getByRole('button', { name: '关闭编辑面板', exact: true }).last().click();
  await page.getByRole('button', { name: '＋ 新增词条', exact: true }).click();
  const newId = page.getByLabel('稳定 ID（新建后不可修改）', { exact: true });
  assert.equal(await newId.isEditable(), true);
  await newId.fill('Synthetic Industry');
  await page.getByLabel('中文显示名称', { exact: true }).fill('Synthetic industry system');
  await page.getByRole('button', { name: '校验并保存词条草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /稳定 ID 格式无效/);
  await newId.fill('financedatabase');
  await page.getByRole('button', { name: '校验并保存词条草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /稳定 ID 已存在/);
  await newId.fill('synthetic-industry-system');
  await page.getByRole('button', { name: '校验并保存词条草稿', exact: true }).click();
  const saved = await detailAfterJson(page);
  const added = saved.industry_systems.find((item) => item.name_zh === 'Synthetic industry system');
  assert.equal(added.id, 'synthetic-industry-system');
  assert.deepEqual(added.industry_groups, []);
  assert.deepEqual(added.sectors, []);
  assert.deepEqual(added.industries, []);
  assert.equal(await page.getByLabel('稳定 ID（不可修改）', { exact: true }).isEditable(), false);
});

test('tag rename, referenced deletion and atomic merge stay safe in one PR draft', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '标签 / 行业词表', exact: true }).click();
  assert.deepEqual(
    await vocabularyRow(page, 'semiconductor-ai').locator('.record-button').allTextContents(),
    ['半导体/AI'],
  );
  await vocabularyRow(page, 'semiconductor-ai').locator('.record-button').click();
  await page.getByLabel('中文显示名称', { exact: true }).fill('合成测试标签');
  await page.getByRole('button', { name: '校验并保存词条草稿', exact: true }).click();
  const renamed = await detailAfterJson(page);
  assert.equal(renamed.tags.find((tag) => tag.id === 'semiconductor-ai').name_zh, '合成测试标签');
  await page.getByRole('button', { name: '删除未被引用词条', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /拒绝删除/);
  await page.getByLabel('将当前词条并入', { exact: true }).selectOption('ai-cloud');
  await page.getByRole('button', { name: '预览并合并到目标 ID', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已原子合并/);
  const merged = await detailAfterJson(page);
  assert.equal(merged.tags.some((tag) => tag.id === 'semiconductor-ai'), false);
  assert.ok(merged.tags.find((tag) => tag.id === 'ai-cloud').aliases.includes('合成测试标签'));
  assert.equal(await page.getByText('data/instruments/ins-000001.json', { exact: true }).count(), 1);
  assert.equal(await page.getByText('data/instruments/ins-000002.json', { exact: true }).count(), 1);
  await vocabularyRow(page, 'satellite-communication').locator('.record-button').click();
  await page.getByRole('button', { name: '删除未被引用词条', exact: true }).click();
  const deleted = await detailAfterJson(page);
  assert.equal(deleted.tags.some((tag) => tag.id === 'satellite-communication'), false);
});

test('unsaved navigation cancellation retains edits and no import control exists', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA$/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Unsaved fixture');
  page.removeAllListeners('dialog');
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: /^CRWV$/ }).click();
  assert.equal(await page.getByLabel('英文名称', { exact: true }).inputValue(), 'Unsaved fixture');
  assert.equal(await page.locator('input[type=file]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /导入/ }).count(), 0);
  assert.equal(await page.getByLabel('英文名称', { exact: true }).inputValue(), 'Unsaved fixture');
});
