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
import { prepareImport } from '../scripts/import.js';
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
    const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
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

test('only tags and industry remain in the UI and multi-select tags save, export and reimport', async (t) => {
  const source = createDatasetFixture();
  source.instruments[0].sources.find((item) => item.id === 'manual-example').label = 'Synthetic historical 主主题 evidence, preserved verbatim.';
  const page = await pageForTest(t, {}, source);
  assert.equal(await page.getByLabel('主主题', { exact: true }).count(), 0);
  assert.equal(await page.locator('.badge').filter({ hasText: '未分类' }).count(), 0);
  await page.getByLabel('标签', { exact: true }).selectOption('ai');
  assert.equal(await page.locator('aside .record-button').count(), 2);
  await page.getByLabel('标签', { exact: true }).selectOption('');
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  assert.equal(await page.getByLabel('主主题（单选）', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '主题 / 标签 / 行业词表', exact: true }).count(), 0);
  assert.doesNotMatch((await page.locator('form legend').allTextContents()).join('\n'), /主主题|交易主题|与主题独立/);
  assert.match(await page.getByLabel('来源证据（JSON 数组）', { exact: true }).inputValue(), /historical 主主题 evidence/);
  const selection = ['ai', 'semiconductor-ai', 'digital-assets'];
  await page.getByLabel('标签（多选）', { exact: true }).selectOption(selection);
  assert.match(await page.locator('#form-state').textContent(), /未保存修改/);
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const exported = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(exported.schema_version, '3.0.0');
  assert.deepEqual([...exported.classification.tag_ids].sort(), selection.sort());
  assert.deepEqual(Object.keys(exported.classification).sort(), ['source_ids', 'tag_ids']);
  assert.deepEqual(exported.industry, initial.instruments[0].industry);
  assert.deepEqual(exported.sources, source.instruments[0].sources);
  await page.reload();
  await page.locator('input[type=file]').setInputFiles({
    name: `${exported.id}.json`, mimeType: 'application/json', buffer: Buffer.from(stableStringify(exported)),
  });
  await page.getByText('导入内容已通过全数据集校验。', { exact: false }).waitFor();
  assert.deepEqual(await page.getByLabel('标签（多选）', { exact: true }).evaluate((select) =>
    [...select.selectedOptions].map((option) => option.value).sort()), selection);
  assert.deepEqual(await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true })), exported);
  await page.getByRole('button', { name: '标签 / 行业词表', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '主主题', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '主题、标签与标准行业词表', exact: true }).count(), 0);
  await page.getByRole('button', { name: '行业体系', exact: true }).click();
  await page.locator('aside .record-button').first().click();
  assert.equal(await page.getByLabel('将当前词条并入', { exact: true }).count(), 0);
});

test('reviewers can explicitly approve records without tags or classification evidence', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^TSLA ·/ }).click();
  const original = initial.instruments.find((record) => record.symbol.canonical === 'TSLA');
  assert.deepEqual(original.classification, { tag_ids: [], source_ids: [] });
  await page.getByLabel('MIC 交易场所代码', { exact: true }).fill('XNAS');
  await page.getByLabel('审核人', { exact: true }).fill('Synthetic optional-tag reviewer');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已通过校验/);
  const reviewed = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(reviewed.review.status, 'reviewed');
  assert.equal(reviewed.review.reviewer, 'Synthetic optional-tag reviewer');
  assert.ok(Number.isFinite(Date.parse(reviewed.review.reviewed_at)));
  assert.deepEqual(reviewed.classification, original.classification);
  assert.deepEqual(reviewed.industry, original.industry);
  assert.deepEqual(reviewed.sources, original.sources);
  assert.deepEqual(validateDataset({ ...initial, instruments: [reviewed] }), []);
  assert.deepEqual(JSON.parse(createRelease({ ...initial, instruments: [reviewed] }).files['instruments.json']).instruments, [reviewed]);
});

test('v1 and v2 record, vocabulary and bundle imports fail with migration instructions without changing drafts', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  for (const version of ['1.0.0', '2.0.0']) {
    for (const payload of [initial.instruments[0], initial.vocabulary, initial]) {
      await page.getByRole('button', { name: /^NVDA ·/ }).click();
      await page.locator('input[type=file]').setInputFiles({
        name: 'legacy.json', mimeType: 'application/json',
        buffer: Buffer.from(stableStringify({ ...payload, schema_version: version })),
      });
      await page.locator('#messages.error').waitFor();
      assert.match(await page.locator('#messages').textContent(), /npm run migrate -- legacy.json/);
      assert.equal(await page.getByLabel('英文名称', { exact: true }).inputValue(), initial.instruments[0].name.en);
    }
  }
  assert.deepEqual(await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true })), initial.instruments[0]);
});

