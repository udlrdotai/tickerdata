import { stableStringify } from '../src/model.js';
import { validateDataset, validateReviewTransitions } from '../src/validation.js';

const GITHUB_API = 'https://api.github.com';
const SESSION_COOKIE = '__Host-tickerdata_session';
const STATE_COOKIE = '__Host-tickerdata_oauth_state';
const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'tickerdata-maintenance',
  'X-GitHub-Api-Version': '2022-11-28',
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function sessionMaxAge(session) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = session.refreshExpiresAt ?? session.accessExpiresAt ?? now + 60 * 60 * 24 * 30;
  return Math.max(0, Math.min(expiresAt - now, 60 * 60 * 24 * 30));
}

function cookieValue(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function secretValue(binding) {
  return typeof binding === 'string' ? binding : binding.get();
}

async function encryptionKey(env) {
  if (!env.SESSION_SECRET) throw new ApiError(503, 'not_configured', '服务端尚未配置 SESSION_SECRET。');
  let raw;
  try {
    raw = base64UrlDecode(await secretValue(env.SESSION_SECRET));
  } catch {
    throw new ApiError(503, 'not_configured', 'SESSION_SECRET 必须是 base64url 编码的 32 字节密钥。');
  }
  if (raw.byteLength !== 32) throw new ApiError(503, 'not_configured', 'SESSION_SECRET 必须是 base64url 编码的 32 字节密钥。');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, value, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose) },
    await encryptionKey(env),
    plaintext,
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function open(env, value, purpose) {
  try {
    const [iv, ciphertext, extra] = String(value ?? '').split('.');
    if (!iv || !ciphertext || extra) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(iv), additionalData: new TextEncoder().encode(purpose) },
      await encryptionKey(env),
      base64UrlDecode(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return null;
  }
}

function requireGitHubConfig(env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new ApiError(503, 'not_configured', '服务端尚未配置 GitHub App。');
  }
}

function callbackUrl(request) {
  return `${new URL(request.url).origin}/api/auth/callback`;
}

async function tokenRequest(env, values) {
  requireGitHubConfig(env);
  const clientSecret = await secretValue(env.GITHUB_CLIENT_SECRET);
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: clientSecret,
      ...values,
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error || !payload.access_token) {
    throw new ApiError(401, 'auth', payload.error_description || 'GitHub 登录授权失败。');
  }
  return payload;
}

async function githubUser(accessToken) {
  const response = await fetch(`${GITHUB_API}/user`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new ApiError(401, 'auth', 'GitHub 登录已失效，请重新登录。');
  const user = await response.json();
  return { id: user.id, login: user.login, avatarUrl: user.avatar_url, profileUrl: user.html_url };
}

function sessionFromToken(token, user) {
  const now = Math.floor(Date.now() / 1000);
  return {
    accessToken: token.access_token,
    accessExpiresAt: token.expires_in ? now + Number(token.expires_in) : null,
    refreshToken: token.refresh_token ?? null,
    refreshExpiresAt: token.refresh_token_expires_in ? now + Number(token.refresh_token_expires_in) : null,
    user,
  };
}

async function readSession(request, env) {
  const session = await open(env, cookieValue(request, SESSION_COOKIE), SESSION_COOKIE);
  if (!session?.accessToken || !session?.user?.login) return { session: null, setCookie: null };
  const now = Math.floor(Date.now() / 1000);
  if (!session.accessExpiresAt || session.accessExpiresAt > now + 60) return { session, setCookie: null };
  if (!session.refreshToken || (session.refreshExpiresAt && session.refreshExpiresAt <= now)) {
    return { session: null, setCookie: cookie(SESSION_COOKIE, '', 0) };
  }
  try {
    const token = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: session.refreshToken });
    const refreshed = sessionFromToken(token, session.user);
    return {
      session: refreshed,
      setCookie: cookie(SESSION_COOKIE, await seal(env, refreshed, SESSION_COOKIE), sessionMaxAge(refreshed)),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'auth') {
      return { session: null, setCookie: cookie(SESSION_COOKIE, '', 0) };
    }
    throw error;
  }
}

function validateOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'origin', '请求来源校验失败，请刷新页面后重试。');
  }
}

