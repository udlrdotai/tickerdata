export class GitHubSubmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitHubSubmissionError';
    this.code = code;
  }
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

function normalizeInput({ branch, commitMessage, title, body }) {
  const normalized = {
    branch: sanitizeBranchName(branch),
    commitMessage: String(commitMessage ?? '').trim(),
    title: String(title ?? '').trim(),
    body: String(body ?? '').trim(),
  };
  if (!normalized.commitMessage) throw new GitHubSubmissionError('validation', '提交信息不能为空。');
  if (!normalized.title) throw new GitHubSubmissionError('validation', 'PR 标题不能为空。');
  if (!normalized.body) throw new GitHubSubmissionError('validation', 'PR 描述不能为空。');
  return normalized;
}

export async function createPullRequestFromDraft({
  files,
  branch,
  commitMessage,
  title,
  body,
  fetchImpl = fetch,
}) {
  if (!Array.isArray(files) || !files.length) throw new GitHubSubmissionError('validation', '当前没有可提交的变更文件。');
  const input = normalizeInput({ branch, commitMessage, title, body });
  const response = await fetchImpl('/api/github/pulls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ files, ...input }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new GitHubSubmissionError(payload?.code ?? 'api', payload?.message ?? `提交 PR 失败（HTTP ${response.status}）。`);
  return payload;
}

export async function getGitHubSession(fetchImpl = fetch) {
  const response = await fetchImpl('/api/auth/session', { credentials: 'same-origin' });
  if (response.status === 404) return { enabled: false, authenticated: false, user: null };
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new GitHubSubmissionError(payload?.code ?? 'auth', payload?.message ?? '无法读取 GitHub 登录状态。');
  return payload;
}

export async function logoutGitHub(fetchImpl = fetch) {
  const response = await fetchImpl('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new GitHubSubmissionError(payload?.code ?? 'auth', payload?.message ?? 'GitHub 退出登录失败。');
  return payload;
}
