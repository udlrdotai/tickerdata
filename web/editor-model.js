import { SCHEMA_VERSION, stableStringify } from '../src/model.js';
import { validateDatasetShape } from '../src/validation.js';

export const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => stableStringify(a) === stableStringify(b);

export function industryChoices(vocabulary, selection) {
  const system = vocabulary.industry_systems.find((item) => item.id === selection.system_id);
  const groups = system?.industry_groups ?? [];
  const sector = selection.sector_id || groups.find((item) => item.id === selection.industry_group_id)?.sector_id;
  const compatible = (selected, parent) => !selected || !parent || selected === parent;
  return {
    sectors: system?.sectors ?? [],
    industry_groups: groups.filter((item) => compatible(selection.sector_id, item.sector_id)),
    industries: (system?.industries ?? []).filter((item) =>
      compatible(sector, item.sector_id) &&
      compatible(sector, groups.find((group) => group.id === item.industry_group_id)?.sector_id) &&
      compatible(selection.industry_group_id, item.industry_group_id)),
  };
}

export function changeIndustrySelection(vocabulary, selection, field, value) {
  const next = clone(selection);
  next[field] = value || null;
  if (field === 'system_id') {
    next.sector_id = next.industry_group_id = next.industry_id = null;
    return next;
  }
  const system = vocabulary.industry_systems.find((item) => item.id === next.system_id);
  if (field === 'industry_id') {
    const industry = system?.industries.find((item) => item.id === next.industry_id);
    const group = system?.industry_groups.find((item) => item.id === industry?.industry_group_id);
    if (industry?.sector_id || group?.sector_id) next.sector_id = industry?.sector_id || group.sector_id;
    if (industry?.industry_group_id) next.industry_group_id = industry.industry_group_id;
  } else {
    if (field === 'industry_group_id') {
      const group = system?.industry_groups.find((item) => item.id === next.industry_group_id);
      if (group) next.sector_id = group.sector_id;
    }
    if (!industryChoices(vocabulary, next).industry_groups.some((item) => item.id === next.industry_group_id)) {
      next.industry_group_id = null;
    }
    if (!industryChoices(vocabulary, next).industries.some((item) => item.id === next.industry_id)) {
      next.industry_id = null;
    }
  }
  return next;
}

