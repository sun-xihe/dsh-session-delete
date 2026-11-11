# dsh-session-delete

English | [中文](README.zh.md)

Adds one capability to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI: **archived sessions can be deleted permanently**.

DSH itself only offers archive and restore — archiving hides a session from the sidebar but keeps its transcript on disk. This plugin adds a “Delete session” action to the session context menu, shown only for archived sessions, and removes the transcript for real after a confirmation.

## Features

- **Context-menu entry**: a danger-colored “Delete session” action in the session context menu. It appears only while the session is in the archive set; an unarchived session never shows it, and the host refuses such a request anyway.
- **Confirmation**: a dialog explains that deletion cannot be undone. Progress is shown while it runs, and failures appear in place.
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
dsh plugin --profile web add /absolute/path/to/dsh-session-delete-0.1.0.tgz
```

The package declares `dsh.bundle.patch`, so `dsh plugin` appends it to the profile's `dsh.profile.bundles` layer stack automatically.

A profile with HMR enabled reloads the configuration automatically; **refresh the browser page once** so the new browser plugin enters the `window.__DSH_BOOT__` module graph. Without HMR, restart `dsh web`.

### Uninstall

```bash
dsh plugin --profile web remove dsh-session-delete
```

The plugin only adds one route and a few browser registrations; uninstalling touches no session data.

## Usage

1. **Archive** the session you want to remove (context menu → Archive session, or the row's archive button).
2. Open the sidebar view options → show archived sessions (or “archived only”) so the row is visible again.
3. Right-click the session → **Delete session** → confirm “Delete permanently”.

The row disappears after a successful deletion; in the archived-only view an empty state remains when no archived sessions are left.

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
- **No live work**: any target (including subagent descendants) with a live Agent is refused (`409 session-active`).
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

The suites cover subagent cascading and fork preservation, the archive guard, the live-Agent guard, hostile layouts, real directory removal, workspace/archive/cache bookkeeping, route authentication and error mapping.

> A `file:` install hard-links the package into the profile's `node_modules`, so source edits need a reinstall (`dsh plugin --profile web remove dsh-session-delete`, then `add` again, or edit the installed copy directly), plus another page refresh for the browser half.

## Known limitations

- Only the JSONL session backend (the DSH default) is supported; other backends are refused rather than guessed at.
- A session that never materialized on disk (still pending in-process) cannot be deleted and answers `no-artifact`.
- Derived data other than `session_projcache` is not swept; DSH's session query index is a reconcile-on-demand derived index and converges on the next search.
- The browser plugin needs a page refresh; the Electron desktop shell does not use the Web route, so this plugin targets the Web GUI.

## License

[MIT](LICENSE)