import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPullRequestFromDraft,
  defaultPrDraft,
  getGitHubSession,
  logoutGitHub,
  sanitizeBranchName,
} from '../web/github-pr.js';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test('default draft and branch sanitization are deterministic', () => {
  assert.equal(sanitizeBranchName(' refs/heads/feature/中文 name '), 'feature/-name');
  assert.throws(() => sanitizeBranchName('..bad'), /分支名无效/);
  const draft = defaultPrDraft([{ path: 'data/a.json' }, { path: 'data/b.json' }], new Date('2026-01-02T03:04:05.000Z'));
  assert.equal(draft.branch, 'maintenance/20260102t030405z');
  assert.match(draft.body, /data\/a\.json/);
});

test('PR submission sends only draft data to the same-origin backend', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return jsonResponse(201, { url: 'https://github.com/owner/repo/pull/123', number: 123 });
  };
  const files = [{ path: 'data/vocabulary.json', content: { schema_version: '3.0.0' } }];
  const result = await createPullRequestFromDraft({
    files,
    branch: 'maintenance/ok',
    commitMessage: 'chore: update',
    title: 'chore: update',
    body: 'body',
    fetchImpl,
  });
  assert.equal(result.url, 'https://github.com/owner/repo/pull/123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/github/pulls');
  assert.deepEqual(
    { method: calls[0][1].method, credentials: calls[0][1].credentials, headers: calls[0][1].headers },
    { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } },
  );
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    files,
    branch: 'maintenance/ok',
    commitMessage: 'chore: update',
    title: 'chore: update',
    body: 'body',
  });
  assert.equal(calls[0][1].headers.Authorization, undefined);
});

test('PR submission surfaces structured backend errors', async () => {
  const fetchImpl = async () => jsonResponse(409, { code: 'source_changed', message: '远端基线已变化。' });
  await assert.rejects(
    () => createPullRequestFromDraft({
      files: [{ path: 'data/vocabulary.json', content: {} }],
      branch: 'maintenance/new',
      commitMessage: 'message',
      title: 'title',
      body: 'body',
      fetchImpl,
    }),
    (error) => error.code === 'source_changed' && /基线已变化/.test(error.message),
  );
});

test('session and logout use same-origin cookie endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/auth/session') {
      return jsonResponse(200, { enabled: true, authenticated: true, user: { login: 'maintainer' } });
    }
    return jsonResponse(200, { authenticated: false });
  };
  assert.equal((await getGitHubSession(fetchImpl)).user.login, 'maintainer');
  assert.deepEqual(await logoutGitHub(fetchImpl), { authenticated: false });
  assert.deepEqual(calls, [
    ['/api/auth/session', { credentials: 'same-origin' }],
    ['/api/auth/logout', { method: 'POST', credentials: 'same-origin' }],
  ]);
  assert.deepEqual(await getGitHubSession(async () => jsonResponse(404, null)), {
    enabled: false,
    authenticated: false,
    user: null,
  });
});
