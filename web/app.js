import { validateDataset, validateReviewTransitions } from '../src/validation.js';
import { SCHEMA_VERSION, emptyInstrument, emptyEtf, stableStringify, normalizeSymbol } from '../src/model.js';
import { clone, matchesRecord, prepareRecord, references, applyVocabulary, mergeVocabulary, changedFiles, githubLinks, prepareImportedDataset, downgradeRelatedReviews, industryChoices, changeIndustrySelection } from './editor-model.js';

const app = document.querySelector('#app');
const state = {
  initial: null, dataset: null, config: null, mode: 'records', selected: null,
  vocabKind: 'themes', vocabId: null, dirty: false,
  filters: { query: '', type: '', theme: '', tag: '', review: '' },
  exported: new Map(),
};
const reviewNames = { pending: '待审核', needs_review: '需复核', reviewed: '已人工审核' };
const typeNames = { stock: '股票', etf: 'ETF', other: '其他' };
let messages;
let detail;
let list;
let readRecord;
let draftRecord;
let sequence = 0;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, action, className = '') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', () => attempt(action));
  return element;
}

function attempt(action) {
  try { action(); } catch (error) { report(error.message || String(error), true); }
}

function report(text, error = false) {
  messages.textContent = text;
  messages.className = error ? 'error' : 'success';
  if (error) messages.focus();
}

function markDirty() {
  state.dirty = true;
  const status = document.querySelector('#form-state');
  if (status) status.textContent = '表单有未保存修改 · 尚未校验，未进入内存草稿';
}

function mayLeave() {
  return !state.dirty || window.confirm('当前表单尚未保存。确定放弃这些修改？已保存的内存草稿不会丢失。');
}

function navigate(action) {
  if (!mayLeave()) return;
  state.dirty = false;
  draftRecord = null;
  action();
  render();
}

function validate(candidate) {
  const errors = validateDataset(candidate);
  if (errors.length) throw new Error(`未保存 / 未导出。请修正以下问题：\n${errors.join('\n')}`);
}

function commit(candidate, message) {
  validate(candidate);
  const transitionErrors = validateReviewTransitions(state.initial, candidate);
  if (transitionErrors.length) throw new Error(`审核变更校验失败：\n${transitionErrors.join('\n')}`);
  state.dataset = clone(candidate);
  state.dirty = false;
  draftRecord = null;
  render();
  report(`${message}\n仅保存在当前页面的内存中；未提交 GitHub，也未发布。`);
}

function options(select, items, value = '', placeholder = '未填写') {
  select.replaceChildren();
  if (!select.multiple) {
    const option = node('option', placeholder);
    option.value = '';
    select.append(option);
  }
  for (const item of items) {
    const option = node('option', item.name_zh ?? item.label ?? item.id);
    option.value = item.id;
    option.selected = Array.isArray(value) ? value.includes(item.id) : item.id === value;
    select.append(option);
  }
  if (!select.multiple) select.value = value ?? '';
}

function field(parent, title, control, hint) {
  const wrapper = node('div', null, 'field');
  const label = node('label', title);
  control.id ||= `field-${++sequence}`;
  label.htmlFor = control.id;
  wrapper.append(label, control);
  if (hint) {
    const help = node('span', hint, 'hint');
    help.id = `${control.id}-hint`;
    control.setAttribute('aria-describedby', help.id);
    wrapper.append(help);
  }
  parent.append(wrapper);
  return control;
}

function input(parent, title, value, hint, multiline = false) {
  const control = node(multiline ? 'textarea' : 'input');
  if (!multiline) control.type = 'text';
  control.value = value ?? '';
  control.addEventListener('input', markDirty);
  return field(parent, title, control, hint);
}

function selectField(parent, title, items, value, hint, multiple = false) {
  const control = node('select');
  control.multiple = multiple;
  options(control, items, value);
  control.addEventListener('change', markDirty);
  return field(parent, title, control, hint);
}

function section(parent, title) {
  const box = node('fieldset');
  box.append(node('legend', title));
  const grid = node('div', null, 'grid');
  box.append(grid);
  parent.append(box);
  return grid;
}

const nullable = (value) => value.trim() || null;
const ids = (value) => [...new Set(value.split(/[,\n，]/).map((item) => item.trim()).filter(Boolean))];
const enumItems = (values, labels = {}) => values.map((id) => ({ id, label: labels[id] ?? id }));
const sourceHint = '填写下方来源证据的 ID，用英文逗号或换行分隔。该来源的 fields 必须包含对应字段路径。';

