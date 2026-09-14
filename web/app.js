import 'bootstrap/dist/css/bootstrap.min.css';
import { validateDataset, validateReviewTransitions } from '../src/validation.js';
import { emptyInstrument, emptyEtf, stableStringify, normalizeSymbol } from '../src/model.js';
import { clone, matchesRecord, prepareRecord, references, applyVocabulary, mergeVocabulary, changedFiles, githubLinks, downgradeRelatedReviews, industryChoices, changeIndustrySelection } from './editor-model.js';
import { createPullRequestFromDraft, defaultPrDraft, getGitHubSession, logoutGitHub } from './github-pr.js';

const app = document.querySelector('#app');
const state = {
  initial: null, dataset: null, config: null, mode: 'records', selected: null,
  vocabKind: 'tags', vocabId: null, vocabQuery: '', dirty: false,
  filters: { query: '', type: '', tag: '', review: '' },
  pr: { session: { enabled: false, authenticated: false, user: null }, branch: '', commitMessage: '', title: '', body: '', confirm: false, submitting: false, url: '', fingerprint: '' },
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
  const variant = className === 'primary' ? 'btn-primary' : className === 'danger' ? 'btn-outline-danger' : 'btn-outline-secondary';
  const element = node('button', text, `btn btn-sm ${variant} ${className}`.trim());
  element.type = 'button';
  element.addEventListener('click', () => attempt(action));
  return element;
}

