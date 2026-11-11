/**
 * dsh-session-delete — host half.
 *
 * Serves one authenticated HTTP endpoint that permanently removes an archived
 * Session from disk. The browser half only offers the action for archived
 * Sessions, but this half enforces the same guard: a Session must be in the
 * Workspace registry's archive set before anything is deleted, and a Session
 * with a live Agent is refused.
 *
 * Deleting a transcript also removes the invisible subagent Sessions that its
 * conversation delegated to (headers with `origin: 'subagent'` whose parent
 * chain reaches the target). Ordinary forks are independent conversations and
 * are never touched.
 *
 * After the files are gone the same operation clears the Session from durable
 * bookkeeping: the registry-global archive set, every Workspace's session
 * account, and its `session_projcache` checkpoint. The projection row is a
 * derived cache, so a missing cache service only logs.
 *
 * @module dsh-session-delete
 */
import { lstat, rm } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/** Cordis plugin name. */
export const name = 'dsh-session-delete';

/**
 * Required services. `connection` applies the Host/Origin fence and the signed
 * browser-cookie check to the delete route, exactly like the first-party Web
 * routes that accept open HTTP requests.
 */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'connection'];

/** Prefix the delete route is mounted under (no trailing slash). */
export const ROUTE_SEGMENT = '/dsh-session-delete';

/** Largest accepted JSON body: the payload is one Session id. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Stored Session ids: the JSONL backend encodes any other character as
 * `~XXXX`, and the deletion path re-checks that the artifact directory is
 * named exactly after the id, so this also bounds what can ever be removed.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** A refused or failed deletion with a stable client-facing code. */
export class SessionDeleteFailure extends Error {
  /**
   * @param code - Stable machine-readable failure code.
   * @param message - Operator-facing English detail.
   * @param status - HTTP status the route answers with.
   */
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'SessionDeleteFailure';
    this.code = code;
    this.status = status;
  }
}

/**
 * Cordis plugin entrypoint: mount the delete route on the Web server and let
 * the plugin fiber own its lifetime.
 * @param ctx - Host context carrying the required services.
 * @returns nothing.
 */
export function apply(ctx) {
  const api = createSessionDeleteApi(ctx);
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_SEGMENT,
        handler: (req, res) => handleRoute(ctx, api, req, res),
      }),
    `dsh-session-delete: ${ROUTE_SEGMENT} route`,
  );
  ctx.logger?.info?.(`[dsh-session-delete] delete endpoint mounted at ${ROUTE_SEGMENT}/delete`);
}

/**
 * Build the deletion capability over a host context. Exported so the behavior
 * can be exercised without a running Web server.
 * @param ctx - Host context with Session persistence and the Workspace registry.
 * @returns the deletion operation.
 */