export function matchesRecord(record, filters) {
  const haystack = [
    record.id, record.symbol.original, record.symbol.canonical, record.symbol.mic,
    record.name.en, record.name.zh,
    ...record.symbol.aliases.flatMap((item) => [item.provider, item.symbol]),
    ...record.symbol.history.flatMap((item) => [item.symbol, item.mic]),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  return haystack.includes((filters.query ?? '').trim().toLocaleLowerCase()) &&
    (!filters.type || record.security_type === filters.type) &&
    (!filters.tag || record.classification.tag_ids.includes(filters.tag)) &&
    (!filters.review || record.review.status === filters.review);
}

export function prepareRecord(previous, next, explicitlyReviewed = false) {
  const record = clone(next);
  if (previous && previous.id !== record.id) throw new Error('内部 ID 不可更改；证券代码变更请保留 ID 并维护历史代码。');
  if (previous?.review.status === 'reviewed' && !same(previous, record) && !explicitlyReviewed) {
    record.review.status = 'needs_review';
  }
  if (record.review.status === 'reviewed' && (!previous || previous.review.status !== 'reviewed') && !explicitlyReviewed) {
    record.review.status = 'needs_review';
  }
  if (explicitlyReviewed) {
    const now = Date.now();
    const previousTimestamp = previous?.review.reviewed_at;
    if (previousTimestamp !== null && previousTimestamp !== undefined) {
      const previousTime = Date.parse(previousTimestamp);
      if (!Number.isFinite(previousTime) || previousTime >= now) {
        throw new Error('无法重新审核：原审核时间无效，或不早于当前 UTC 时间。请先标为需复核；修正源数据中的审核时间并重新加载，或等待真实时间晚于原时间后再审核。不会自动生成未来审核时间。');
      }
    }
    record.review.status = 'reviewed';
    record.review.reviewed_at = new Date(now).toISOString();
  }
  return record;
}

export function references(dataset, kind, id) {
  if (!['tags', 'industry_systems'].includes(kind)) throw new Error('只支持标签和行业体系引用。');
  return dataset.instruments.filter((record) => kind === 'tags'
    ? record.classification.tag_ids.includes(id) : record.industry.system_id === id);
}

export function downgradeRelatedReviews(dataset) {
  const byId = new Map(dataset.instruments.map((record) => [record.id, record]));
  let changed;
  do {
    changed = false;
    for (const record of dataset.instruments) {
      if (record.review.status === 'reviewed' &&
          record.related_instrument_ids.some((id) => byId.get(id)?.review.status !== 'reviewed')) {
        record.review.status = 'needs_review';
        changed = true;
      }
    }
  } while (changed);
  return dataset;
}

export function applyVocabulary(dataset, vocabulary) {
  const next = clone(dataset);
  next.vocabulary = clone(vocabulary);
  return markVocabularyChanges(dataset, next);
}

function markVocabularyChanges(dataset, next) {
  const vocabulary = next.vocabulary;
  for (const kind of ['tags', 'industry_systems']) {
    for (const before of dataset.vocabulary[kind]) {
      const after = vocabulary[kind].find((item) => item.id === before.id);
      const affected = references(next, kind, before.id);
      if (!after && affected.length) throw new Error(`不能删除被引用的 ${before.id}（${affected.length} 条）；请先合并或移除引用。`);
      if (after && !same(before, after)) {
        for (const record of affected) record.review.status = 'needs_review';
      }
    }
  }
  return downgradeRelatedReviews(next);
}

export function assertCurrentImportVersion(value) {
  const parts = [value, value?.vocabulary, ...(Array.isArray(value?.instruments) ? value.instruments : [])];
  if (parts.some((part) => ['1.0.0', '2.0.0'].includes(part?.schema_version))) {
    throw new Error(`仅支持 schema_version ${SCHEMA_VERSION} 导入；旧版文件请先在仓库运行 npm run migrate -- legacy.json 预览迁移，再按输出指引应用迁移并重新构建。不会自动丢弃旧版分类。`);
  }
}

export function prepareImportedDataset(current, candidate) {
  assertCurrentImportVersion(candidate);
  const errors = validateDatasetShape(candidate);
  if (errors.length) throw new Error(`导入结构无效：\n${errors.join('\n')}`);
  const next = clone(candidate);
  next.instruments = next.instruments.map((record) =>
    prepareRecord(current.instruments.find((item) => item.id === record.id), record));
  return markVocabularyChanges(current, next);
}

export function mergeVocabulary(dataset, kind, fromId, toId) {
  if (kind !== 'tags') throw new Error('只支持标签的 ID 合并。');
  const next = clone(dataset);
  const labels = next.vocabulary[kind];
  const from = labels.find((item) => item.id === fromId);
  const to = labels.find((item) => item.id === toId);
  if (!from || !to || fromId === toId) throw new Error('请选择两个不同且存在的词条。');
  const names = new Set([to.name_zh, ...to.aliases].map((name) => name.trim().toLocaleLowerCase()));
  for (const name of [from.name_zh, ...from.aliases]) {
    const key = name.trim().toLocaleLowerCase();
    if (!names.has(key)) { to.aliases.push(name); names.add(key); }
  }
  for (const record of references(next, kind, fromId)) {
    record.classification.tag_ids = [...new Set(record.classification.tag_ids.map((id) => id === fromId ? toId : id))];
    record.review.status = 'needs_review';
  }
  // The surviving label's meaning/aliases also changed.
  for (const record of references(next, kind, toId)) record.review.status = 'needs_review';
  next.vocabulary[kind] = labels.filter((item) => item.id !== fromId);
  return downgradeRelatedReviews(next);
}

export function changedFiles(initial, current) {
  const files = [];
  if (!same(initial.vocabulary, current.vocabulary)) files.push({ path: 'data/vocabulary.json', content: clone(current.vocabulary) });
  for (const record of current.instruments) {
    const before = initial.instruments.find((item) => item.id === record.id);
    if (!before || !same(before, record)) files.push({ path: `data/instruments/${record.id}.json`, content: clone(record) });
  }
  return files;
}

export function githubLinks(config, path, exists = true) {
  if (!config || typeof config.repository_url !== 'string' ||
      !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/.test(config.repository_url) ||
      typeof config.branch !== 'string' || !config.branch.trim()) return [];
  const root = config.repository_url.replace(/\/$/, '');
  const branch = encodeURIComponent(config.branch);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return exists ? [
    ['源文件', `${root}/blob/${branch}/${encodedPath}`],
    ['在 GitHub 编辑', `${root}/edit/${branch}/${encodedPath}`],
    ['提交历史', `${root}/commits/${branch}/${encodedPath}`],
  ] : [['在 GitHub 新建文件', `${root}/new/${branch}?filename=${encodeURIComponent(path)}`]];
}
