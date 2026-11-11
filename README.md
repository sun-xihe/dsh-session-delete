# dsh-session-delete

English | [中文](README.zh.md)

Adds one capability to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: **archived sessions can be deleted permanently**.

DSH itself only offers archive and restore — archiving hides a session from the sidebar but keeps its transcript on disk. This plugin adds a “Delete session” action to the session context menu, shown only for archived sessions, and removes the transcript for real after a confirmation.

## Features

- **Context-menu entry**: a danger-colored “Delete session” action in the session context menu. It appears only while the session is in the archive set; an unarchived session never shows it, and the host refuses such a request anyway.
- **Settings management page**: **Settings → Archived sessions** lists every id in the archive set, including **blank sessions** (a New Session that never produced an event) that the sidebar never renders, tagged “Blank / Missing record / Running”.
- **Confirmation and force**: a dialog explains that deletion cannot be undone. If the session is still held by an idle Agent inside the running dsh web process, the dialog explains why and offers one explicit **Force delete**; a session that is actually running is always refused.
- **Lineage cleanup**: deleting a session also removes the subagent transcripts it delegated to (`origin: "subagent"` descendants). Ordinary forks are independent conversations and are **not** deleted.
- **Bookkeeping cleanup**: besides the transcript directory, the operation clears:
  - the registry-global archive set (`archivedSessionIds`);
  - each workspace's session account (`sessionIds`, keeping the workspace itself);
  - the session's checkpoint in `session_projcache` (a derived cache).
- **Bilingual**: follows the DSH language setting, falling back to English.

## Install

### Install from GitHub (recommended)

```bash
dsh plugin --profile web add git+https://github.com/sun-xihe/dsh-session-delete.git
```

### Install from a local directory

```bash
git clone https://github.com/sun-xihe/dsh-session-delete.git
dsh plugin --profile web add /absolute/path/to/dsh-session-delete
# or pack first:
npm pack ./dsh-session-delete
dsh plugin --profile web add /absolute/path/to/dsh-session-delete-0.2.1.tgz
```

The package declares `dsh.bundle.patch`, so `dsh plugin` appends it to the profile's `dsh.profile.bundles` layer stack automatically.

A profile with HMR enabled reloads the configuration automatically; **refresh the browser page once** so the new browser plugin enters the `window.__DSH_BOOT__` module graph. Without HMR, restart `dsh web`.

### Uninstall

```bash
dsh plugin --profile web remove dsh-session-delete
```

The plugin only adds one route and a few browser registrations; uninstalling touches no session data.

## Usage

### Delete from the sidebar

