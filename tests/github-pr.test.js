import test from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify } from '../src/model.js';
import { createPullRequestFromDraft, defaultPrDraft, parseGitHubRepository, sanitizeBranchName } from '../web/github-pr.js';

function jsonResponse(status, payload, extraHeaders = {}) {
  const headers = new Map(Object.entries(extraHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers.get(String(key).toLowerCase()) ?? null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function fixture() {
  return {
    config: { repository_url: 'https://github.com/owner/repo', branch: 'main' },
    initial: {
      schema_version: '3.0.0',
      vocabulary: { schema_version: '3.0.0', tags: [], industry_systems: [] },
      instruments: [],
    },
    files: [{ path: 'data/vocabulary.json', content: { schema_version: '3.0.0', tags: [{ id: 'tag-a', name_zh: 'A', aliases: [], description: '' }], industry_systems: [] } }],
  };
}

test('repository parsing, default draft and branch sanitization are deterministic', () => {
  assert.deepEqual(parseGitHubRepository({ repository_url: 'https://github.com/a-b/repo_1/', branch: 'main' }), { owner: 'a-b', repo: 'repo_1', baseBranch: 'main' });
  assert.equal(sanitizeBranchName(' refs/heads/feature/中文 name '), 'feature/-name');
  assert.throws(() => sanitizeBranchName('..bad'), /分支名无效/);
  const draft = defaultPrDraft([{ path: 'data/a.json' }, { path: 'data/b.json' }], new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(draft.branch, 'maintenance/20260102t030405z');
  assert.match(draft.body, /data\/a\.json/);
});

test('createPullRequestFromDraft creates branch, commit and PR in order', async () => {
  const data = fixture();
  const calls = [];
  const baseline = stableStringify(data.initial.vocabulary);
  const fetchImpl = async (url, options = {}) => {
    calls.push([options.method ?? 'GET', url]);
    if (url.endsWith('/git/ref/heads/main')) return jsonResponse(200, { object: { sha: 'base-sha' } });
    if (url.endsWith('/git/commits/base-sha')) return jsonResponse(200, { tree: { sha: 'tree-sha' } });
    if (url.includes('/contents/data/vocabulary.json?ref=main')) {
      return jsonResponse(200, { content: Buffer.from(baseline, 'utf8').toString('base64') });
    }
    if (url.endsWith('/git/trees')) return jsonResponse(201, { sha: 'new-tree' });
    if (url.endsWith('/git/commits')) return jsonResponse(201, { sha: 'new-commit' });
    if (url.endsWith('/git/refs')) return jsonResponse(201, { ref: 'refs/heads/maintenance/ok' });
    if (url.endsWith('/pulls')) return jsonResponse(201, { html_url: 'https://github.com/owner/repo/pull/123', number: 123 });
    throw new Error(`Unexpected request: ${url}`);
  };
  const result = await createPullRequestFromDraft({
    ...data,
    token: 'test-token',
    branch: 'maintenance/ok',
    commitMessage: 'chore: update',
    title: 'chore: update',
    body: 'body',
    fetchImpl,
  });
  assert.equal(result.url, 'https://github.com/owner/repo/pull/123');
  assert.deepEqual(calls.map(([method, url]) => `${method} ${new URL(url).pathname}`), [
    'GET /repos/owner/repo/git/ref/heads/main',
    'GET /repos/owner/repo/git/commits/base-sha',
    'GET /repos/owner/repo/contents/data/vocabulary.json',
    'POST /repos/owner/repo/git/trees',
    'POST /repos/owner/repo/git/commits',
    'POST /repos/owner/repo/git/refs',
    'POST /repos/owner/repo/pulls',
  ]);
});

test('createPullRequestFromDraft rejects branch collision and source drift', async () => {
  const data = fixture();
  const baseline = stableStringify(data.initial.vocabulary);
  const branchExistsFetch = async (url) => {
    if (url.endsWith('/git/ref/heads/main')) return jsonResponse(200, { object: { sha: 'base-sha' } });
    if (url.endsWith('/git/commits/base-sha')) return jsonResponse(200, { tree: { sha: 'tree-sha' } });
    if (url.includes('/contents/data/vocabulary.json?ref=main')) return jsonResponse(200, { content: Buffer.from(baseline, 'utf8').toString('base64') });
    if (url.endsWith('/git/trees')) return jsonResponse(201, { sha: 'new-tree' });
    if (url.endsWith('/git/commits')) return jsonResponse(201, { sha: 'new-commit' });
    if (url.endsWith('/git/refs')) return jsonResponse(422, { message: 'Reference already exists' });
    throw new Error(`Unexpected request: ${url}`);
  };
  await assert.rejects(
    () => createPullRequestFromDraft({ ...data, token: 'token', branch: 'maintenance/existing', commitMessage: 'msg', title: 'title', body: 'body', fetchImpl: branchExistsFetch }),
    /分支名已存在/,
  );
  const changedFetch = async (url) => {
    if (url.endsWith('/git/ref/heads/main')) return jsonResponse(200, { object: { sha: 'base-sha' } });
    if (url.endsWith('/git/commits/base-sha')) return jsonResponse(200, { tree: { sha: 'tree-sha' } });
    if (url.includes('/contents/data/vocabulary.json?ref=main')) return jsonResponse(200, { content: Buffer.from('{"changed":true}', 'utf8').toString('base64') });
    throw new Error(`Unexpected request: ${url}`);
  };
  await assert.rejects(
    () => createPullRequestFromDraft({ ...data, token: 'token', branch: 'maintenance/new', commitMessage: 'msg', title: 'title', body: 'body', fetchImpl: changedFetch }),
    /远端发生变化/,
  );
});

test('createPullRequestFromDraft surfaces rate limit and token errors', async () => {
  const data = fixture();
  const limitedFetch = async () => jsonResponse(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0' });
  await assert.rejects(
    () => createPullRequestFromDraft({ ...data, token: 'token', branch: 'maintenance/new', commitMessage: 'msg', title: 'title', body: 'body', fetchImpl: limitedFetch }),
    /触发限流/,
  );
  const authFetch = async () => jsonResponse(401, { message: 'bad credentials' });
  await assert.rejects(
    () => createPullRequestFromDraft({ ...data, token: 'token', branch: 'maintenance/new', commitMessage: 'msg', title: 'title', body: 'body', fetchImpl: authFetch }),
    /认证失败/,
  );
});