export function createSessionDeleteApi(ctx) {
  const log = ctx.logger ?? console;

  /**
   * Permanently delete one archived Session.
   * @param rawId - Session id from the request body.
   * @param options - `force` removes a Session that an idle background Agent
   * still holds; a running Agent is refused regardless.
   * @returns the deleted ids in cascade order and the reclaimed transcript bytes.
   * @throws {SessionDeleteFailure} for every refused or failed deletion.
   */
  async function deleteSession(rawId, options = {}) {
    const force = options?.force === true;
    const sessionId = requireSessionId(rawId);
    const registry = ctx.workspaceRegistry;
    const archived = new Set(registry.archivedSessionIds.map(String));
    if (!archived.has(sessionId)) {
      throw new SessionDeleteFailure(
        'not-archived',
        `session '${sessionId}' is not archived; archive it before deleting`,
      );
    }

    const snapshots = await ctx.sessionPersistence.list();
    const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]));

    // A transcript that is already gone but still lives in this process cannot
    // be removed from the list from here: SessionStore entries are dropped only
    // by the fiber that owns them (a dsh web restart for a resumed Agent).
    // Refusing is what keeps the archive bit intact, so the ghost stays hidden
    // instead of reappearing as an unarchived row.
    if (byId.get(sessionId) === undefined && liveSessionOf(ctx, sessionId) !== undefined) {
      throw new SessionDeleteFailure(
        'live-only',
        `session '${sessionId}' has no transcript on disk but is still live in this dsh web process; restart dsh web to drop it from the list`,
        409,
      );
    }

    const victims = collectSubagentLineage(sessionId, snapshots);

    const agents = serviceOf(ctx, 'agents');
    for (const id of victims) {
      if (agents === undefined || typeof agents.get !== 'function') continue;
      const agent = agents.get(id);
      if (agent === undefined) continue;
      if (agent.status === 'running') {
        throw new SessionDeleteFailure('session-active', `session '${id}' is still running; stop it before deleting`);
      }
      if (!force) {
        throw new SessionDeleteFailure(
          'session-live',
          `session '${id}' is still held by the running harness (opened since this process started); retry with force to remove it from disk`,
        );
      }
      log.warn?.(`[dsh-session-delete] force-deleting session '${id}' while an idle background agent still holds it`);
    }

    const plans = [];
    let freedBytes = 0;
    for (const id of victims) {
      const snapshot = byId.get(id);
      if (snapshot === undefined) continue;
      if (snapshot.location === undefined) {
        if (id === sessionId) {
          throw new SessionDeleteFailure(
            'no-artifact',
            `session '${id}' has no materialized transcript on disk yet`,
          );
        }
        continue;
      }
      plans.push(planSessionDirectory(id, snapshot.location));
      if (typeof snapshot.sizeBytes === 'number') freedBytes += snapshot.sizeBytes;
    }

    for (const plan of plans) await assertPlainDirectory(plan.dir);

    const deleted = [];
    for (const plan of plans) {
      await rm(plan.dir, { recursive: true, force: true });
      deleted.push(plan.id);
    }

    await clearProjectionCheckpoints(ctx, log, victims);
    await clearWorkspaceBookkeeping(registry, log, victims);

    log.info?.(`[dsh-session-delete] deleted session '${sessionId}' (${deleted.length} transcript(s), ${freedBytes} bytes)`);
    return { sessionId, deleted, freedBytes };
  }

  return { deleteSession };
}

/**
 * Read an optional Cordis service without turning its absence into a failure.
 * @param ctx - Host context.
 * @param serviceName - Service to look up.
 * @returns the service, or undefined when this composition omits it.
 */
function serviceOf(ctx, serviceName) {
  if (typeof ctx.get !== 'function') return undefined;
  try {
    return ctx.get(serviceName);
  } catch {
    return undefined;
  }
}

/**
 * Look up a live SessionStore entry. Unlike a persistence snapshot, this entry
 * disappears only when the fiber that owns it is disposed (a host restart for a
 * resumed Agent), so its presence is what makes a deleted transcript a ghost.
 * @param ctx - Host context.
 * @param id - Session id to look up.
 * @returns the live Session, or undefined.
 */
function liveSessionOf(ctx, id) {
  const sessions = serviceOf(ctx, 'sessions');
  if (sessions === undefined || typeof sessions.get !== 'function') return undefined;
  try {
    return sessions.get(id);
  } catch {
    return undefined;
  }
}

/**
 * Validate a request-supplied Session id.
 * @param raw - Body field.
 * @returns the id, guaranteed safe for the artifact-directory check.
 * @throws {SessionDeleteFailure} when the id is absent or outside the stored-id alphabet.
 */
function requireSessionId(raw) {
  if (typeof raw !== 'string' || !SESSION_ID_PATTERN.test(raw)) {
    throw new SessionDeleteFailure('invalid-session-id', 'sessionId must be a stored Session id', 400);
  }
  return raw;
}