1. **Archive** the session you want to remove (context menu → Archive session, or the row's archive button).
2. Open the sidebar view options → show archived sessions (or “archived only”) so the row is visible again.
3. Right-click the session → **Delete session** → confirm “Delete permanently”.

The row disappears after a successful deletion; in the archived-only view an empty state remains when no archived sessions are left.

### Delete from Settings (blank or otherwise invisible sessions)

Open **Settings → Archived sessions**. It lists every archived id directly:

- A **blank session** (header only, no events) never becomes a sidebar row: blank rows exist only while selected as the current New Session, and an archived session cannot be selected. The management page is the only way to reach it.
- A row tagged “Missing record” means the archive set still holds the id but its transcript is already gone; deleting it just cleans the bookkeeping.
- A row tagged “Running” cannot be deleted until that session is stopped.

### Force delete

If the dialog says the session is “still held by the running dsh web process”, the session was opened since that process started: DSH keeps the idle Agent in memory and it holds the directory's `flock` write lease. The dialog then offers **Force delete**, which removes the on-disk transcript and bookkeeping; the in-memory copy disappears only when dsh web restarts, so refresh the page afterwards.

### The transcript is gone but the row is still there

A row that survives its deleted transcript belongs to a live Session in the running dsh web process: `listSessions` lists live Sessions even when their files are gone, and no public API lets a plugin remove an entry from the SessionStore — only disposing the fiber that owns it does, which in practice means restarting dsh web.

The plugin never touches the archive bit in that state: it answers `409 live-only`, the dialog explains why, and the session stays archived (hidden), so a delete can no longer turn into an accidental unarchive that makes the row reappear. To clean up:

1. Archive those rows again so the sidebar hides them immediately;
2. restart `dsh web` — they disappear for good;
3. if the archive set still holds those ids afterwards, open **Settings → Archived sessions** and delete the rows tagged “Missing record” to drop the bookkeeping ids.

## What exactly gets deleted

| Data | Treatment |
| --- | --- |
| Session JSONL directory (`$DSH_HOME/sessions/<project>/<session id>/`) | removed recursively |
| Subagent transcripts (`origin: "subagent"` descendants) | removed as well |
| Ordinary forks (independent sessions) | **kept** |
| Workspace archive set `archivedSessionIds` | id removed |
| Workspace session account `sessionIds` | id removed (workspace kept) |
| `session_projcache` checkpoint | removed |
| Attachments (shared content-addressed objects) | kept (other sessions may reference them) |
| Other sessions' reference snapshots | kept (persisted into the citing log when created) |

## Safety design

Deletion is irreversible, so the host half enforces these rules:

- **Archived only**: the request re-reads the Workspace registry's archive set and refuses anything outside it (`409 not-archived`). Menu visibility is not the gate.
- **Running sessions are never deleted**: any target (including subagent descendants) whose Agent is running (`status === "running"`) is refused (`409 session-active`), `force` included.
- **Idle but held**: a session opened since this process started keeps an idle Agent and its write lock. The default answer is `409 session-live`; only an explicit second request with `force: true` removes the on-disk record, and the host logs a warning when it does.
- **Memory-only ghosts**: when the transcript is already gone but the Session is still live, the request answers `409 live-only` (`force` cannot help) and **leaves the archive set untouched** — otherwise a delete would silently turn into an unarchive.
- **Layout check**: the only accepted location follows the JSONL backend layout — the directory holding the artifact must be named exactly after the session id and must be a real directory (not a symlink). Anything else is refused (`500 unsafe-layout`) instead of deleting a broader path.
- **Authentication**: the route reuses DSH's `connection.requestRejection()`, i.e. the Host/Origin fence plus the signed browser-cookie check. Cross-site requests get `403`, unauthenticated requests `401`. Without a `connection` service the route **fails closed** (also 401).
- **Request shape**: `POST` + `application/json` only, an 8 KiB body cap, and non-object JSON is rejected.

## Implementation

```
dsh-session-delete/
├── cordis.patch.yml        # bundle layer: inserts the host row `dsh-session-delete`
├── lib/index.js            # host half: deletion algorithm + POST /dsh-session-delete/delete
├── lib/client.js           # browser half: context-menu action + confirmation dialog
├── locale/{zh,en}.json     # plugin-manager display text
└── test/                   # node:test suites (deletion, route, browser registrations)
```

- The host half is a plain Cordis plugin injecting `webServer`, `sessionPersistence`, `workspaceRegistry` and `connection`.
- The browser half registers through `window.__ModuleLoader__.load({ id, factory })`: a `contextMenus` contribution for `target: "session"`, a `shell.overlay` confirmation dialog, and a `contextMenu.icon` trash glyph.
- The page calls the host through same-origin `fetch`, with the path derived from `document.baseURI`, so reverse-proxied mounts work.

## Development and tests

```bash
cd dsh-session-delete
npm test        # node --test test/*.test.mjs
```

The suites cover subagent cascading and fork preservation, the archive guard, the running/idle Agent guards and forced deletion, hostile layouts, real directory removal, workspace/archive/cache bookkeeping, route authentication and error mapping, plus the settings page and dialog state machine.

> A `file:` install hard-links the package into the profile's `node_modules`, so source edits need a reinstall (`dsh plugin --profile web remove dsh-session-delete`, then `add` again, or edit the installed copy directly), plus another page refresh for the browser half.

## Known limitations

- Only the JSONL session backend (the DSH default) is supported; other backends are refused rather than guessed at.
- A session that never materialized on disk (still pending in-process) cannot be deleted and answers `no-artifact`.
- Derived data other than `session_projcache` is not swept; DSH's session query index is a reconcile-on-demand derived index and converges on the next search.
- A session opened since the current dsh web process started is held by an idle Agent and its write lease; deleting it needs Force delete (or a dsh web restart). The in-memory copy does not disappear on force, so refresh the page afterwards.
- A deleted transcript whose Session is still live keeps its list row until dsh web restarts; the plugin can only refuse and keep it archived, not remove a live SessionStore entry.
- The browser plugin needs a page refresh; the Electron desktop shell does not use the Web route, so this plugin targets the Web GUI.

## License

[MIT](LICENSE)