async function githubRequest(accessToken, owner, repo, method, path, body) {
  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}${path}`, {
    method,
    headers: {
      ...API_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    if (response.status === 401) throw new ApiError(401, 'auth', 'GitHub 登录已失效，请重新登录。');
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') throw new ApiError(429, 'rate_limit', 'GitHub API 触发限流，请稍后重试。');
    if (response.status === 403) throw new ApiError(403, 'permission', 'GitHub App 未安装到目标仓库，或当前用户没有足够权限。');
    if (response.status === 404) throw new ApiError(404, 'not_found', payload?.message || 'GitHub 资源不存在。');
    if (response.status === 409) throw new ApiError(409, 'conflict', payload?.message || 'GitHub 检测到提交冲突。');
    if (response.status === 422) throw new ApiError(422, 'validation', payload?.message || 'GitHub 参数校验失败。');
    throw new ApiError(502, 'github', payload?.message || `GitHub API 请求失败（HTTP ${response.status}）。`);
  }
  return payload;
}

function encodeRef(value) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function parseRepository(config) {
  const match = String(config?.repository_url ?? '').match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match || !String(config?.branch ?? '').trim()) throw new ApiError(503, 'not_configured', '站点未配置有效的 GitHub 仓库和默认分支。');
  return { owner: match[1], repo: match[2], baseBranch: config.branch.trim() };
}

function sanitizeBranchName(value) {
  const cleaned = String(value ?? '').trim().replace(/^refs\/heads\//, '');
  if (!/^[A-Za-z0-9._/-]+$/.test(cleaned) || cleaned.startsWith('.') || cleaned.endsWith('.') ||
      cleaned.endsWith('/') || cleaned.endsWith('.lock') || cleaned.includes('..') ||
      cleaned.includes('@{') || cleaned.includes('//')) {
    throw new ApiError(422, 'branch', '分支名无效。请只使用字母、数字、-、_、.、/。');
  }
  return cleaned;
}

function normalizeSubmission(input) {
  if (!input || !Array.isArray(input.files) || !input.files.length || input.files.length > 100) {
    throw new ApiError(422, 'validation', '变更文件数量必须在 1 到 100 之间。');
  }
  const normalized = {
    files: input.files,
    branch: sanitizeBranchName(input.branch),
    commitMessage: String(input.commitMessage ?? '').trim(),
    title: String(input.title ?? '').trim(),
    body: String(input.body ?? '').trim(),
  };
  if (!normalized.commitMessage || normalized.commitMessage.length > 256) throw new ApiError(422, 'validation', '提交信息不能为空且不能超过 256 个字符。');
  if (!normalized.title || normalized.title.length > 256) throw new ApiError(422, 'validation', 'PR 标题不能为空且不能超过 256 个字符。');
  if (!normalized.body || normalized.body.length > 65536) throw new ApiError(422, 'validation', 'PR 描述不能为空且不能超过 65536 个字符。');
  return normalized;
}

export function applyFiles(initial, files) {
  const candidate = structuredClone(initial);
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || seen.has(file.path)) throw new ApiError(422, 'validation', '变更文件路径无效或重复。');
    seen.add(file.path);
    if (file.path === 'data/vocabulary.json') {
      candidate.vocabulary = file.content;
      continue;
    }
    const id = file.path.match(/^data\/instruments\/([A-Za-z0-9_-]+)\.json$/)?.[1];
    if (!id || file.content?.id !== id) throw new ApiError(422, 'validation', `不允许提交文件：${file.path}`);
    const index = candidate.instruments.findIndex((record) => record.id === id);
    if (index === -1) candidate.instruments.push(file.content);
    else candidate.instruments[index] = file.content;
  }
  const errors = [...validateDataset(candidate), ...validateReviewTransitions(initial, candidate)];
  if (errors.length) throw new ApiError(422, 'validation', `提交内容未通过数据校验：\n${errors.join('\n')}`);
  return candidate;
}

function expectedContent(initial, path) {
  if (path === 'data/vocabulary.json') return initial.vocabulary;
  const id = path.match(/^data\/instruments\/(.+)\.json$/)?.[1];
  return initial.instruments.find((record) => record.id === id);
}

async function loadAssetJson(request, env, path) {
  const response = await env.ASSETS.fetch(new URL(path, request.url));
  if (!response.ok) throw new ApiError(503, 'assets', `无法读取部署资源：${path}`);
  return response.json();
}

async function createPullRequest(request, env, accessToken) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new ApiError(413, 'too_large', '提交内容不能超过 1 MiB。');
  const input = normalizeSubmission(JSON.parse(text));
  const [config, initial] = await Promise.all([
    loadAssetJson(request, env, '/site-config.json'),
    loadAssetJson(request, env, '/source-data.json'),
  ]);
  applyFiles(initial, input.files);
  const { owner, repo, baseBranch } = parseRepository(config);
  let baseRef;
  try {
    baseRef = await githubRequest(accessToken, owner, repo, 'GET', `/git/ref/heads/${encodeRef(baseBranch)}`);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'not_found') throw new ApiError(503, 'config', `默认分支 ${baseBranch} 不存在。`);
    throw error;
  }
  const baseSha = baseRef?.object?.sha;
  const baseCommit = baseSha && await githubRequest(accessToken, owner, repo, 'GET', `/git/commits/${baseSha}`);
  if (!baseSha || !baseCommit?.tree?.sha) throw new ApiError(502, 'github', '无法读取默认分支最新提交。');

  for (const file of input.files) {
    const expected = expectedContent(initial, file.path);
    const path = file.path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(baseBranch)}`, {
      headers: { ...API_HEADERS, Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 404 && expected === undefined) continue;
    if (!response.ok) {
      if (response.status === 404) throw new ApiError(409, 'source_changed', `文件 ${file.path} 在仓库中不存在，请刷新后重试。`);
      throw new ApiError(response.status === 403 ? 403 : 502, response.status === 403 ? 'permission' : 'github', `读取仓库文件失败：${file.path}（HTTP ${response.status}）`);
    }
    const payload = await response.json();
    const current = new TextDecoder().decode(base64UrlDecode(String(payload.content ?? '').replace(/\n/g, '').replace(/\+/g, '-').replace(/\//g, '_')));
    if (expected === undefined || current !== stableStringify(expected)) {
      throw new ApiError(409, 'source_changed', `文件 ${file.path} 已在远端发生变化，请刷新页面后重试。`);
    }
  }

  const tree = await githubRequest(accessToken, owner, repo, 'POST', '/git/trees', {
    base_tree: baseCommit.tree.sha,
    tree: input.files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: stableStringify(file.content) })),
  });
  const commit = await githubRequest(accessToken, owner, repo, 'POST', '/git/commits', {
    message: input.commitMessage,
    tree: tree.sha,
    parents: [baseSha],
  });
  try {
    await githubRequest(accessToken, owner, repo, 'POST', '/git/refs', { ref: `refs/heads/${input.branch}`, sha: commit.sha });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'validation') throw new ApiError(409, 'branch_exists', '分支名已存在，请更换分支名后重试。');
    throw error;
  }
  try {
    const pull = await githubRequest(accessToken, owner, repo, 'POST', '/pulls', {
      title: input.title,
      body: input.body,
      head: input.branch,
      base: baseBranch,
    });
    return { url: pull.html_url, number: pull.number, branch: input.branch, baseBranch };
  } catch (error) {
    const cleanup = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${encodeRef(input.branch)}`, {
      method: 'DELETE',
      headers: { ...API_HEADERS, Authorization: `Bearer ${accessToken}` },
    });
    if (!cleanup.ok) error.message += ' 临时分支回滚失败，请在 GitHub 中手动删除。';
    throw error;
  }
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/auth/login') {
    requireGitHubConfig(env);
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
    const stateCookie = await seal(env, { state, expiresAt: Date.now() + 10 * 60 * 1000 }, STATE_COOKIE);
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', callbackUrl(request));
    authorize.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { Location: authorize.toString(), 'Set-Cookie': cookie(STATE_COOKIE, stateCookie, 600), 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/callback') {
    const saved = await open(env, cookieValue(request, STATE_COOKIE), STATE_COOKIE);
    if (!saved || saved.expiresAt < Date.now() || saved.state !== url.searchParams.get('state')) throw new ApiError(400, 'oauth_state', 'GitHub 登录状态无效或已过期，请重新登录。');
    const code = url.searchParams.get('code');
    if (!code) throw new ApiError(400, 'auth', 'GitHub 未返回授权码。');
    const token = await tokenRequest(env, { code, redirect_uri: callbackUrl(request) });
    const session = sessionFromToken(token, await githubUser(token.access_token));
    const headers = new Headers({ Location: '/?github_login=success', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookie(SESSION_COOKIE, await seal(env, session, SESSION_COOKIE), sessionMaxAge(session)));
    headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0));
    return new Response(null, { status: 302, headers });
  }
  if (request.method === 'GET' && url.pathname === '/api/auth/session') {
    requireGitHubConfig(env);
    const result = await readSession(request, env);
    return json(
      { enabled: true, authenticated: Boolean(result.session), user: result.session?.user ?? null },
      200,
      result.setCookie ? { 'Set-Cookie': result.setCookie } : {},
    );
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    validateOrigin(request);
    return json({ authenticated: false }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
  }
  if (request.method === 'POST' && url.pathname === '/api/github/pulls') {
    validateOrigin(request);
    const result = await readSession(request, env);
    if (!result.session) {
      return json(
        { code: 'auth', message: '请先使用 GitHub 登录。' },
        401,
        result.setCookie ? { 'Set-Cookie': result.setCookie } : {},
      );
    }
    try {
      const payload = await createPullRequest(request, env, result.session.accessToken);
      return json(payload, 201, result.setCookie ? { 'Set-Cookie': result.setCookie } : {});
    } catch (error) {
      if (!result.setCookie) throw error;
      if (error instanceof SyntaxError) return json({ code: 'invalid_json', message: '请求 JSON 格式无效。' }, 400, { 'Set-Cookie': result.setCookie });
      if (error instanceof ApiError) return json({ code: error.code, message: error.message }, error.status, { 'Set-Cookie': result.setCookie });
      throw error;
    }
  }
  throw new ApiError(404, 'not_found', 'API 路径不存在。');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env);
    } catch (error) {
      if (error instanceof SyntaxError) return json({ code: 'invalid_json', message: '请求 JSON 格式无效。' }, 400);
      if (error instanceof ApiError) return json({ code: error.code, message: error.message }, error.status);
      console.error('Unhandled API error', error);
      return json({ code: 'internal', message: '服务端处理失败，请稍后重试。' }, 500);
    }
  },
};
