const app = document.querySelector('#app');
const typeNames = { stock: '股票', etf: 'ETF', other: '其他' };
const state = {
  instruments: [],
  vocabulary: null,
  manifest: null,
  filters: { query: '', type: '', mic: '', industry: '', tag: '' },
};
let sequence = 0;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function option(value, text) {
  const element = node('option', text);
  element.value = value;
  return element;
}

function field(parent, label, control) {
  const wrapper = node('div', null, 'field');
  const title = node('label', label);
  control.id = `catalog-filter-${++sequence}`;
  title.htmlFor = control.id;
  wrapper.append(title, control);
  parent.append(wrapper);
}

function choices(values, placeholder) {
  const control = node('select');
  control.append(option('', placeholder));
  for (const [value, label] of values) control.append(option(value, label));
  return control;
}

function vocabularyMaps() {
  const tags = new Map(state.vocabulary.tags.map((item) => [item.id, item.name_zh]));
  const industries = new Map();
  for (const system of state.vocabulary.industry_systems) {
    for (const item of system.industries) industries.set(`${system.id}:${item.id}`, item.name_zh);
  }
  return { tags, industries };
}

function industryName(record, industries) {
  if (!record.industry?.industry_id) return '—';
  return industries.get(`${record.industry.system_id}:${record.industry.industry_id}`) ?? record.industry.industry_id;
}

function industryKey(record) {
  return record.industry?.industry_id ? `${record.industry.system_id}:${record.industry.industry_id}` : '';
}

function matches(record, maps) {
  const query = state.filters.query.trim().toLocaleLowerCase();
  const searchable = [
    record.id,
    record.symbol.original,
    record.symbol.canonical,
    record.symbol.mic,
    record.name.en,
    record.name.zh,
    ...record.symbol.aliases.flatMap((item) => [item.symbol, item.provider]),
    ...record.symbol.history.flatMap((item) => [item.symbol, item.mic]),
    ...record.classification.tag_ids.map((id) => maps.tags.get(id) ?? id),
    industryName(record, maps.industries),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  return (!query || searchable.includes(query)) &&
    (!state.filters.type || record.security_type === state.filters.type) &&
    (!state.filters.mic || record.symbol.mic === state.filters.mic) &&
    (!state.filters.industry || industryKey(record) === state.filters.industry) &&
    (!state.filters.tag || record.classification.tag_ids.includes(state.filters.tag));
}

function renderTable(container) {
  const maps = vocabularyMaps();
  const records = state.instruments.filter((record) => matches(record, maps));
  const summary = node('div', null, 'summary');
  summary.append(node('strong', `${records.length} 条结果`), node('span', `共 ${state.instruments.length} 条已审核标的`));
  container.append(summary);

  if (!records.length) {
    container.append(node('p', '没有匹配的标的，请调整筛选条件。', 'empty'));
    return;
  }

  const shell = node('div', null, 'table-shell');
  const table = node('table');
  const head = node('thead');
  const headings = node('tr');
  for (const title of ['证券代码', '名称', '交易所', '类型', '行业', '标签']) headings.append(node('th', title));
  head.append(headings);
  const body = node('tbody');
  for (const record of records) {
    const row = node('tr');
    const symbol = node('td');
    symbol.append(node('div', record.symbol.canonical, 'symbol'));
    if (record.symbol.original !== record.symbol.canonical) symbol.append(node('div', `原始代码：${record.symbol.original}`, 'secondary'));
    const name = node('td');
    name.append(node('div', record.name.zh || record.name.en || '—'));
    if (record.name.zh && record.name.en) name.append(node('div', record.name.en, 'secondary'));
    const tags = node('td');
    const tagList = node('div', null, 'tags');
    for (const id of record.classification.tag_ids) tagList.append(node('span', maps.tags.get(id) ?? id, 'tag'));
    tags.append(tagList.childElementCount ? tagList : node('span', '—'));
    for (const value of [
      symbol,
      name,
      node('td', record.symbol.mic ?? '—'),
      node('td', typeNames[record.security_type] ?? record.security_type),
      node('td', industryName(record, maps.industries)),
      tags,
    ]) row.append(value);
    body.append(row);
  }
  table.append(head, body);
  shell.append(table);
  container.append(shell);
}

function render() {
  const maps = vocabularyMaps();
  const catalog = node('section', null, 'catalog');
  catalog.setAttribute('aria-label', '已审核标的目录');
  const filters = node('div', null, 'filters');
  const search = node('input');
  search.type = 'search';
  search.placeholder = '代码、名称、别名、行业或标签';
  search.value = state.filters.query;
  field(filters, '搜索', search);

  const type = choices(Object.entries(typeNames), '全部类型');
  const mics = [...new Set(state.instruments.map((record) => record.symbol.mic).filter(Boolean))].sort();
  const mic = choices(mics.map((value) => [value, value]), '全部交易所');
  const industryItems = [...new Map(state.instruments
    .filter((record) => record.industry?.industry_id)
    .map((record) => [industryKey(record), industryName(record, maps.industries)]))]
    .sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  const industry = choices(industryItems, '全部行业');
  const usedTags = new Set(state.instruments.flatMap((record) => record.classification.tag_ids));
  const tag = choices(state.vocabulary.tags
    .filter((item) => usedTags.has(item.id))
    .map((item) => [item.id, item.name_zh]), '全部标签');
  for (const [key, label, control] of [
    ['type', '证券类型', type],
    ['mic', '交易所', mic],
    ['industry', '行业', industry],
    ['tag', '标签', tag],
  ]) {
    control.value = state.filters[key];
    control.addEventListener('change', () => {
      state.filters[key] = control.value;
      render();
    });
    field(filters, label, control);
  }
  search.addEventListener('input', () => {
    state.filters.query = search.value;
    render();
    document.querySelector('input[type="search"]')?.focus();
  });
  catalog.append(filters);
  renderTable(catalog);

  const generated = state.manifest.generated_at ? new Date(state.manifest.generated_at).toLocaleString('zh-CN') : '未知';
  const downloads = node('p', null, 'downloads');
  downloads.append(
    document.createTextNode(`数据版本 ${state.manifest.data_version.slice(0, 12)} · 生成于 ${generated} · `),
    Object.assign(node('a', '下载 JSON'), { href: './latest/instruments.json' }),
  );
  app.replaceChildren(catalog, downloads);
}

async function json(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} 加载失败（HTTP ${response.status}）`);
  return response.json();
}

try {
  const [instrumentData, vocabulary, manifest] = await Promise.all([
    json('./latest/instruments.json'),
    json('./latest/vocabulary.json'),
    json('./latest/manifest.json'),
  ]);
  state.instruments = [...instrumentData.instruments].sort((a, b) =>
    a.symbol.canonical.localeCompare(b.symbol.canonical, 'en'));
  state.vocabulary = vocabulary;
  state.manifest = manifest;
  render();
} catch (error) {
  app.replaceChildren(node('p', `标的目录加载失败：${error.message}`, 'error'));
}