function links(parent, path, exists = true) {
  const items = githubLinks(state.config, path, exists);
  if (!items.length) {
    parent.append(node('p', '未配置有效 GitHub 仓库地址：请手动将导出文件放入仓库。', 'muted'));
    return;
  }
  const group = node('div', null, 'links');
  for (const [label, url] of items) {
    const link = node('a', label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    group.append(link);
  }
  parent.append(group);
  if (!exists) parent.append(node('p', '此 ID 尚不在已加载源数据中；新建链接只预填文件路径，需自行粘贴 JSON。', 'hint'));
}

function diff(parent, before, after) {
  const box = node('details');
  box.append(node('summary', '查看差异：初始加载的源文件 → 当前内容（完整文本对照）'));
  const columns = node('div', null, 'diff');
  for (const [label, value] of [['修改前 · 初始源文件', before], ['修改后 · 当前内容', after]]) {
    const column = node('div');
    column.append(node('h3', label), node('pre', value === undefined ? '（新增文件，初始源数据中不存在）' : stableStringify(value)));
    columns.append(column);
  }
  box.append(columns);
  parent.append(box);
}

function assertExportable() {
  if (state.dirty) throw new Error('表单仍有未保存内容。请先校验并保存草稿，或明确放弃修改，再导出。');
  validate(state.dataset);
  const transitionErrors = validateReviewTransitions(state.initial, state.dataset);
  if (transitionErrors.length) throw new Error(`审核变更校验失败：\n${transitionErrors.join('\n')}`);
}

function download(filename, value) {
  const blob = new Blob([stableStringify(value)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = node('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFile(path, content) {
  assertExportable();
  const files = changedFiles(state.initial, state.dataset);
  if (files.length > 1 && !window.confirm(`共有 ${files.length} 个变更文件。单文件可能依赖其他草稿；请同时导出并在同一提交中应用完整清单，或使用完整维护包。继续下载此单文件？`)) return;
  download(path.split('/').at(-1), content);
  state.exported.set(path, stableStringify(content));
  render();
  report(`已触发下载 ${path}。请确认浏览器下载成功；导出 ≠ 提交 ≠ 发布。`);
}

function renderExports(parent) {
  const files = changedFiles(state.initial, state.dataset);
  const panel = node('details', null, 'panel');
  panel.open = files.length > 0;
  panel.append(node('summary', `内存草稿 / 完整变更清单：${files.length} 个文件`));
  panel.append(node('p', '所有草稿只存在于此页面内存。下载不会清除草稿。刷新、关闭或重新加载页面会丢失全部草稿；请先导出。', 'warning'));
  if (!files.length) panel.append(node('p', '当前没有已保存的本地草稿。', 'muted'));
  const fileList = node('ul', null, 'file-list');
  for (const file of files) {
    const item = node('li');
    item.append(node('code', file.path), node('span', state.exported.get(file.path) === stableStringify(file.content) ? ' · 已触发此版本下载，未确认提交 ' : ' · 未导出此版本 '));
    item.append(button('下载 JSON', () => exportFile(file.path, file.content)));
    fileList.append(item);
  }
  panel.append(fileList);
  if (files.length) {
    panel.append(button('导出完整维护包（全部源记录及词表）', () => {
      assertExportable();
      download('tickerdata-maintenance-bundle.json', state.dataset);
      for (const file of files) state.exported.set(file.path, stableStringify(file.content));
      render();
      report('已触发完整维护包下载。包内包含 schema_version、全部源 instruments（包括待审核记录）及完整 vocabulary。\n先预览：npm run import -- tickerdata-maintenance-bundle.json\n确认差异后应用：npm run import -- tickerdata-maintenance-bundle.json --apply --expect HASH\n将 HASH 替换为预览输出的源数据哈希。随后校验并整体提交 / PR；导入不会自动发布。');
    }, 'primary'));
    panel.append(node('p', `跨词表 / 证券的修改（尤其 ID 合并）必须整体提交。维护包格式为 {schema_version:"${SCHEMA_VERSION}", instruments:[全部源记录], vocabulary:{完整词表}}，含未修改及待审核记录，并非仅已发布数据。使用仓库导入命令，或将各记录写入 data/instruments/<id>.json、词表写入 data/vocabulary.json；校验后将上述全部变更一并提交。`, 'hint'));
    panel.append(node('pre', 'npm run import -- tickerdata-maintenance-bundle.json\nnpm run import -- tickerdata-maintenance-bundle.json --apply --expect HASH'));
    panel.append(node('p', '先在仓库目录运行第一条命令，检查完整修改前 / 后差异及源数据哈希；再将第二条命令中的 HASH 替换为此次预览输出的哈希。源数据已变化时请重新预览，不要绕过并发保护。', 'hint'));
  }
  parent.append(panel);
}

function render() {
  app.replaceChildren();
  readRecord = null;
  const instructions = node('details', null, 'notice');
  instructions.append(node('summary', '操作流程与隐私边界 · 请先阅读'));
  instructions.append(node('p', '加载源数据 → 人工编辑 / 审核 → 全数据集校验 → 保存内存草稿 → 导出全部变更文件 → 在 GitHub 提交 / PR → 仓库校验及发布流程。此页面没有后台、登录、自动提交或自动发布功能。'));
  instructions.append(node('p', '仓库导入支持单条证券、完整词表及完整维护包：先运行 npm run import -- 文件.json 预览；确认差异后执行 npm run import -- 文件.json --apply --expect HASH（HASH 使用预览输出的源数据哈希）。合并词条请使用完整维护包，避免分步导入破坏引用。'));
  instructions.append(node('p', '隐私：source-data.json 包含待审核、需复核等完整维护记录。若本页面公开托管，这些记录同样可被公开下载。审核状态不是访问控制。请勿输入密钥、密码、个人敏感信息或非公开资料。'));
  instructions.append(node('p', '本页只请求同目录的 source-data.json 和 site-config.json，不保存到 localStorage，不向远程服务发送数据。GitHub 链接由你主动打开。'));
  app.append(instructions);
  app.append(node('p', `已加载源数据：${state.dataset.instruments.length} 条（不代表全部已审核）。实际发布状态：本页未核验；已审核不等于已发布。Pages 配置：${state.config?.pages_enabled ? '已启用' : '未启用或未配置'}。`, 'status-line'));
  const toolbar = node('nav', null, 'toolbar');
  toolbar.setAttribute('aria-label', '维护功能');
  for (const [mode, title] of [['records', '证券记录'], ['vocabulary', '主题 / 标签 / 行业词表']]) {
    const tab = button(title, () => navigate(() => { state.mode = mode; }));
    tab.setAttribute('aria-pressed', String(state.mode === mode));
    toolbar.append(tab);
  }
  toolbar.append(button('＋ 新增证券', () => navigate(() => {
    state.mode = 'records';
    state.selected = null;
    draftRecord = emptyInstrument(`ins-${crypto.randomUUID()}`);
  }), 'primary'));
  const fileInput = node('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      if (!mayLeave()) return;
      if (file.size > 10 * 1024 * 1024) throw new Error('导入文件超过 10 MB；请缩小维护包或选择单条证券。');
      const value = JSON.parse(await file.text());
      importValue(value);
    } catch (error) { report(`导入失败：${error.message}`, true); }
    finally { fileInput.value = ''; }
  });
  toolbar.append(button('导入证券 / 词表 / 维护包 JSON', () => fileInput.click()), fileInput);
  app.append(toolbar);
  messages = node('div');
  messages.id = 'messages';
  messages.setAttribute('role', 'status');
  messages.setAttribute('aria-live', 'polite');
  messages.tabIndex = -1;
  app.append(messages);
  renderExports(app);
  const layout = node('div', null, 'layout toolbar-layout');
  const aside = node('aside', null, 'panel');
  detail = node('section', null, 'panel');
  detail.setAttribute('aria-label', '编辑详情');
  layout.append(aside, detail);
  app.append(node('hr'), layout);
  if (state.mode === 'records') {
    renderRecordSidebar(aside);
    const record = draftRecord ?? state.dataset.instruments.find((item) => item.id === state.selected);
    if (record) renderRecord(record);
    else detail.append(node('h2', '选择证券开始维护'), node('p', '从左侧搜索并选择记录，或新增证券。待审核样例不能被视为已经确认的交易分类。', 'empty'));
  } else renderVocabulary(aside);
}

function importValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 顶层必须是单条证券、完整词表或完整维护包对象。');
  let candidate = clone(state.dataset);
  if ('instruments' in value) {
    candidate = prepareImportedDataset(state.dataset, value);
    validate(candidate);
    if (!window.confirm('将用完整维护包替换当前内存数据集。所有字段与引用将一起校验，导入不视为人工复核；当前未导出的草稿可能被替换。确定继续？')) return;
    state.mode = 'records';
    state.selected = null;
  } else if ('industry_systems' in value) {
    candidate.vocabulary = value;
    candidate = prepareImportedDataset(state.dataset, candidate);
    validate(candidate);
    if (!window.confirm('词表导入将替换当前内存词表，并将受影响记录标为需复核。确定保存为内存草稿？')) return;
    state.mode = 'vocabulary';
    state.vocabId = null;
  } else {
    const index = candidate.instruments.findIndex((record) => record.id === value.id);
    if (index === -1) candidate.instruments.push(value);
    else candidate.instruments[index] = value;
    const previous = state.dataset.instruments.find((record) => record.id === value.id);
    candidate = prepareImportedDataset(state.dataset, candidate);
    validate(candidate);
    if (!window.confirm(`${previous ? '将替换同一稳定 ID 的现有记录' : '将以文件中的稳定 ID 新增记录'}：${value.id}。导入不会作为一次人工复核。确定保存为内存草稿？`)) return;
    state.mode = 'records';
    state.selected = value.id;
  }
  commit(candidate, '导入内容已通过全数据集校验。');
}

function renderRecordSidebar(parent) {
  parent.append(node('h2', '证券目录'));
  const filters = node('div', null, 'filters');
  const search = node('input');
  search.type = 'search';
  search.placeholder = '代码、名称、数据商别名、历史代码';
  search.value = state.filters.query;
  search.addEventListener('input', () => { state.filters.query = search.value; renderRecordList(); });
  field(filters, '搜索', search);
  const choices = [
    ['type', '证券类型', enumItems(Object.keys(typeNames), typeNames)],
    ['theme', '主主题', [{ id: '__none', name_zh: '未分类' }, ...state.dataset.vocabulary.themes]],
    ['tag', '标签', state.dataset.vocabulary.tags],
    ['review', '审核状态', enumItems(Object.keys(reviewNames), reviewNames)],
  ];
  for (const [key, title, values] of choices) {
    const control = node('select');
    if (state.filters[key] && !values.some((value) => value.id === state.filters[key])) state.filters[key] = '';
    options(control, values, state.filters[key], '全部');
    control.addEventListener('change', () => { state.filters[key] = control.value; renderRecordList(); });
    field(filters, title, control);
  }
  parent.append(filters);
  list = node('div');
  parent.append(list);
  renderRecordList();
}

function renderRecordList() {
  list.replaceChildren();
  const records = state.dataset.instruments.filter((record) => matchesRecord(record, state.filters));
  list.append(node('p', `${records.length} / ${state.dataset.instruments.length} 条记录`, 'muted'));
  const items = node('ul', null, 'record-list');
  const changed = new Set(changedFiles(state.initial, state.dataset).map((file) => file.path));
  for (const record of records) {
    const item = node('li');
    const choose = button('', () => navigate(() => { state.selected = record.id; }), 'record-button');
    choose.setAttribute('aria-pressed', String(state.selected === record.id && !draftRecord));
    choose.append(node('strong', `${record.symbol.canonical} · ${record.symbol.mic ?? 'MIC 未填写'}`), node('small', record.name.zh || record.name.en || '名称待补充'));
    const badges = node('span', null, 'badges');
    badges.append(node('span', typeNames[record.security_type], 'badge'), node('span', reviewNames[record.review.status], `badge ${record.review.status}`));
    if (!record.classification.primary_theme_id) badges.append(node('span', '未分类', 'badge pending'));
    if (changed.has(`data/instruments/${record.id}.json`)) badges.append(node('span', '内存草稿', 'badge draft'));
    choose.append(badges);
    item.append(choose);
    items.append(item);
  }
  if (!records.length) items.append(node('li', '没有匹配记录。试试清除筛选条件。', 'empty'));
  list.append(items);
}

function renderRecord(record) {
  detail.replaceChildren();
  const working = clone(record);
  const before = state.initial.instruments.find((item) => item.id === record.id);
  detail.append(node('h2', `${before ? '编辑' : '新增'}证券 · ${record.symbol.canonical || '未填写代码'}`));
  detail.append(node('p', `稳定内部 ID：${record.id}`, 'muted'));
  const status = node('p', state.dirty ? '表单有未保存修改 · 尚未校验，未进入内存草稿' : '当前显示已加载内容 / 已保存内存草稿；编辑后请校验保存。', 'warning');
  status.id = 'form-state';
  detail.append(status);
  links(detail, `data/instruments/${record.id}.json`, Boolean(before));
  const form = node('form');
  form.addEventListener('submit', (event) => event.preventDefault());
  detail.append(form);
  const readers = [];
  function bind(parent, label, path, hint, kind = 'text', choices) {
    const parts = path.split('.');
    const value = parts.reduce((item, key) => item?.[key], working);
    let control;
    if (kind === 'select' || kind === 'multi') control = selectField(parent, label, choices, value, hint, kind === 'multi');
    else {
      control = input(parent, label, kind === 'json' ? stableStringify(value) : kind === 'ids' ? value.join(', ') : value, hint, kind === 'json' || kind === 'textarea');
      if (kind === 'json') { control.classList.add('code'); control.rows = 6; control.spellcheck = false; }
      if (kind === 'number') { control.type = 'number'; control.step = 'any'; control.min = '0'; }
    }
    readers.push((next) => {
      let parsed;
      if (kind === 'json') {
        try { parsed = JSON.parse(control.value); } catch { throw new Error(`${label}：不是合法 JSON，请检查引号、逗号和括号。`); }
      } else if (kind === 'multi') parsed = [...control.selectedOptions].map((option) => option.value);
      else if (kind === 'ids') parsed = ids(control.value);
      else if (kind === 'number') parsed = control.value === '' ? null : Number(control.value);
      else parsed = ['notes', 'symbol.original', 'symbol.canonical'].includes(path) ? control.value : nullable(control.value);
      const target = parts.slice(0, -1).reduce((item, key) => item[key], next);
      target[parts.at(-1)] = parsed;
    });
    return control;
  }
  const identity = section(form, '1 · 身份与上市信息');
  const original = bind(identity, '原始代码', 'symbol.original', '保留原始写法和标点，不作为内部 ID。');
  const canonical = bind(identity, '规范代码', 'symbol.canonical', '仅去除首尾空格并转为大写；不会猜测交易所或替换标点。');
  identity.append(button('由原始代码填入规范代码', () => { canonical.value = normalizeSymbol(original.value); markDirty(); }));
  bind(identity, 'MIC 交易场所代码', 'symbol.mic', '未知留空；已知填写 4 位大写字母 / 数字，例如 XNAS。');
  const type = bind(identity, '证券类型', 'security_type', null, 'select', enumItems(Object.keys(typeNames), typeNames));
  bind(identity, '上市状态', 'listing_status', null, 'select', enumItems(['active', 'inactive', 'unknown'], { active: '正常上市', inactive: '已停止上市', unknown: '未知' }));
  bind(identity, '英文名称', 'name.en');
  bind(identity, '中文名称', 'name.zh');
  bind(identity, '发行人 ID', 'issuer.id', '未知留空；不自动匹配或猜测发行人。');
  bind(identity, '发行人国家 / 地区代码', 'issuer.country', '两位大写代码，例如 US；未知留空。');
  bind(identity, '相关证券内部 ID', 'related_instrument_ids', '逗号或换行分隔；必须引用已有记录，不得引用自身。', 'ids');

  if (working.security_type !== 'etf') {
    const industry = section(form, '2 · 标准行业分类（与主题独立）');
    const vocabulary = state.dataset.vocabulary;
    const systems = [...vocabulary.industry_systems].sort((a, b) =>
      Number(b.id === 'financedatabase') - Number(a.id === 'financedatabase'));
    let selection = clone(working.industry);
    const choices = industryChoices(vocabulary, selection);
    const controls = {
      system_id: bind(industry, '行业体系', 'industry.system_id', '新录入推荐 FinanceDatabase 三层体系（非官方 GICS）；不会自动填写。行业可以留空；一旦填写，必须有行业来源。', 'select', systems),
      sector_id: bind(industry, '板块 / Sector', 'industry.sector_id', null, 'select', choices.sectors),
      industry_group_id: bind(industry, '行业组 / Industry Group', 'industry.industry_group_id', '按板块筛选；Yahoo 等无行业组的体系保留为空。', 'select', choices.industry_groups),
      industry_id: bind(industry, '行业 / Industry', 'industry.industry_id', '按板块与行业组筛选；选择行业会补全已知父级。', 'select', choices.industries),
    };
    const refresh = () => {
      const available = industryChoices(vocabulary, selection);
      const system = systems.find((item) => item.id === selection.system_id);
      options(controls.sector_id, available.sectors, selection.sector_id);
      options(controls.industry_group_id, available.industry_groups, selection.industry_group_id,
        system && !system.industry_groups.length ? '此体系无行业组（保留为空）' : '未填写');
      options(controls.industry_id, available.industries, selection.industry_id);
      controls.sector_id.disabled = !system;
      controls.industry_group_id.disabled = !system?.industry_groups.length;
      controls.industry_id.disabled = !system;
    };
    for (const [key, control] of Object.entries(controls)) {
      control.addEventListener('change', () => {
        selection = changeIndustrySelection(vocabulary, selection, key, control.value);
        refresh();
      });
    }
    refresh();
    bind(industry, '行业来源 ID', 'industry.source_ids', sourceHint, 'ids');
  } else form.append(node('p', 'ETF 不使用公司板块 / 行业；请在 ETF 属性中描述敞口，并独立选择交易主题。', 'notice'));

  const classification = section(form, '3 · 主主题与标签');
  bind(classification, '主主题（单选）', 'classification.primary_theme_id', '未知可留空；待确认内容不要直接标为已审核。', 'select', state.dataset.vocabulary.themes);
  bind(classification, '标签（多选）', 'classification.tag_ids', '按住 Ctrl / Command 可多选、取消选择；触屏使用系统多选控件。', 'multi', state.dataset.vocabulary.tags);
  const classificationSources = bind(classification, '分类来源 ID', 'classification.source_ids', sourceHint, 'ids');

  if (working.security_type === 'etf') {
    const etf = section(form, '4 · ETF 属性');
    bind(etf, '投资目标', 'etf.objective');
    bind(etf, '资产类别', 'etf.asset_class', null, 'select', enumItems(
      ['equity', 'fixed_income', 'commodity', 'digital_asset', 'multi_asset', 'other'],
      { equity: '股票', fixed_income: '固定收益', commodity: '商品', digital_asset: '数字资产', multi_asset: '多资产', other: '其他' },
    ));
    bind(etf, '投资敞口（逗号或换行分隔）', 'etf.exposure', null, 'ids');
    bind(etf, '杠杆倍数', 'etf.leverage_factor', '正数；未知留空。填写倍数时必须指定方向和重置周期。', 'number');
    bind(etf, '方向', 'etf.direction', null, 'select', enumItems(['long', 'short', 'neutral'], { long: '做多', short: '做空', neutral: '中性' }));
    bind(etf, '重置周期', 'etf.reset_period', null, 'select', enumItems(['daily', 'monthly', 'none', 'other'], { daily: '每日', monthly: '每月', none: '不重置', other: '其他' }));
    bind(etf, '基金类别', 'etf.fund_category');
    bind(etf, '补充说明', 'etf.description', null, 'textarea');
    bind(etf, 'ETF 来源 ID', 'etf.source_ids', sourceHint, 'ids');
  }

  const evidence = section(form, '5 · 别名、历史代码与来源证据');
  const aliases = bind(evidence, '数据商别名（JSON 数组）', 'symbol.aliases', '示例：[{"provider":"example","symbol":"ABC.O"}]。搜索同时包含数据商名称与别名。', 'json');
  aliases.parentElement.classList.add('wide');
  const history = bind(evidence, '历史代码（JSON 数组）', 'symbol.history', '每项含 symbol、mic、valid_from、valid_to；日期 YYYY-MM-DD，未知值为 null。记录改名 / 换代码时保留内部 ID。', 'json');
  history.parentElement.classList.add('wide');
  const sources = bind(evidence, '来源证据（JSON 数组）', 'sources', '每项字段：id、kind（manual/issuer/exchange/provider/other）、label（依据）、url（HTTPS 或 null）、accessed_at（UTC ISO 时间或 null）、fields。允许路径：/industry /classification /etf /name /symbol /issuer /listing_status /notes。', 'json');
  sources.rows = 12;
  sources.parentElement.classList.add('wide');
  evidence.append(button('＋ 添加人工分类依据模板', () => {
    let entries;
    try { entries = JSON.parse(sources.value); } catch { throw new Error('请先修复来源证据 JSON。'); }
    if (!Array.isArray(entries)) throw new Error('来源证据必须是 JSON 数组。');
    const id = `src-${crypto.randomUUID()}`;
    entries.push({ id, kind: 'manual', label: '', url: null, accessed_at: new Date().toISOString(), fields: ['/classification'] });
    sources.value = stableStringify(entries);
    classificationSources.value = [...ids(classificationSources.value), id].join(', ');
    markDirty();
    report('已添加人工来源模板并关联分类。必须在 label 中填写真实的人工判断依据；无需伪造 URL。');
    sources.focus();
  }));

  const notes = section(form, '6 · 备注与审核');
  bind(notes, '维护备注', 'notes', null, 'textarea');
  const review = bind(notes, '审核状态', 'review.status', '对已审核记录的修改默认转为需复核；重新审核请勾选下方确认。', 'select', enumItems(Object.keys(reviewNames), reviewNames));
  bind(notes, '审核人', 'review.reviewer', '填写可公开的审核署名，不要填写敏感个人信息。');
  bind(notes, '审核时间（UTC ISO）', 'review.reviewed_at', '例如 2026-01-01T00:00:00.000Z；明确复核时由本页写入当前 UTC 时间。');
  const explicit = node('input');
  explicit.type = 'checkbox';
  explicit.addEventListener('change', () => {
    if (explicit.checked) review.value = 'reviewed';
    markDirty();
  });
  const explicitLabel = node('label', null, 'checkbox');
  explicitLabel.append(explicit, node('span', '我已人工核验当前内容，明确标为已审核 / 重新审核，并更新审核时间。需英文名称、MIC、主主题、审核人及分类依据；标准行业可留空。'));
  form.append(explicitLabel);
  readRecord = () => {
    const next = clone(working);
    for (const reader of readers) reader(next);
    if (!type.value) throw new Error('请选择证券类型。');
    next.symbol.canonical = normalizeSymbol(next.symbol.canonical);
    if (next.security_type === 'etf') {
      next.etf ??= emptyEtf();
    } else next.etf = null;
    if (next.review.status === 'reviewed' && !explicit.checked &&
        (working.review.status !== 'reviewed' || stableStringify(next) !== stableStringify(working))) {
      next.review.status = 'needs_review';
    }
    return next;
  };
  type.addEventListener('change', () => attempt(() => {
    let next;
    try { next = readRecord(); } catch (error) { type.value = working.security_type; throw error; }
    if (next.security_type === 'etf') {
      const hasIndustry = Object.entries(next.industry).some(([key, value]) => key === 'source_ids' ? value.length > 0 : value !== null);
      if (hasIndustry && !window.confirm('切换为 ETF 会清空不适用的公司行业分类。继续？')) { type.value = working.security_type; return; }
      next.industry = { system_id: null, sector_id: null, industry_group_id: null, industry_id: null, source_ids: [] };
    } else if (working.etf && !window.confirm('切换为非 ETF 会移除 ETF 属性。继续？')) {
      type.value = working.security_type;
      return;
    }
    draftRecord = next;
    markDirty();
    renderRecord(next);
  }));
  const actions = node('div', null, 'actions');
  actions.append(button('校验并保存内存草稿', () => {
    const next = prepareRecord(state.dataset.instruments.find((item) => item.id === record.id), readRecord(), explicit.checked);
    const candidate = clone(state.dataset);
    const index = candidate.instruments.findIndex((item) => item.id === next.id);
    if (index === -1) candidate.instruments.push(next);
    else candidate.instruments[index] = next;
    downgradeRelatedReviews(candidate);
    validate(candidate);
    state.selected = next.id;
    commit(candidate, `记录 ${next.id} 已通过校验并保存草稿。`);
  }, 'primary'));
  actions.append(button('预览当前表单差异', () => {
    preview.replaceChildren();
    diff(preview, before, readRecord());
    preview.querySelector('details').open = true;
  }));
  actions.append(button('导出已保存的单条 JSON', () => {
    const saved = state.dataset.instruments.find((item) => item.id === record.id);
    if (!saved) throw new Error('新增记录需要先校验并保存内存草稿。');
    exportFile(`data/instruments/${record.id}.json`, saved);
  }));
  actions.append(button('放弃未保存表单修改', () => navigate(() => {})));
  form.append(actions);
  const preview = node('div');
  diff(preview, before, record);
  detail.append(preview);
}

function renderIndustryTree(parent, system) {
  const tree = node('details', null, 'industry-tree');
  tree.open = true;
  tree.append(node('summary', `三层行业明细：${system.sectors.length} 板块 / ${system.industry_groups.length} 行业组 / ${system.industries.length} 行业`));
  tree.append(node('p', system.description, 'hint'));
  if (!system.industry_groups.length) tree.append(node('p', '此体系无行业组；行业直接列在板块下，组引用保留为空。', 'hint'));
  const caption = (item) => `${item.name_zh} · ${item.aliases.join(' / ')} [${item.id}]`;
  const appendIndustries = (container, industries) => {
    const items = node('ul');
    for (const industry of industries) {
      items.append(node('li', `${caption(industry)} · 板块：${industry.sector_id ?? '未填写'} · 行业组：${industry.industry_group_id ?? '未填写'}`));
    }
    container.append(items);
  };
  for (const sector of system.sectors) {
    const sectorBox = node('details');
    sectorBox.append(node('summary', `板块 / Sector：${caption(sector)}`));
    for (const group of system.industry_groups.filter((item) => item.sector_id === sector.id)) {
      const groupBox = node('details');
      groupBox.append(node('summary', `行业组 / Industry Group：${caption(group)}`));
      appendIndustries(groupBox, system.industries.filter((item) => item.industry_group_id === group.id));
      sectorBox.append(groupBox);
    }
    appendIndustries(sectorBox, system.industries.filter((item) => item.sector_id === sector.id && !item.industry_group_id));
    tree.append(sectorBox);
  }
  const unassigned = system.industries.filter((item) => !item.sector_id && !item.industry_group_id);
  if (unassigned.length) {
    tree.append(node('p', '未指定父级的行业'));
    appendIndustries(tree, unassigned);
  }
  parent.append(tree);
}

function renderVocabulary(sidebar) {
  sidebar.append(node('h2', '词表维护'));
  const tabs = node('div', null, 'actions');
  for (const [kind, label] of [['themes', '主主题'], ['tags', '标签'], ['industry_systems', '行业体系']]) {
    const tab = button(label, () => navigate(() => { state.vocabKind = kind; state.vocabId = null; }));
    tab.setAttribute('aria-pressed', String(state.vocabKind === kind));
    tabs.append(tab);
  }
  sidebar.append(tabs);
  const kind = state.vocabKind;
  const labels = state.dataset.vocabulary[kind];
  const items = node('ul', null, 'record-list');
  for (const label of labels) {
    const item = node('li');
    const choose = button('', () => navigate(() => { state.vocabId = label.id; }), 'record-button');
    choose.setAttribute('aria-pressed', String(state.vocabId === label.id));
    choose.append(node('strong', label.name_zh), node('small', `${label.id} · ${references(state.dataset, kind, label.id).length} 条引用`));
    item.append(choose);
    items.append(item);
  }
  sidebar.append(items);
  sidebar.append(button('＋ 新增词条', () => navigate(() => { state.vocabId = '__new'; }), 'primary'));
  detail.append(node('h2', '主题、标签与标准行业词表'));
  detail.append(node('p', '重命名只修改显示名称，不更换稳定 ID。被引用的词条不可直接删除；主题 / 标签可显式合并 ID。词义、描述或别名变更会将引用记录标为需复核；依赖这些证券的已审核关联记录也将递归转为需复核，并全部列入变更清单。行业子项在高级 JSON 中维护，所有引用同样参与校验。', 'notice'));
  const formState = node('p', '词表修改同样只保存为内存草稿。', 'warning');
  formState.id = 'form-state';
  detail.append(formState);
  links(detail, 'data/vocabulary.json');
  const label = labels.find((item) => item.id === state.vocabId) ?? (state.vocabId === '__new'
    ? { id: `${kind === 'themes' ? 'theme' : kind === 'tags' ? 'tag' : 'system'}-${crypto.randomUUID()}`, name_zh: '', description: '', aliases: [], ...(kind === 'industry_systems' ? { sectors: [], industry_groups: [], industries: [] } : {}) }
    : null);
  if (label) {
    if (kind === 'industry_systems') renderIndustryTree(detail, label);
    renderLabelForm(detail, kind, label, labels.some((item) => item.id === label.id));
  }
  else detail.append(node('p', '选择左侧词条编辑，或新增词条；也可使用下方完整词表 JSON 编辑器。', 'empty'));
  const advanced = node('details');
  advanced.append(node('summary', '高级：编辑完整词表 JSON（含行业体系 / 板块 / 行业组 / 行业）'));
  const json = input(advanced, '完整 vocabulary.json', stableStringify(state.dataset.vocabulary), '此编辑器与上方结构化编辑器互斥：请只修改其中一个后保存。整体校验通过前不会替换草稿。被引用 ID 的删除会被拒绝。', true);
  json.classList.add('code');
  json.rows = 20;
  advanced.append(button('校验并保存完整词表草稿', () => {
    if (detail.querySelector('[data-label-form]')?.dataset.changed === 'true') throw new Error('上方词条表单有修改。请先保存它或放弃修改，再编辑完整 JSON，避免相互覆盖。');
    let vocabulary;
    try { vocabulary = JSON.parse(json.value); } catch { throw new Error('完整词表不是合法 JSON。'); }
    saveVocabulary(vocabulary);
  }));
  json.addEventListener('input', () => { advanced.dataset.changed = 'true'; });
  advanced.dataset.vocabularyEditor = 'true';
  detail.append(advanced);
  detail.append(button('导出已保存词表 JSON', () => exportFile('data/vocabulary.json', state.dataset.vocabulary)));
  detail.append(button('放弃未保存修改', () => navigate(() => {})));
  diff(detail, state.initial.vocabulary, state.dataset.vocabulary);
}

function saveVocabulary(vocabulary) {
  validate({ ...state.dataset, vocabulary });
  const candidate = applyVocabulary(state.dataset, vocabulary);
  const count = candidate.instruments.filter((record, index) => stableStringify(record) !== stableStringify(state.dataset.instruments[index])).length;
  if (count && !window.confirm(`词表变更将同时更新 ${count} 条引用记录为需复核。所有变更文件将列入完整清单。确定保存？`)) return;
  commit(candidate, `词表已保存；同时更新 ${count} 条引用记录。`);
}

function renderLabelForm(parent, kind, label, exists) {
  const form = node('div');
  form.dataset.labelForm = 'true';
  form.addEventListener('input', () => { form.dataset.changed = 'true'; });
  const group = section(form, exists ? '编辑词条（保留稳定 ID）' : '新增词条');
  const id = input(group, '稳定 ID（不可修改）', label.id);
  id.readOnly = true;
  const name = input(group, '中文显示名称', label.name_zh);
  const description = input(group, '定义 / 说明', label.description, null, true);
  const aliases = input(group, '别名（每行一个）', label.aliases.join('\n'), '用于统一称呼。不能与同类词条名称 / 别名重复。', true);
  function noAdvancedChanges() {
    if (detail.querySelector('[data-vocabulary-editor]')?.dataset.changed === 'true') throw new Error('高级 JSON 编辑器有修改。请先保存它或放弃修改，避免相互覆盖。');
  }
  form.append(button('校验并保存词条草稿', () => {
    noAdvancedChanges();
    const vocabulary = clone(state.dataset.vocabulary);
    const next = { ...clone(label), name_zh: name.value.trim(), description: description.value, aliases: aliases.value.split('\n').map((value) => value.trim()).filter(Boolean) };
    const index = vocabulary[kind].findIndex((item) => item.id === label.id);
    if (index === -1) vocabulary[kind].push(next);
    else vocabulary[kind][index] = next;
    saveVocabulary(vocabulary);
    if (!state.dirty) {
      state.vocabId = label.id;
      render();
      report('词条草稿已保存；完整变更文件见上方清单。尚未提交或发布。');
    }
  }, 'primary'));
  const refs = references(state.dataset, kind, label.id);
  const referenceBox = node('details');
  referenceBox.open = refs.length > 0;
  referenceBox.append(node('summary', `引用此词条的记录：${refs.length} 条`));
  const referenceList = node('ul');
  for (const record of refs) {
    const item = node('li');
    item.append(button(`${record.symbol.canonical} · ${record.name.zh || record.name.en || record.id} · ${reviewNames[record.review.status]}`, () => navigate(() => { state.mode = 'records'; state.selected = record.id; })));
    referenceList.append(item);
  }
  referenceBox.append(referenceList);
  form.append(referenceBox);
  if (exists) {
    form.append(button('删除未被引用词条', () => {
      noAdvancedChanges();
      if (state.dirty) throw new Error('请先保存或放弃表单修改，再执行删除。');
      if (refs.length) throw new Error(`拒绝删除：${refs.length} 条记录仍引用 ${label.id}。请使用合并或先移除引用。`);
      if (!window.confirm(`确定从草稿词表删除 ${label.name_zh}（${label.id}）？`)) return;
      const vocabulary = clone(state.dataset.vocabulary);
      vocabulary[kind] = vocabulary[kind].filter((item) => item.id !== label.id);
      saveVocabulary(vocabulary);
    }, 'danger'));
    if (kind === 'themes' || kind === 'tags') {
      const mergeBox = node('fieldset');
      mergeBox.append(node('legend', '合并 ID（原子变更）'));
      const target = node('select');
      options(target, state.dataset.vocabulary[kind].filter((item) => item.id !== label.id), '', '选择保留的目标词条');
      field(mergeBox, '将当前词条并入', target, '删除当前 ID，将其名称 / 别名添加到目标；更新全部引用，并将受影响记录设为需复核。');
      mergeBox.append(button('预览并合并到目标 ID', () => {
        noAdvancedChanges();
        if (state.dirty) throw new Error('请先保存或放弃表单修改，再执行 ID 合并。');
        const candidate = mergeVocabulary(state.dataset, kind, label.id, target.value);
        validate(candidate);
        const files = changedFiles(state.dataset, candidate);
        const description = files.map((file) => file.path).join('\n');
        if (!window.confirm(`合并 ${label.id} → ${target.value}，将原子修改以下 ${files.length} 个文件：\n${description}\n\n确定保存完整内存草稿？后续必须整体导出并提交。`)) return;
        state.vocabId = target.value;
        commit(candidate, `已原子合并 ID。此次变更文件：\n${description}\n请导出完整维护包，不能只提交词表。`);
      }));
      form.append(mergeBox);
    }
  }
  parent.append(form);
}

window.addEventListener('beforeunload', (event) => {
  if (state.dirty || (state.initial && changedFiles(state.initial, state.dataset).length)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

async function start() {
  const responses = await Promise.all([fetch('./source-data.json'), fetch('./site-config.json')]);
  for (const response of responses) if (!response.ok) throw new Error(`无法加载本地文件：${response.url}（HTTP ${response.status}）`);
  const [dataset, config] = await Promise.all(responses.map((response) => response.json()));
  const errors = validateDataset(dataset);
  if (errors.length) throw new Error(`源数据校验失败，请修复仓库后重新构建：\n${errors.join('\n')}`);
  state.initial = clone(dataset);
  state.dataset = clone(dataset);
  state.config = config;
  render();
}

start().catch((error) => {
  app.replaceChildren(node('h2', '维护台加载失败'), node('pre', error.message), node('p', '请通过 HTTP 静态服务器打开构建后的页面，并确认 source-data.json 与 site-config.json 位于同一目录。此页未创建任何草稿。'));
});