/**
 * The target plus every subagent descendant in header order.
 *
 * Only `origin: 'subagent'` children are followed: a fork carries no origin and
 * is an independent conversation whose transcript must survive its source.
 * @param rootId - Validated target id.
 * @param snapshots - Complete persistence listing.
 * @returns the ids to delete, root first.
 */
export function collectSubagentLineage(rootId, snapshots) {
  const children = new Map();
  for (const snapshot of snapshots) {
    const header = snapshot.header;
    if (header.origin !== 'subagent' || header.parentSession === undefined) continue;
    const parent = String(header.parentSession);
    const child = String(header.id);
    const siblings = children.get(parent);
    if (siblings === undefined) children.set(parent, [child]);
    else siblings.push(child);
  }

  const victims = [rootId];
  const seen = new Set(victims);
  for (let index = 0; index < victims.length; index += 1) {
    for (const child of children.get(victims[index]) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      victims.push(child);
    }
  }
  return victims;
}

/**
 * Resolve the one directory a Session artifact lives in and prove it is the
 * Session's own storage directory.
 *
 * The JSONL backend materializes `<project>/<encoded session id>/<generation>`
 * with the session id as the directory name, so a basename mismatch means the
 * backend layout changed or the location is not what this plugin assumes; both
 * are reasons to refuse rather than delete a broader path.
 * @param id - Session id the artifact belongs to.
 * @param location - Backend-resolved artifact location.
 * @returns the Session directory to remove.
 * @throws {SessionDeleteFailure} for a non-JSONL backend or an unexpected layout.
 */
export function planSessionDirectory(id, location) {
  if (location.kind !== 'jsonl') {
    throw new SessionDeleteFailure(
      'unsupported-backend',
      `session '${id}' is stored by unsupported backend '${String(location.kind)}'`,
      500,
    );
  }
  if (typeof location.path !== 'string' || location.path.length === 0) {
    throw new SessionDeleteFailure('unsafe-layout', `session '${id}' reports no artifact path`, 500);
  }
  const dir = dirname(location.path);
  if (basename(dir) !== id) {
    throw new SessionDeleteFailure(
      'unsafe-layout',
      `refusing to delete '${dir}': its name does not match session '${id}'`,
      500,
    );
  }
  return { id, dir };
}

/**
 * Refuse to recurse into anything but a real directory (a symlink is removed
 * as a link by `rm`, but deleting a linked directory is never intended).
 * @param dir - Planned Session directory.
 * @returns resolution once the path is proven to be a plain directory.
 * @throws {SessionDeleteFailure} when the path is absent or not a directory.
 */
async function assertPlainDirectory(dir) {
  let stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new SessionDeleteFailure('no-artifact', `session directory '${dir}' is already gone`, 409);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new SessionDeleteFailure('unsafe-layout', `refusing to delete '${dir}': not a plain directory`, 500);
  }
}

/**
 * Drop the derived projection checkpoints of deleted Sessions. The cache is a
 * fold shortcut, never an authority, so an unavailable service is only logged.
 * @param ctx - Host context.
 * @param log - Logger used for a failed cleanup.
 * @param ids - Deleted Session ids.
 * @returns resolution after the best-effort cleanup.
 */
async function clearProjectionCheckpoints(ctx, log, ids) {
  try {
    const facility = serviceOf(ctx, 'storageDomain');
    const domain = facility?.get?.('session_projcache');
    const table = domain?.table?.('sessions');
    if (table === undefined) return;
    await table.deleteMany(ids);
  } catch (error) {
    log.warn?.(`[dsh-session-delete] projection-cache cleanup failed: ${String(error)}`);
  }
}

/**
 * Remove deleted Sessions from durable Workspace bookkeeping: the registry-wide
 * archive set and every Workspace that still accounts the id.
 *
 * Each step is independent: failing to clear one record must not resurrect a
 * transcript that is already gone, so failures are logged and the rest runs.
 * @param registry - Workspace registry.
 * @param log - Logger used for failed cleanup.
 * @param ids - Deleted Session ids.
 * @returns resolution after the best-effort cleanup.
 */