test('current built maintenance source loads and exports without assuming sample counts or review states', async (t) => {
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
    const exported = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
    assert.deepEqual(exported, record);
  }
});

test('record utility links and normalization share a compact responsive action row', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^BRK.B ·/ }).click();
  const actions = page.getByRole('group', { name: '证券操作', exact: true });
  const normalize = actions.getByRole('button', { name: '由原始代码填入规范代码', exact: true });
  assert.equal(await actions.getByRole('link').count(), 3);
  assert.equal(await normalize.getAttribute('type'), 'button');
  assert.equal(await page.locator('form').getByRole('button', { name: '由原始代码填入规范代码', exact: true }).count(), 0);
  for (const [index, label] of ['源文件', '在 GitHub 编辑', '提交历史'].entries()) {
    const link = actions.getByRole('link', { name: label, exact: true });
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.ok((await link.getAttribute('href')).endsWith('data/instruments/ins-000010.json'));
    await link.focus();
    await page.keyboard.press('Tab');
    assert.equal(await actions.locator('a, button').nth(index + 1).evaluate((item) => item === document.activeElement), true);
  }
  const layout = await actions.locator('a, button').evaluateAll((items) => items.map((item) => {
    const rect = item.getBoundingClientRect();
    const style = getComputedStyle(item);
    return { top: rect.top, height: rect.height, fontSize: style.fontSize, padding: style.padding, border: style.border, background: style.backgroundColor };
  }));
  assert.equal(layout.length, 4);
  for (const item of layout) assert.deepEqual(item, layout[0]);
  assert.ok(layout[0].height <= 40);
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'BRK.B');
  await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'BRK-B');
  assert.match(await page.locator('#form-state').textContent(), /未保存修改/);
  await page.getByLabel('原始代码', { exact: true }).fill('  brk-b  ');
  await normalize.click();
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'BRK-B');
  assert.equal(await page.locator('#messages').textContent(), '');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const bounds = await actions.locator('a, button').evaluateAll((items) => items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right, fits: item.scrollWidth <= item.clientWidth };
    }));
    assert.ok(bounds.every((item) => item.left >= 0 && item.right <= width && item.fits), JSON.stringify(bounds));
    assert.equal(await actions.evaluate((item) => item.scrollWidth <= item.clientWidth), true);
    assert.ok(await normalize.isVisible());
    assert.equal(await actions.evaluate((item) => getComputedStyle(item).flexWrap), 'wrap');
  }
});

test('normalization remains available for new records and unconfigured GitHub links', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '＋ 新增证券', exact: true }).click();
  let actions = page.getByRole('group', { name: '证券操作', exact: true });
  assert.equal(await actions.getByRole('link').count(), 1);
  await page.getByLabel('原始代码', { exact: true }).fill(' new.test ');
  await actions.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'NEW.TEST');
  await page.route(`${origin}/site-config.json`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ repository_url: null, branch: 'main', pages_enabled: false }),
  }));
  await page.reload();
  await page.getByRole('button', { name: /^CRWV ·/ }).click();
  actions = page.getByRole('group', { name: '证券操作', exact: true });
  assert.equal(await actions.getByRole('link').count(), 0);
  await actions.getByRole('button', { name: '由原始代码填入规范代码', exact: true }).click();
  assert.equal(await page.getByLabel('规范代码', { exact: true }).inputValue(), 'CRWV');
  assert.match(await page.locator('#form-state').textContent(), /未保存修改/);
});