function attempt(action) {
  try {
    const result = action();
    if (result && typeof result.then === 'function') result.catch((error) => report(error.message || String(error), true));
  } catch (error) { report(error.message || String(error), true); }
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

function closeEditor() {
  navigate(() => {
    if (state.mode === 'records') state.selected = null;
    else state.vocabId = null;
  });
}

function drawerHeader(title) {
  const header = node('div', null, 'drawer-header');
  const close = button('关闭', closeEditor, 'drawer-close');
  close.setAttribute('aria-label', '关闭编辑面板');
  header.append(node('h2', title), close);
  return header;
}

function validate(candidate) {
  const errors = validateDataset(candidate);
  if (errors.length) throw new Error(`未保存。请修正以下问题：\n${errors.join('\n')}`);
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

function field(parent, title, control, hint, required = false) {
  const wrapper = node('div', null, 'field');
  const label = node('label', title);
  control.id ||= `field-${++sequence}`;
  label.htmlFor = control.id;
  if (required) {
    control.required = true;
    label.classList.add('required');
  }
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

function setRequired(control, required) {
  control.required = required;
  control.parentElement.querySelector(`label[for="${control.id}"]`)?.classList.toggle('required', required);
}

function input(parent, title, value, hint, multiline = false, required = false) {
  const control = node(multiline ? 'textarea' : 'input');
  if (!multiline) control.type = 'text';
  control.value = value ?? '';
  control.addEventListener('input', markDirty);
  return field(parent, title, control, hint, required);
}

function selectField(parent, title, items, value, hint, required = false) {
  const control = node('select');
  options(control, items, value);
  control.addEventListener('change', markDirty);
  return field(parent, title, control, hint, required);
}

function multiField(parent, title, items, value, hint) {
  const wrapper = node('div', null, 'field');
  const titleElement = node('span', title, 'field-label');
  titleElement.id = `field-${++sequence}-label`;
  const group = node('div', null, 'multi-options');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', titleElement.id);
  for (const item of items) {
    const choice = node('label', null, 'multi-option');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.id;
    checkbox.checked = value.includes(item.id);
    checkbox.addEventListener('change', markDirty);
    choice.append(checkbox, node('span', item.name_zh ?? item.label ?? item.id));
    group.append(choice);
  }
  wrapper.append(titleElement, group);
  if (hint) {
    const help = node('span', hint, 'hint');
    help.id = `${titleElement.id}-hint`;
    group.setAttribute('aria-describedby', help.id);
    wrapper.append(help);
  }
  parent.append(wrapper);
  return group;
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
  const group = node('div', null, 'links');
  if (!items.length) {
    parent.append(node('p', exists ? '未配置有效 GitHub 仓库地址。' : '提交 PR 后将创建对应源文件。', 'muted'), group);
    return group;
  }
  for (const [label, url] of items) {
    const link = node('a', label);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    group.append(link);
  }
  parent.append(group);
  return group;
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

function assertSubmittable() {
  if (state.dirty) throw new Error('表单仍有未保存内容。请先校验并保存草稿，或明确放弃修改，再提交 PR。');
  validate(state.dataset);
  const transitionErrors = validateReviewTransitions(state.initial, state.dataset);
  if (transitionErrors.length) throw new Error(`审核变更校验失败：\n${transitionErrors.join('\n')}`);
}

function renderSubmission(parent) {
  const files = changedFiles(state.initial, state.dataset);
  const fingerprint = files.map((file) => `${file.path}\n${stableStringify(file.content)}`).join('\n---\n');
  if (state.pr.fingerprint !== fingerprint) {
    const draft = defaultPrDraft(files);
    state.pr = { ...state.pr, ...draft, confirm: false, submitting: false, url: '', fingerprint };
  }
  const panel = node('details', null, 'panel');
  panel.open = files.length > 0;
  panel.append(node('summary', `内存草稿 / 完整变更清单：${files.length} 个文件`));
  panel.append(node('p', '草稿只存在于此页面内存，刷新、关闭或重新登录都会丢失。请在开始编辑前登录 GitHub，并及时提交 PR。', 'warning'));
  if (!files.length) panel.append(node('p', '当前没有已保存的本地草稿。', 'muted'));
  const fileList = node('ul', null, 'file-list');
  for (const file of files) {
    const item = node('li');
    item.append(node('code', file.path), node('span', ' · 等待提交 '));
    fileList.append(item);
  }
  panel.append(fileList);
  if (files.length) {
    const submit = node('details');
    submit.append(node('summary', '直接提交 GitHub PR'));
    submit.append(node('p', '登录 GitHub 后由本站服务端校验部署快照、远端基线和完整候选数据，再一次性创建新分支、提交全部变更并创建 PR。浏览器不会接触 GitHub Token。', 'hint'));
    const form = node('div', null, 'pr-form');
    const prField = (title, value, hint, multiline = false) => {
      const control = node(multiline ? 'textarea' : 'input');
      if (!multiline) control.type = 'text';
      control.value = value ?? '';
      field(form, title, control, hint);
      return control;
    };
    const auth = node('div', null, 'auth-status');
    if (state.pr.session.authenticated) {
      const user = state.pr.session.user;
      const avatar = node('img');
      avatar.src = user.avatarUrl;
      avatar.alt = '';
      avatar.width = 32;
      avatar.height = 32;
      auth.append(avatar, node('span', `已登录 GitHub：${user.login}`), button('退出登录', async () => {
        await logoutGitHub();
        state.pr.session = { enabled: true, authenticated: false, user: null };
        render();
      }));
    } else if (state.pr.session.enabled) {
      auth.append(node('span', '尚未登录 GitHub。OAuth 登录会重新加载页面；请放弃当前草稿，登录后再编辑。', 'warning'));
    } else {
      auth.append(node('span', '当前部署未启用 GitHub App，无法保存变更。', 'warning'));
    }
    form.append(auth);
    const branch = prField('新分支名', state.pr.branch);
    branch.addEventListener('input', () => { state.pr.branch = branch.value; });
    const commitMessage = prField('提交信息（commit message）', state.pr.commitMessage);
    commitMessage.addEventListener('input', () => { state.pr.commitMessage = commitMessage.value; });
    const title = prField('PR 标题', state.pr.title);
    title.addEventListener('input', () => { state.pr.title = title.value; });
    const body = prField('PR 描述', state.pr.body, null, true);
    body.rows = 8;
    body.addEventListener('input', () => { state.pr.body = body.value; });
    const confirm = node('label', null, 'checkbox');
    const confirmInput = node('input');
    confirmInput.type = 'checkbox';
    confirmInput.checked = state.pr.confirm;
    confirmInput.addEventListener('change', () => { state.pr.confirm = confirmInput.checked; });
    confirm.append(confirmInput, node('span', `我已确认将一次性提交以上 ${files.length} 个文件，并基于 ${state.config.branch} 创建新分支与 PR。`));
    form.append(confirm);
    const actions = node('div', null, 'actions');
    const submitButton = button(state.pr.submitting ? '提交中…' : '提交 PR', async () => {
      assertSubmittable();
      if (!state.pr.confirm) throw new Error('请先确认本次将提交全部变更文件。');
      state.pr.submitting = true;
      state.pr.url = '';
      render();
      try {
        const result = await createPullRequestFromDraft({
          files,
          branch: state.pr.branch,
          commitMessage: state.pr.commitMessage,
          title: state.pr.title,
          body: state.pr.body,
        });
        state.pr.url = result.url;
        report(`PR 创建成功：${result.url}`);
      } catch (error) {
        if (error?.code === 'auth') state.pr.session = { enabled: true, authenticated: false, user: null };
        throw error;
      } finally {
        state.pr.submitting = false;
        render();
      }
    }, 'primary');
    submitButton.disabled = state.pr.submitting || !state.pr.session.authenticated;
    actions.append(submitButton);
    form.append(actions);
    if (state.pr.url) {
      const line = node('p', '提交成功：');
      const link = node('a', state.pr.url);
      link.href = state.pr.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
      form.append(line);
    }
    submit.append(form);
    panel.append(submit);
  }
  parent.append(panel);
}

function render() {
  app.replaceChildren();
  readRecord = null;
  const instructions = node('details', null, 'notice');
  instructions.append(node('summary', '操作流程与隐私边界 · 请先阅读'));
  instructions.append(node('p', '使用 GitHub 登录 → 加载源数据 → 人工编辑 / 审核 → 全数据集校验 → 保存内存草稿 → 一次性创建包含全部变更的 GitHub PR → 仓库校验及发布流程。'));
  instructions.append(node('p', '隐私：source-data.json 包含待审核、需复核等完整维护记录。若本页面公开托管，这些记录同样可被公开下载。审核状态不是访问控制。请勿输入密钥、密码、个人敏感信息或非公开资料。'));
  instructions.append(node('p', '本页默认只请求同目录的 source-data.json 和 site-config.json。GitHub 登录令牌仅由同源服务端持有并封装在 HttpOnly 加密会话中，不写入页面、localStorage、源数据或仓库文件。'));
  app.append(instructions);
  if (state.pr.session.enabled) {
    const githubAuth = node('div', null, 'panel auth-status');
    if (state.pr.session.authenticated) {
      const user = state.pr.session.user;
      const avatar = node('img');
      avatar.src = user.avatarUrl;
      avatar.alt = '';
      avatar.width = 32;
      avatar.height = 32;
      githubAuth.append(avatar, node('span', `GitHub 已登录：${user.login}`), button('退出登录', async () => {
        await logoutGitHub();
        state.pr.session = { enabled: true, authenticated: false, user: null };
        render();
      }));
    } else {
      githubAuth.append(node('span', '提交 PR 前请先登录 GitHub。登录会重新加载页面，请在开始编辑前完成。'), button('使用 GitHub 登录', () => {
        if (state.dirty || changedFiles(state.initial, state.dataset).length) throw new Error('登录会重新加载页面并丢失草稿。请放弃当前草稿后再登录 GitHub。');
        window.location.assign('/api/auth/login');
      }, 'primary'));
    }
    app.append(githubAuth);
  }
  app.append(node('p', `已加载源数据：${state.dataset.instruments.length} 条（不代表全部已审核）。实际发布状态：本页未核验；已审核不等于已发布。Pages 配置：${state.config?.pages_enabled ? '已启用' : '未启用或未配置'}。`, 'status-line'));
  const toolbar = node('nav', null, 'toolbar');
  toolbar.setAttribute('aria-label', '维护功能');
  for (const [mode, title] of [['records', '证券记录'], ['vocabulary', '标签 / 行业词表']]) {
    const tab = button(title, () => navigate(() => { state.mode = mode; }));
    tab.setAttribute('aria-pressed', String(state.mode === mode));
    toolbar.append(tab);
  }
  toolbar.append(button('＋ 新增证券', () => navigate(() => {
    state.mode = 'records';
    state.selected = null;
    draftRecord = emptyInstrument(`ins-${crypto.randomUUID()}`);
  }), 'primary'));
  app.append(toolbar);
  messages = node('div');
  messages.id = 'messages';
  messages.setAttribute('role', 'status');
  messages.setAttribute('aria-live', 'polite');
  messages.tabIndex = -1;
  app.append(messages);
  renderSubmission(app);
  const layout = node('div', null, 'workbench');
  const aside = node('aside', null, 'panel catalog-panel');
  const backdrop = button('', closeEditor, 'drawer-backdrop');
  backdrop.setAttribute('aria-label', '关闭编辑面板');
  detail = node('section', null, 'panel editor-drawer');
  detail.setAttribute('aria-label', '编辑详情');
  layout.append(aside, backdrop, detail);
  app.append(node('hr'), layout);
  let drawerOpen = false;
  if (state.mode === 'records') {
    renderRecordSidebar(aside);
    const record = draftRecord ?? state.dataset.instruments.find((item) => item.id === state.selected);
    if (record) {
      renderRecord(record);
      drawerOpen = true;
    }
  } else {
    renderVocabulary(aside);
    drawerOpen = state.vocabId !== null;
  }
  detail.classList.toggle('open', drawerOpen);
  backdrop.classList.toggle('open', drawerOpen);
  document.body.classList.toggle('drawer-open', drawerOpen);
}

function renderRecordSidebar(parent) {
  const heading = node('div', null, 'catalog-heading');
  heading.append(node('div', null, 'catalog-title'));
  heading.firstElementChild.append(node('p', '数据查询', 'eyebrow'), node('h2', '证券目录'));
  heading.append(node('p', '点击证券代码打开编辑抽屉；筛选结果始终保留在当前页面。', 'muted'));
  parent.append(heading);
  const filters = node('div', null, 'filters');
  const search = node('input');
  search.type = 'search';
  search.placeholder = '代码、名称、数据商别名、历史代码';
  search.value = state.filters.query;
  search.addEventListener('input', () => { state.filters.query = search.value; renderRecordList(); });
  field(filters, '搜索', search);
  const choices = [
    ['type', '证券类型', enumItems(Object.keys(typeNames), typeNames)],
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
  const summary = node('div', null, 'table-summary');
  summary.append(node('strong', `${records.length} 条结果`), node('span', `共 ${state.dataset.instruments.length} 条证券`, 'muted'));
  list.append(summary);
  const shell = node('div', null, 'table-shell');
  const table = node('table', null, 'maintenance-table');
  const head = node('thead');
  const headings = node('tr');
  for (const title of ['证券代码', '名称', 'MIC', '类型', '行业', '标签', '审核状态', '操作']) headings.append(node('th', title));
  head.append(headings);
  const body = node('tbody');
  const changed = new Set(changedFiles(state.initial, state.dataset).map((file) => file.path));
  for (const record of records) {
    const row = node('tr');
    if (state.selected === record.id && !draftRecord) row.classList.add('selected');
    const symbol = node('td');
    const choose = button(`${record.symbol.canonical} · ${record.symbol.mic ?? 'MIC 未填写'}`, () => navigate(() => { state.selected = record.id; }), 'record-button');
    choose.setAttribute('aria-pressed', String(state.selected === record.id && !draftRecord));
    symbol.append(choose);
    if (changed.has(`data/instruments/${record.id}.json`)) symbol.append(node('span', '草稿', 'badge draft'));
    const industryId = record.industry?.industry_id;
    const industrySystem = state.dataset.vocabulary.industry_systems
      .find((system) => system.id === record.industry?.system_id);
    const industryName = industrySystem?.industries.find((item) => item.id === industryId)?.name_zh;
    const tags = record.classification.tag_ids
      .map((id) => state.dataset.vocabulary.tags.find((item) => item.id === id)?.name_zh ?? id);
    const status = node('td');
    status.append(node('span', reviewNames[record.review.status], `badge ${record.review.status}`));
    const action = node('td');
    action.append(button('编辑', () => navigate(() => { state.selected = record.id; }), 'table-action'));
    for (const value of [
      symbol,
      node('td', record.name.zh || record.name.en || '名称待补充'),
      node('td', record.symbol.mic ?? '—'),
      node('td', typeNames[record.security_type]),
      node('td', industryId ? industryName ?? industryId : '—'),
      node('td', tags.join('、') || '—'),
      status,
      action,
    ]) row.append(value);
    body.append(row);
  }
  if (!records.length) {
    const empty = node('td', '没有匹配记录。请调整或清除筛选条件。', 'empty');
    empty.colSpan = 8;
    const row = node('tr');
    row.append(empty);
    body.append(row);
  }
  table.append(head, body);
  shell.append(table);
  list.append(shell);
}

function renderRecord(record) {
  detail.replaceChildren();
  const working = clone(record);
  const before = state.initial.instruments.find((item) => item.id === record.id);
  detail.append(drawerHeader(`${before ? '编辑' : '新增'}证券 · ${record.symbol.canonical || '未填写代码'}`));
  detail.append(node('p', `稳定内部 ID：${record.id}`, 'muted'));
  const status = node('p', state.dirty ? '表单有未保存修改 · 尚未校验，未进入内存草稿' : '当前显示已加载内容 / 已保存内存草稿；编辑后请校验保存。', 'warning');
  status.id = 'form-state';
  detail.append(status);
  const recordActions = links(detail, `data/instruments/${record.id}.json`, Boolean(before));
  recordActions.classList.add('record-actions');
  recordActions.setAttribute('role', 'group');
  recordActions.setAttribute('aria-label', '证券操作');
  const form = node('form');
  form.addEventListener('submit', (event) => event.preventDefault());
  detail.append(form);
  const readers = [];
  const requiredFields = new Set(['symbol.original', 'symbol.canonical', 'security_type', 'listing_status', 'review.status']);
  function bind(parent, label, path, hint, kind = 'text', choices) {
    const parts = path.split('.');
    const value = parts.reduce((item, key) => item?.[key], working);
    let control;
    const required = requiredFields.has(path);
    if (kind === 'select') control = selectField(parent, label, choices, value, hint, required);
    else if (kind === 'multi') control = multiField(parent, label, choices, value, hint);
    else {
      control = input(parent, label, kind === 'json' ? stableStringify(value) : kind === 'ids' ? value.join(', ') : value, hint, kind === 'json' || kind === 'textarea', required);
      if (kind === 'json') { control.classList.add('code'); control.rows = 6; control.spellcheck = false; }
      if (kind === 'number') { control.type = 'number'; control.step = 'any'; control.min = '0'; }
    }
    readers.push((next) => {
      let parsed;
      if (kind === 'json') {
        try { parsed = JSON.parse(control.value); } catch { throw new Error(`${label}：不是合法 JSON，请检查引号、逗号和括号。`); }
      } else if (kind === 'multi') parsed = [...control.querySelectorAll('input:checked')].map((option) => option.value);
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
  recordActions.append(button('由原始代码填入规范代码', () => { canonical.value = normalizeSymbol(original.value); markDirty(); }));
  const mic = bind(identity, 'MIC 交易场所代码', 'symbol.mic', '未知留空；可从常见美股交易场所中选择，也可填写其他 4 位 MIC。');
  const micList = node('datalist');
  micList.id = `mic-options-${sequence}`;
  for (const [id, label] of [
    ['XNAS', 'Nasdaq'],
    ['XNYS', 'New York Stock Exchange'],
    ['ARCX', 'NYSE Arca'],
    ['BATS', 'Cboe BZX'],
    ['XASE', 'NYSE American'],
  ]) {
    const option = node('option');
    option.value = id;
    option.label = label;
    micList.append(option);
  }
  mic.setAttribute('list', micList.id);
  mic.parentElement.append(micList);
  const type = bind(identity, '证券类型', 'security_type', null, 'select', enumItems(Object.keys(typeNames), typeNames));
  bind(identity, '上市状态', 'listing_status', null, 'select', enumItems(['active', 'inactive', 'unknown'], { active: '正常上市', inactive: '已停止上市', unknown: '未知' }));
  const englishName = bind(identity, '英文名称', 'name.en');
  bind(identity, '中文名称', 'name.zh');
  bind(identity, '发行人 ID', 'issuer.id', '未知留空；不自动匹配或猜测发行人。');
  bind(identity, '发行人国家 / 地区代码', 'issuer.country', '两位大写代码，例如 US；未知留空。');
  bind(identity, '相关证券内部 ID', 'related_instrument_ids', '逗号或换行分隔；必须引用已有记录，不得引用自身。', 'ids');

  if (working.security_type !== 'etf') {
    const industry = section(form, '2 · 标准行业分类（与标签独立）');
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
  } else form.append(node('p', 'ETF 不使用公司板块 / 行业；请在 ETF 属性中描述敞口，并按需独立选择标签。', 'notice'));

  const classification = section(form, '3 · 标签（可选）');
  bind(classification, '标签（多选）', 'classification.tag_ids', '可不选标签，已审核记录也可留空。可直接勾选多个标签。', 'multi', state.dataset.vocabulary.tags);

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
  const sources = bind(evidence, '来源证据（JSON 数组）', 'sources', '每项字段：id、kind（manual/issuer/exchange/provider/other）、label（依据）、url（HTTPS 或 null）、accessed_at（UTC ISO 时间或 null）、fields。允许路径：/industry /etf /name /symbol /issuer /listing_status /notes。', 'json');
  sources.rows = 12;
  sources.parentElement.classList.add('wide');

  const notes = section(form, '6 · 备注与审核');
  bind(notes, '维护备注', 'notes', null, 'textarea');
  const review = bind(notes, '审核状态', 'review.status', '对已审核记录的修改默认转为需复核；重新审核请勾选下方确认。', 'select', enumItems(Object.keys(reviewNames), reviewNames));
  const reviewer = bind(notes, '审核人', 'review.reviewer', '填写可公开的审核署名，不要填写敏感个人信息。');
  const reviewedAt = bind(notes, '审核时间（UTC ISO）', 'review.reviewed_at', '无需手动填写；明确审核并保存时，系统自动写入当前 UTC 时间。');
  reviewedAt.readOnly = true;
  const updateReviewRequirements = () => {
    const required = review.value === 'reviewed';
    for (const control of [englishName, mic, reviewer]) setRequired(control, required);
  };
  review.addEventListener('change', updateReviewRequirements);
  updateReviewRequirements();
  const explicit = node('input');
  explicit.type = 'checkbox';
  explicit.addEventListener('change', () => {
    if (explicit.checked) review.value = 'reviewed';
    updateReviewRequirements();
    markDirty();
  });
  const explicitLabel = node('label', null, 'checkbox');
  explicitLabel.append(explicit, node('span', '我已人工核验当前内容，明确标为已审核 / 重新审核。保存时将自动更新审核时间；需英文名称、MIC 及审核人，标准行业与标签均可留空；填写行业时须有对应来源依据。'));
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
  const heading = node('div', null, 'catalog-heading');
  const title = node('div', null, 'catalog-title');
  title.append(node('p', '数据查询', 'eyebrow'), node('h2', '词表维护'));
  heading.append(title, node('p', '集中查询标签与行业体系，点击词条后在右侧抽屉维护。', 'muted'));
  sidebar.append(heading);
  const toolbar = node('div', null, 'vocabulary-toolbar');
  const tabs = node('div', null, 'actions');
  for (const [kind, label] of [['tags', '标签'], ['industry_systems', '行业体系']]) {
    const tab = button(label, () => navigate(() => { state.vocabKind = kind; state.vocabId = null; }));
    tab.setAttribute('aria-pressed', String(state.vocabKind === kind));
    tabs.append(tab);
  }
  toolbar.append(tabs);
  toolbar.append(button('＋ 新增词条', () => navigate(() => { state.vocabId = '__new'; }), 'primary'));
  sidebar.append(toolbar);
  const search = node('input');
  search.type = 'search';
  search.placeholder = '搜索名称、稳定 ID、别名或说明';
  search.value = state.vocabQuery;
  search.addEventListener('input', () => {
    state.vocabQuery = search.value;
    const query = state.vocabQuery.trim().toLocaleLowerCase();
    let count = 0;
    for (const row of sidebar.querySelectorAll('tbody tr[data-search]')) {
      const visible = !query || row.dataset.search.includes(query);
      row.hidden = !visible;
      if (visible) count += 1;
    }
    sidebar.querySelector('.table-summary strong').textContent = `${count} 条结果`;
    sidebar.querySelector('.no-vocabulary-results').hidden = count > 0;
  });
  const searchField = node('div', null, 'vocabulary-search');
  field(searchField, '搜索词表', search);
  sidebar.append(searchField);
  const kind = state.vocabKind;
  const labels = state.dataset.vocabulary[kind];
  const query = state.vocabQuery.trim().toLocaleLowerCase();
  const visibleLabels = labels.filter((label) =>
    !query || [label.id, label.name_zh, label.description, ...label.aliases].some((value) => value?.toLocaleLowerCase().includes(query)));
  const summary = node('div', null, 'table-summary');
  summary.append(node('strong', `${visibleLabels.length} 条结果`), node('span', `共 ${labels.length} 条词条`, 'muted'));
  sidebar.append(summary);
  const shell = node('div', null, 'table-shell');
  const table = node('table', null, 'maintenance-table vocabulary-table');
  const head = node('thead');
  const headingRow = node('tr');
  for (const text of ['中文名称', '稳定 ID', '别名', '引用记录', '操作']) headingRow.append(node('th', text));
  head.append(headingRow);
  const body = node('tbody');
  for (const label of labels) {
    const row = node('tr');
    row.dataset.search = [label.id, label.name_zh, label.description, ...label.aliases]
      .filter(Boolean).join(' ').toLocaleLowerCase();
    row.hidden = Boolean(query) && !row.dataset.search.includes(query);
    if (state.vocabId === label.id) row.classList.add('selected');
    const name = node('td');
    const choose = button(`${label.name_zh} · ${label.id}`, () => navigate(() => { state.vocabId = label.id; }), 'record-button');
    choose.setAttribute('aria-pressed', String(state.vocabId === label.id));
    name.append(choose);
    const action = node('td');
    action.append(button('编辑', () => navigate(() => { state.vocabId = label.id; }), 'table-action'));
    row.append(
      name,
      node('td', label.id),
      node('td', label.aliases.join('、') || '—'),
      node('td', `${references(state.dataset, kind, label.id).length} 条`),
      action,
    );
    body.append(row);
  }
  {
    const empty = node('td', '没有匹配词条。请调整搜索条件。', 'empty');
    empty.colSpan = 5;
    const row = node('tr', null, 'no-vocabulary-results');
    row.hidden = visibleLabels.length > 0;
    row.append(empty);
    body.append(row);
  }
  table.append(head, body);
  shell.append(table);
  sidebar.append(shell);
  if (state.vocabId === null) return;
  detail.append(drawerHeader('标签与标准行业词表'));
  detail.append(node('p', '重命名只修改显示名称，不更换稳定 ID。被引用的词条不可直接删除；标签可显式合并 ID。词义、描述或别名变更会将引用记录标为需复核；依赖这些证券的已审核关联记录也将递归转为需复核，并全部列入变更清单。行业子项在高级 JSON 中维护，所有引用同样参与校验。', 'notice'));
  const formState = node('p', '词表修改同样只保存为内存草稿。', 'warning');
  formState.id = 'form-state';
  detail.append(formState);
  links(detail, 'data/vocabulary.json');
  const label = labels.find((item) => item.id === state.vocabId) ?? (state.vocabId === '__new'
    ? { id: '', name_zh: '', description: '', aliases: [], ...(kind === 'industry_systems' ? { sectors: [], industry_groups: [], industries: [] } : {}) }
    : null);
  if (label) {
    if (kind === 'industry_systems') renderIndustryTree(detail, label);
    renderLabelForm(detail, kind, label, labels.some((item) => item.id === label.id));
  }
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
  const id = input(
    group,
    exists ? '稳定 ID（不可修改）' : '稳定 ID（新建后不可修改）',
    label.id,
    exists ? null : '填写与词义相关的英文小写 ID，例如 satellite-communication；可使用数字和连字符，最长 100 个字符。',
  );
  id.readOnly = exists;
  id.maxLength = 100;
  id.pattern = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
  id.autocomplete = 'off';
  id.spellcheck = false;
  const name = input(group, '中文显示名称', label.name_zh);
  const description = input(group, '定义 / 说明', label.description, null, true);
  const aliases = input(group, '别名（每行一个）', label.aliases.join('\n'), '用于统一称呼。不能与同类词条名称 / 别名重复。', true);
  function noAdvancedChanges() {
    if (detail.querySelector('[data-vocabulary-editor]')?.dataset.changed === 'true') throw new Error('高级 JSON 编辑器有修改。请先保存它或放弃修改，避免相互覆盖。');
  }
  form.append(button('校验并保存词条草稿', () => {
    noAdvancedChanges();
    const nextId = exists ? label.id : id.value.trim();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(nextId)) {
      throw new Error('稳定 ID 格式无效：请填写英文小写语义词，可使用数字和单个连字符分隔，且必须以字母开头。');
    }
    if (!exists && state.dataset.vocabulary[kind].some((item) => item.id === nextId)) {
      throw new Error(`稳定 ID 已存在：${nextId}。请使用另一个能区分词义的 ID。`);
    }
    const vocabulary = clone(state.dataset.vocabulary);
    const next = { ...clone(label), id: nextId, name_zh: name.value.trim(), description: description.value, aliases: aliases.value.split('\n').map((value) => value.trim()).filter(Boolean) };
    const index = vocabulary[kind].findIndex((item) => item.id === label.id);
    if (index === -1) vocabulary[kind].push(next);
    else vocabulary[kind][index] = next;
    saveVocabulary(vocabulary);
    if (!state.dirty) {
      state.vocabId = next.id;
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
    if (kind === 'tags') {
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
        if (!window.confirm(`合并 ${label.id} → ${target.value}，将原子修改以下 ${files.length} 个文件：\n${description}\n\n确定保存完整内存草稿？后续必须通过同一个 PR 整体提交。`)) return;
        state.vocabId = target.value;
        commit(candidate, `已原子合并 ID。此次变更文件：\n${description}\n请通过同一个 PR 提交全部文件。`);
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

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && detail?.classList.contains('open')) closeEditor();
});

async function start() {
  const [responses, session] = await Promise.all([
    Promise.all([fetch('./source-data.json'), fetch('./site-config.json')]),
    getGitHubSession().catch((error) => ({
      enabled: error?.code !== 'not_configured',
      authenticated: false,
      user: null,
    })),
  ]);
  for (const response of responses) if (!response.ok) throw new Error(`无法加载本地文件：${response.url}（HTTP ${response.status}）`);
  const [dataset, config] = await Promise.all(responses.map((response) => response.json()));
  const errors = validateDataset(dataset);
  if (errors.length) throw new Error(`源数据校验失败，请修复仓库后重新构建：\n${errors.join('\n')}`);
  state.initial = clone(dataset);
  state.dataset = clone(dataset);
  state.config = config;
  state.pr.session = session;
  if (new URLSearchParams(window.location.search).has('github_login')) history.replaceState(null, '', window.location.pathname);
  render();
}

start().catch((error) => {
  app.replaceChildren(node('h2', '维护台加载失败'), node('pre', error.message), node('p', '请通过 HTTP 静态服务器打开构建后的页面，并确认 source-data.json 与 site-config.json 位于同一目录。此页未创建任何草稿。'));
});