async function clearWorkspaceBookkeeping(registry, log, ids) {
  for (const id of ids) {
    try {
      await registry.unarchiveSession(id);
    } catch (error) {
      log.warn?.(`[dsh-session-delete] could not drop session '${id}' from the archive set: ${String(error)}`);
    }
  }
  for (const workspace of registry.list()) {
    const owned = ids.filter((id) => workspace.sessionIds.includes(id));
    if (owned.length === 0) continue;
    for (const id of owned) {
      try {
        await workspace.detachSession(id);
      } catch (error) {
        log.warn?.(`[dsh-session-delete] could not detach session '${id}' from workspace '${String(workspace.id)}': ${String(error)}`);
      }
    }
  }
}

/**
 * Serve the plugin's two endpoints.
 * @param ctx - Host context (connection fence + logger).
 * @param api - Deletion capability.
 * @param req - Incoming request.
 * @param res - Response owned by this handler.
 * @returns resolution after the response is written.
 */
export async function handleRoute(ctx, api, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== ROUTE_SEGMENT && !url.pathname.startsWith(`${ROUTE_SEGMENT}/`)) {
    sendJson(res, 404, { ok: false, code: 'not-found', message: 'unknown endpoint' });
    return;
  }

  const rejection = requestRejection(ctx, req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.setHeader('cache-control', 'no-store');
    res.end();
    return;
  }

  if (url.pathname !== `${ROUTE_SEGMENT}/delete`) {
    sendJson(res, 404, { ok: false, code: 'not-found', message: 'unknown endpoint' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'use POST' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof SessionDeleteFailure) {
      sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
      return;
    }
    sendJson(res, 400, { ok: false, code: 'invalid-request', message: 'unreadable request body' });
    return;
  }

  try {
    const result = await api.deleteSession(body?.sessionId, { force: body?.force === true });
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof SessionDeleteFailure) {
      sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
      return;
    }
    ctx.logger?.warn?.(`[dsh-session-delete] deletion failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    sendJson(res, 500, { ok: false, code: 'internal-error', message: 'session deletion failed' });
  }
}

/**
 * Apply the Host/Origin fence and signed browser-cookie check. Fails closed:
 * without a usable `connection` service the route answers 401 rather than
 * exposing an unauthenticated destructive endpoint.
 * @param ctx - Host context.
 * @param req - Incoming request carrying Host/Origin/Cookie headers.
 * @returns the HTTP status to refuse with, or undefined when admitted.
 */
export function requestRejection(ctx, req) {
  const connection = serviceOf(ctx, 'connection');
  if (connection === undefined || typeof connection.requestRejection !== 'function') return 401;
  try {
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return undefined;
    return typeof rejection === 'number' ? rejection : 401;
  } catch {
    return 401;
  }
}

/**
 * Read and parse the one JSON body.
 * @param req - Incoming request.
 * @returns the parsed object.
 * @throws {SessionDeleteFailure} for an unexpected media type, oversized body, or invalid JSON.
 */
async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(contentType)) {
    throw new SessionDeleteFailure('invalid-request', 'content-type must be application/json', 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new SessionDeleteFailure('invalid-request', 'request body too large', 413);
    }
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (size === 0) throw new SessionDeleteFailure('invalid-request', 'request body is empty', 400);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SessionDeleteFailure('invalid-request', 'request body is not valid JSON', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionDeleteFailure('invalid-request', 'request body must be a JSON object', 400);
  }
  return parsed;
}

/**
 * Write one JSON answer.
 * @param res - Response being owned.
 * @param status - HTTP status.
 * @param payload - JSON-serializable body.
 * @returns nothing.
 */
function sendJson(res, status, payload) {
  if (res.writableEnded === true || res.destroyed === true) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(payload));
}