test('direct PR submission form appears after edits and keeps export fallback', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Direct PR flow fixture');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  await page.getByText('直接提交 PR（无需先下载再上传）', { exact: true }).click();
  assert.equal(await page.getByLabel('新分支名', { exact: true }).inputValue() !== '', true);
  assert.equal(await page.getByLabel('提交信息（commit message）', { exact: true }).inputValue() !== '', true);
  assert.equal(await page.getByLabel('PR 标题', { exact: true }).inputValue() !== '', true);
  assert.match(await page.getByLabel('PR 描述', { exact: true }).inputValue(), /变更文件/);
  await page.getByLabel('GitHub Token（仅本页内存，提交后即清空）', { exact: true }).fill('fixture-token');
  await page.getByRole('button', { name: '提交 PR', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /请先确认本次将提交全部变更文件/);
  await page.getByRole('checkbox', { name: /我已确认将一次性提交以上/ }).check();
  assert.equal(await page.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }).count(), 1);
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
      await page.getByRole('button', { name: /^NVDA ·/ }).click();
      assert.equal(await page.locator('section[aria-label="编辑详情"]').getByLabel('审核状态', { exact: true }).inputValue(), 'reviewed');
      assert.equal(await page.getByRole('checkbox').isChecked(), false);
      await page.getByLabel('英文名称', { exact: true }).fill('Synthetic edited startup record');
      if (explicit) {
        await page.getByLabel('审核人', { exact: true }).fill('Synthetic replacement reviewer');
        await page.getByRole('checkbox').check();
      }
      await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
      const edited = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
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
  assert.deepEqual(consumed.tags.map((tag) => tag.id).sort(), [...approved.classification.tag_ids].sort());
  assert.equal('primary_theme' in consumed, false);
  assert.ok(release.files['vocabulary.json']);
  assert.equal('themes.json' in release.files, false);
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
  await page.getByLabel('标签（多选）', { exact: true }).selectOption(['semiconductor-sector', 'leveraged']);
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
  assert.equal(etf.industry.industry_group_id, null);
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('stock');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const stock = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(stock.id, etf.id);
  assert.equal(stock.etf, null);
});

test('three-level selection preserves initial values, cascades, backfills and round-trips through export/import', async (t) => {
  const page = await pageForTest(t);
  const record = initial.instruments.find((item) => item.symbol.canonical === 'NVDA');
  const system = initial.vocabulary.industry_systems.find((item) => item.id === 'financedatabase');
  const software = system.industries.find((item) => item.aliases.includes('Software'));
  const otherSector = system.sectors.find((item) => item.id !== record.industry.sector_id);
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
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
  const edited = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(edited.schema_version, '3.0.0');
  assert.equal(edited.industry.industry_id, software.id);
  assert.equal(edited.industry.industry_group_id, software.industry_group_id);
  assert.deepEqual(edited.classification, record.classification);
  assert.deepEqual(edited.sources, record.sources);
  await page.reload();
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  assert.equal(await industryControl.inputValue(), record.industry.industry_id);
  await page.locator('input[type=file]').setInputFiles({
    name: `${edited.id}.json`, mimeType: 'application/json', buffer: Buffer.from(stableStringify(edited)),
  });
  await page.getByText('导入内容已通过全数据集校验。', { exact: false }).waitFor();
  assert.equal(await groupControl.inputValue(), software.industry_group_id);
  assert.equal(await industryControl.inputValue(), software.id);
  const bundle = await downloadJson(page, page.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.equal(bundle.schema_version, '3.0.0');
  assert.deepEqual(bundle.vocabulary, initial.vocabulary);
  assert.deepEqual(bundle.instruments.find((item) => item.id === edited.id), edited);
  assert.deepEqual(validateDataset(bundle), []);
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
  const blank = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
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
  const yahoo = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.equal(yahoo.industry.system_id, 'yahoo');
  assert.equal(yahoo.industry.industry_group_id, null);
  assert.equal(yahoo.industry.industry_id, 'semiconductors');
  await systemControl.selectOption('financedatabase');
  const system = initial.vocabulary.industry_systems.find((item) => item.id === 'financedatabase');
  await page.getByLabel('行业 / Industry', { exact: true }).selectOption(system.industries[0].id);
  assert.notEqual(await groupControl.inputValue(), '');
  await page.locator('section[aria-label="编辑详情"]').getByLabel('证券类型', { exact: true }).selectOption('etf');
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  const etf = await downloadJson(page, page.getByRole('button', { name: '导出已保存的单条 JSON', exact: true }));
  assert.deepEqual(etf.industry, blank.industry);
  assert.deepEqual(etf.classification, yahoo.classification);
  assert.equal(etf.id, yahoo.id);
});

test('industry vocabulary is browsable in three levels and group edits flag reviewed references', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: /^NVDA ·/ }).click();
  await page.getByLabel('英文名称', { exact: true }).fill('Synthetic hierarchy fixture');
  await page.getByLabel('MIC 交易场所代码', { exact: true }).fill('XNAS');
  await page.getByLabel('审核人', { exact: true }).fill('Synthetic hierarchy reviewer');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '校验并保存内存草稿', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已通过校验/);
  await page.getByRole('button', { name: '标签 / 行业词表', exact: true }).click();
  await page.getByRole('button', { name: '行业体系', exact: true }).click();
  await page.locator('aside .record-button').filter({ hasText: 'financedatabase' }).click();
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
  const bundle = await downloadJson(page, page.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.equal(bundle.instruments.find((item) => item.symbol.canonical === 'NVDA').review.status, 'needs_review');
  assert.deepEqual(bundle.vocabulary, vocabulary);
  assert.deepEqual(validateDataset(bundle), []);
  await page.getByRole('button', { name: '＋ 新增词条', exact: true }).click();
  await page.getByLabel('中文显示名称', { exact: true }).fill('Synthetic industry system');
  await page.getByRole('button', { name: '校验并保存词条草稿', exact: true }).click();
  const saved = await downloadJson(page, page.getByRole('button', { name: '导出已保存词表 JSON', exact: true }));
  const added = saved.industry_systems.find((item) => item.name_zh === 'Synthetic industry system');
  assert.deepEqual(added.industry_groups, []);
  assert.deepEqual(added.sectors, []);
  assert.deepEqual(added.industries, []);
});

