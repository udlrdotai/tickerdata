import { stableStringify } from '../src/model.js';

const API_ROOT = 'https://api.github.com';

export class GitHubSubmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubSubmissionError';
    this.code = code;
  }
}

export function parseGitHubRepository(config) {
  const match = String(config?.repository_url ?? '').trim().match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if (!match) throw new GitHubSubmissionError('config', '未配置有效的 GitHub 仓库地址。请先检查 site-config.json 中的 repository_url。');
  const branch = String(config?.branch ?? '').trim();
  if (!branch) throw new GitHubSubmissionError('config', '未配置默认分支。请先检查 site-config.json 中的 branch。');
  return { owner: match[1], repo: match[2], baseBranch: branch };
}

export function sanitizeBranchName(value) {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '')
    .replace(/\/$/g, '');
  if (!cleaned || cleaned.startsWith('.') || cleaned.endsWith('.lock') || cleaned.includes('..') || cleaned.includes('@{')) {
    throw new GitHubSubmissionError('branch', '分支名无效。请使用字母、数字、-、_、.、/，并避免以点开头、包含 .. 或 @{。');
  }
  return cleaned;
}

export function defaultPrDraft(files, now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').toLowerCase();
  const branch = `maintenance/${iso}`;
  const title = `chore: update maintenance data (${files.length} files)`;
  const body = [
    '## 变更说明',
    '',
    '本 PR 由维护台直接创建，请结合 diff 进行人工复核。',
    '',
    '## 变更文件',
    ...files.map((file) => `- \`${file.path}\``),
  ].join('\n');
  return { branch, commitMessage: title, title, body };
}

function encodeContent(value) {
  return stableStringify(value);
}

function decodeContent(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\n/g, '');
  if (typeof atob === 'function') {
    const bytes = atob(normalized);
    return decodeURIComponent(Array.from(bytes).map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
  }
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function authHeaders(token, extra = {}) {
  return {
    Authorization: 'token ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function githubRequest({ fetchImpl, token, owner, repo }, method, path, body) {
  const response = await fetchImpl(`${API_ROOT}/repos/${owner}/${repo}${path}`, {
    method,
    headers: authHeaders(token, body ? { 'Content-Type': 'application/json' } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    if (response.status === 401) throw new GitHubSubmissionError('auth', 'GitHub 认证失败：Token 无效或已过期。');
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubSubmissionError('rate_limit', 'GitHub API 触发限流，请稍后重试。');
    }
    if (response.status === 403) throw new GitHubSubmissionError('permission', '没有足够权限写入仓库。请检查 Token 权限（contents:write, pull_requests:write）。');
    if (response.status === 422) throw new GitHubSubmissionError('validation', payload?.message || 'GitHub 参数校验失败。');
    if (response.status === 409) throw new GitHubSubmissionError('conflict', payload?.message || 'GitHub 检测到提交冲突。请刷新后重试。');
    throw new GitHubSubmissionError('api', payload?.message || `GitHub API 请求失败（HTTP ${response.status}）。`);
  }
  return payload;
}

function initialContentForPath(initial, path) {
  if (path === 'data/vocabulary.json') return initial.vocabulary;
  const id = path.match(/^data\/instruments\/(.+)\.json$/)?.[1];
  if (!id) return undefined;
  return initial.instruments.find((record) => record.id === id);
}

function normalizeInput({ token, branch, commitMessage, title, body }) {
  const normalized = {
    token: String(token ?? '').trim(),
    branch: sanitizeBranchName(branch),
    commitMessage: String(commitMessage ?? '').trim(),
    title: String(title ?? '').trim(),
    body: String(body ?? '').trim(),
  };
  if (!normalized.token) throw new GitHubSubmissionError('auth', '请输入 GitHub Token。');
  if (!normalized.commitMessage) throw new GitHubSubmissionError('validation', '提交信息不能为空。');
  if (!normalized.title) throw new GitHubSubmissionError('validation', 'PR 标题不能为空。');
  if (!normalized.body) throw new GitHubSubmissionError('validation', 'PR 描述不能为空。');
  return normalized;
}

export async function createPullRequestFromDraft({
  config,
  initial,
  files,
  token,
  branch,
  commitMessage,
  title,
  body,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(files) || !files.length) throw new GitHubSubmissionError('validation', '当前没有可提交的变更文件。');
  const { owner, repo, baseBranch } = parseGitHubRepository(config);
  const input = normalizeInput({ token, branch, commitMessage, title, body });
  const context = { fetchImpl, token: input.token, owner, repo };
  const baseRef = await githubRequest(context, 'GET', `/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef?.object?.sha;
  if (!baseSha) throw new GitHubSubmissionError('api', '无法读取默认分支最新提交。');
  const baseCommit = await githubRequest(context, 'GET', `/git/commits/${baseSha}`);
  const baseTree = baseCommit?.tree?.sha;
  if (!baseTree) throw new GitHubSubmissionError('api', '无法读取默认分支 tree。');

  for (const file of files) {
    const expected = initialContentForPath(initial, file.path);
    const response = await fetchImpl(
      `${API_ROOT}/repos/${owner}/${repo}/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(baseBranch)}`,
      { headers: authHeaders(input.token) },
    );
    if (response.status === 404 && expected === undefined) continue;
    if (!response.ok) {
      if (response.status === 404) throw new GitHubSubmissionError('source_changed', `文件 ${file.path} 在仓库中不存在，无法确认基线是否一致。请刷新页面后重试。`);
      if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new GitHubSubmissionError('rate_limit', 'GitHub API 触发限流，请稍后重试。');
      throw new GitHubSubmissionError('api', `读取仓库文件失败：${file.path}（HTTP ${response.status}）`);
    }
    const payload = await response.json();
    const current = decodeContent(payload?.content);
    const baseline = expected === undefined ? null : encodeContent(expected);
    if (baseline === null || current !== baseline) {
      throw new GitHubSubmissionError('source_changed', `文件 ${file.path} 已在远端发生变化。请刷新页面重新加载后再提交 PR。`);
    }
  }

  const tree = await githubRequest(context, 'POST', '/git/trees', {
    base_tree: baseTree,
    tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: encodeContent(file.content) })),
  });
  const commit = await githubRequest(context, 'POST', '/git/commits', {
    message: input.commitMessage,
    tree: tree.sha,
    parents: [baseSha],
  });

  try {
    await githubRequest(context, 'POST', '/git/refs', { ref: `refs/heads/${input.branch}`, sha: commit.sha });
  } catch (error) {
    if (error instanceof GitHubSubmissionError && error.code === 'validation') {
      throw new GitHubSubmissionError('branch_exists', '分支名已存在，请更换分支名后重试。');
    }
    throw error;
  }

  try {
    const pull = await githubRequest(context, 'POST', '/pulls', {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: baseBranch,
    });
    return { url: pull.html_url, number: pull.number, branch: input.branch, baseBranch };
  } catch (error) {
    await fetchImpl(`${API_ROOT}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(input.branch)}`, {
      method: 'DELETE',
      headers: authHeaders(input.token),
    }).catch(() => {});
    throw error;
  }
}
