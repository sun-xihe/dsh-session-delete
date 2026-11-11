/**
 * Host-half tests for dsh-session-delete: the deletion algorithm, its guards,
 * and the HTTP envelope. Everything runs against a temporary directory tree and
 * context fakes, so no DSH process or real Session store is required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  collectSubagentLineage,
  createSessionDeleteApi,
  handleRoute,
  planSessionDirectory,
  requestRejection,
  SessionDeleteFailure,
} from '../lib/index.js';

/**
 * Create one Session artifact directory and return its layout.
 * @param root - Temporary sessions root.
 * @param id - Session id, also the directory name.
 * @param options - Optional bytes written to the generation file.
 * @returns the generation path and its size.
 */
async function makeSessionDir(root, id, options = {}) {
  const dir = join(root, '--project--', id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const bytes = options.sizeBytes ?? 12;
  await writeFile(file, Buffer.alloc(bytes, 7));
  return { dir, file, sizeBytes: bytes };
}

/**
 * Build one persistence snapshot.
 * @param id - Session id.
 * @param artifact - Layout returned by {@link makeSessionDir}.
 * @param options - Header fields (origin, parentSession) and location overrides.
 * @returns a snapshot shaped like the JSONL backend's.
 */
function snapshotOf(id, artifact, options = {}) {
  return {
    header: {
      version: 4,
      id,
      createdAt: 1000,
      cwd: '/tmp/project',
      isSeeded: false,
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    },
    revision: 'revision-' + id,
    sizeBytes: artifact === undefined ? undefined : artifact.sizeBytes,
    ...(options.location === null
      ? {}
      : { location: options.location ?? { kind: 'jsonl', path: artifact.file } }),
  };
}

/**
 * Build the host context fake used by the API and route tests.
 * @param options - Snapshots, archived ids, workspace rows and live agents.
 * @returns the fake context plus recorded calls.
 */
function makeCtx(options) {
  const calls = { unarchive: [], detached: [], cache: [], workspaces: [] };
  const workspaces = (options.workspaces ?? []).map((row) => ({
    id: row.id ?? 'workspace-1',
    sessionIds: [...row.sessionIds],
    async detachSession(id) {
      calls.detached.push(id);
      this.sessionIds = this.sessionIds.filter((entry) => entry !== id);
    },
  }));
  const registry = {
    archivedSessionIds: [...(options.archived ?? [])],
    list: () => workspaces,
    async unarchiveSession(id) {
      calls.unarchive.push(id);
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    sessionPersistence: {
      async list() {
        return options.snapshots ?? [];
      },
    },
    workspaceRegistry: registry,
    get(serviceName) {
      if (serviceName === 'agents') return options.agents;
      if (serviceName === 'storageDomain') {
        return {
          get(domain) {
            if (domain !== 'session_projcache') return undefined;
            return {
              table: () => ({
                async deleteMany(ids) {
                  calls.cache.push(...ids);
                  return ids.length;
                },
              }),
            };
          },
        };
      }
      if (serviceName === 'connection') return options.connection;
      return undefined;
    },
  };
  return { ctx, calls };
}

/**
 * A response stand-in capturing the status, headers and body.
 * @returns the fake response.
 */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk);
      this.writableEnded = true;
    },
  };
}

/**
 * An incoming request stand-in over a buffer body.
 * @param options - Method, URL, headers and body.
 * @returns the readable fake request.
 */
function makeReq(options = {}) {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.method = options.method ?? 'POST';
  req.url = options.url ?? '/dsh-session-delete/delete';
  req.headers = options.headers ?? { 'content-type': 'application/json' };
  return req;
}

test('collectSubagentLineage follows subagent children only, not forks', () => {
  const root = { header: { id: 'root', isSeeded: false } };
  const child = { header: { id: 'child', isSeeded: false, origin: 'subagent', parentSession: 'root' } };
  const grandchild = { header: { id: 'grand', isSeeded: false, origin: 'subagent', parentSession: 'child' } };
  const fork = { header: { id: 'fork', isSeeded: true, parentSession: 'root' } };
  const unrelated = { header: { id: 'other', isSeeded: false } };
  const lineage = collectSubagentLineage('root', [root, child, grandchild, fork, unrelated]);
  assert.deepEqual(lineage, ['root', 'child', 'grand']);
});