test('tag rename and referenced deletion stay safe and merged bundles round-trip through browser import', async (t) => {
  const page = await pageForTest(t);
  await page.getByRole('button', { name: '标签 / 行业词表', exact: true }).click();
  await page.locator('aside .record-button').filter({ hasText: 'semiconductor-ai' }).click();
  await page.getByLabel('中文显示名称', { exact: true }).fill('合成测试标签');
  await page.getByRole('button', { name: '校验并保存词条草稿', exact: true }).click();
  const renamed = await downloadJson(page, page.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.equal(renamed.vocabulary.tags.find((tag) => tag.id === 'semiconductor-ai').name_zh, '合成测试标签');
  assert.deepEqual(renamed.instruments[0].classification, initial.instruments[0].classification);
  assert.equal(renamed.instruments[0].review.status, 'needs_review');
  await page.getByRole('button', { name: '删除未被引用词条', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /拒绝删除/);
  await page.getByLabel('将当前词条并入', { exact: true }).selectOption('ai-cloud');
  await page.getByRole('button', { name: '预览并合并到目标 ID', exact: true }).click();
  assert.match(await page.locator('#messages').textContent(), /已原子合并/);
  const bundle = await downloadJson(page, page.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.equal(bundle.instruments.length, 17);
  assert.equal(bundle.vocabulary.tags.some((tag) => tag.id === 'semiconductor-ai'), false);
  assert.deepEqual(bundle.instruments.find((record) => record.id === 'ins-000001').classification.tag_ids, ['ai', 'ai-cloud']);
  assert.ok(bundle.vocabulary.tags.find((tag) => tag.id === 'ai-cloud').aliases.includes('合成测试标签'));
  assert.equal(bundle.instruments.find((record) => record.id === 'ins-000002').review.status, 'needs_review');
  assert.deepEqual(validateDataset(bundle), []);
  const importedPage = await pageForTest(t);
  await importedPage.locator('input[type=file]').setInputFiles({
    name: 'tickerdata-maintenance-bundle.json', mimeType: 'application/json', buffer: Buffer.from(stableStringify(bundle)),
  });
  await importedPage.getByText('导入内容已通过全数据集校验。', { exact: false }).waitFor();
  const imported = await downloadJson(importedPage, importedPage.getByRole('button', { name: '导出完整维护包（全部源记录及词表）', exact: true }));
  assert.deepEqual(imported, bundle);
  await page.locator('aside .record-button').filter({ hasText: 'satellite-communication' }).click();
  await page.getByRole('button', { name: '删除未被引用词条', exact: true }).click();
  const deleted = await downloadJson(page, page.getByRole('button', { name: '导出已保存词表 JSON', exact: true }));
  assert.equal(deleted.tags.some((tag) => tag.id === 'satellite-communication'), false);
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