test('planSessionDirectory refuses a directory not named after the session', () => {
  assert.throws(
    () => planSessionDirectory('abc', { kind: 'jsonl', path: '/root/--p--/other/session.jsonl.zstd' }),
    (error) => error instanceof SessionDeleteFailure && error.code === 'unsafe-layout',
  );
  assert.throws(
    () => planSessionDirectory('abc', { kind: 'sqlite', path: '/root/db' }),
    (error) => error instanceof SessionDeleteFailure && error.code === 'unsupported-backend',
  );
  assert.deepEqual(
    planSessionDirectory('abc', { kind: 'jsonl', path: '/root/--p--/abc/session.jsonl.zstd' }),
    { id: 'abc', dir: '/root/--p--/abc' },
  );
});

test('deletes the archived session plus its subagent lineage and cleans bookkeeping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'));
  try {
    const rootArtifact = await makeSessionDir(root, 'root');
    const childArtifact = await makeSessionDir(root, 'child');
    const grandArtifact = await makeSessionDir(root, 'grand');
    const forkArtifact = await makeSessionDir(root, 'fork');
    const snapshots = [
      snapshotOf('root', rootArtifact),
      snapshotOf('child', childArtifact, { origin: 'subagent', parentSession: 'root' }),
      snapshotOf('grand', grandArtifact, { origin: 'subagent', parentSession: 'child' }),
      snapshotOf('fork', forkArtifact, { parentSession: 'root' }),
    ];
    const { ctx, calls } = makeCtx({
      snapshots,
      archived: ['root'],
      workspaces: [{ sessionIds: ['root', 'child', 'fork'] }],
      agents: { get: () => undefined },
    });

    const result = await createSessionDeleteApi(ctx).deleteSession('root');

    assert.deepEqual(result.deleted, ['root', 'child', 'grand']);
    assert.equal(result.freedBytes, 36);
    for (const id of ['root', 'child', 'grand']) {
      await assert.rejects(readdir(join(root, '--project--', id)), { code: 'ENOENT' });
    }
    assert.deepEqual(await readdir(join(root, '--project--', 'fork')), ['session.jsonl.zstd']);

    assert.deepEqual(calls.unarchive, ['root', 'child', 'grand']);
    assert.deepEqual(calls.detached, ['root', 'child']);
    assert.deepEqual(calls.cache, ['root', 'child', 'grand']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a session that is not archived', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'));
  try {
    const artifact = await makeSessionDir(root, 'live');
    const { ctx } = makeCtx({
      snapshots: [snapshotOf('live', artifact)],
      archived: [],
      agents: { get: () => undefined },
    });
    await assert.rejects(
      createSessionDeleteApi(ctx).deleteSession('live'),
      (error) => error instanceof SessionDeleteFailure && error.code === 'not-archived',
    );
    assert.deepEqual(await readdir(artifact.dir), ['session.jsonl.zstd']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a session whose agent is still live', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'));
  try {
    const artifact = await makeSessionDir(root, 'busy');
    const childArtifact = await makeSessionDir(root, 'busy-child');
    const { ctx } = makeCtx({
      snapshots: [
        snapshotOf('busy', artifact),
        snapshotOf('busy-child', childArtifact, { origin: 'subagent', parentSession: 'busy' }),
      ],
      archived: ['busy'],
      agents: { get: (id) => (id === 'busy-child' ? { id: 'busy-child' } : undefined) },
    });
    await assert.rejects(
      createSessionDeleteApi(ctx).deleteSession('busy'),
      (error) => error instanceof SessionDeleteFailure && error.code === 'session-active',
    );
    assert.deepEqual(await readdir(artifact.dir), ['session.jsonl.zstd']);
    assert.deepEqual(await readdir(childArtifact.dir), ['session.jsonl.zstd']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a hostile artifact layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'));
  try {
    const decoy = join(root, '--project--', 'decoy');
    await mkdir(decoy, { recursive: true });
    await writeFile(join(decoy, 'session.jsonl.zstd'), 'x');
    const artifact = await makeSessionDir(root, 'target');
    const { ctx } = makeCtx({
      snapshots: [snapshotOf('target', artifact, { location: { kind: 'jsonl', path: join(decoy, 'session.jsonl.zstd') } })],
      archived: ['target'],
      agents: { get: () => undefined },
    });
    await assert.rejects(
      createSessionDeleteApi(ctx).deleteSession('target'),
      (error) => error instanceof SessionDeleteFailure && error.code === 'unsafe-layout',
    );
    assert.deepEqual(await readdir(decoy), ['session.jsonl.zstd']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses an id outside the stored-id alphabet', async () => {
  const { ctx } = makeCtx({ snapshots: [], archived: [] });
  await assert.rejects(
    createSessionDeleteApi(ctx).deleteSession('../escape'),
    (error) => error instanceof SessionDeleteFailure && error.code === 'invalid-session-id',
  );
});

test('route answers 401 when the connection fence rejects the request', async () => {
  let deleted = 0;
  const { ctx } = makeCtx({
    connection: { requestRejection: () => 401 },
  });
  const res = makeRes();
  await handleRoute(ctx, { deleteSession: async () => { deleted += 1; } }, makeReq({ body: { sessionId: 'root' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(deleted, 0);
});

test('route fails closed without a connection service', async () => {
  const { ctx } = makeCtx({});
  const res = makeRes();
  await handleRoute(ctx, { deleteSession: async () => ({}) }, makeReq({ body: { sessionId: 'root' } }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(requestRejection(ctx, makeReq({})), 401);
});

test('route deletes an admitted POST and returns the result', async () => {
  const { ctx } = makeCtx({ connection: { requestRejection: () => undefined } });
  const seen = [];
  const api = {
    async deleteSession(sessionId) {
      seen.push(sessionId);
      return { sessionId, deleted: [sessionId], freedBytes: 42 };
    },
  };
  const res = makeRes();
  await handleRoute(ctx, api, makeReq({ body: { sessionId: 'root' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ['root']);
  assert.deepEqual(JSON.parse(res.body), { ok: true, sessionId: 'root', deleted: ['root'], freedBytes: 42 });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('route maps refusals and malformed requests to their status', async () => {
  const { ctx } = makeCtx({ connection: { requestRejection: () => undefined } });
  const api = {
    async deleteSession() {
      throw new SessionDeleteFailure('not-archived', 'nope');
    },
  };

  const refused = makeRes();
  await handleRoute(ctx, api, makeReq({ body: { sessionId: 'root' } }), refused);
  assert.equal(refused.statusCode, 409);
  assert.equal(JSON.parse(refused.body).code, 'not-archived');

  const wrongMethod = makeRes();
  await handleRoute(ctx, api, makeReq({ method: 'GET', body: undefined }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');

  const wrongType = makeRes();
  await handleRoute(ctx, api, makeReq({ headers: { 'content-type': 'text/plain' }, body: { sessionId: 'root' } }), wrongType);
  assert.equal(wrongType.statusCode, 415);

  const badJson = makeRes();
  const broken = Readable.from([Buffer.from('{not json')]);
  broken.method = 'POST';
  broken.url = '/dsh-session-delete/delete';
  broken.headers = { 'content-type': 'application/json' };
  await handleRoute(ctx, api, broken, badJson);
  assert.equal(badJson.statusCode, 400);

  const unknown = makeRes();
  await handleRoute(ctx, api, makeReq({ url: '/dsh-session-delete/other', body: {} }), unknown);
  assert.equal(unknown.statusCode, 404);
});

test('route reports an unexpected failure as internal-error without leaking detail', async () => {
  const { ctx } = makeCtx({ connection: { requestRejection: () => undefined } });
  const api = {
    async deleteSession() {
      throw new Error('absolute path /home/user/secret leaked');
    },
  };
  const res = makeRes();
  await handleRoute(ctx, api, makeReq({ body: { sessionId: 'root' } }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).code, 'internal-error');
  assert.equal(res.body.includes('secret'), false);
});

test('a missing on-disk artifact for the root is a no-artifact refusal', async () => {
  const artifact = { file: '/tmp/never-created/session.jsonl.zstd', sizeBytes: 0 };
  const { ctx } = makeCtx({
    snapshots: [snapshotOf('pending', artifact, { location: null })],
    archived: ['pending'],
    agents: { get: () => undefined },
  });
  await assert.rejects(
    createSessionDeleteApi(ctx).deleteSession('pending'),
    (error) => error instanceof SessionDeleteFailure && error.code === 'no-artifact',
  );
});