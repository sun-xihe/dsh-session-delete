/**
 * dsh-session-delete — browser half.
 *
 * Contributes one session context-menu action, shown only while the Session is
 * in the Workspace registry's archive set, and a confirmation dialog that calls
 * the host endpoint. The host re-checks the archive state, so a stale menu can
 * never delete an unarchived Session.
 *
 * This file is a plain side-effect script: it must not use top-level ESM
 * import/export. React and the UI primitives are platform seed modules resolved
 * through the factory's `require`.
 *
 * @module dsh-session-delete/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const module = { exports: {} };

    const React = require('react');
    const { jsx, jsxs, Fragment } = require('react/jsx-runtime');

    // The primitives are a platform seed module; losing them degrades the
    // dialog to plain elements instead of failing the whole plugin entry
    // (a failed entry blocks the Web boot audit).
    let primitives;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-session-delete] UI primitives unavailable, using plain dialog: ' + String(error));
    }

    const NS = 'session-delete';
    const ICON_KEY = 'session.delete';
    const ROUTE_SEGMENT = '/dsh-session-delete';

    const zh = {
      'menu.deleteSession': '删除会话',
      'dialog.title': '永久删除此会话？',
      'dialog.desc': '“{title}”将从磁盘上永久删除，包括它的子智能体记录。此操作无法撤销，删除后也无法恢复。',
      'dialog.note': '只会删除已归档的会话。其他分支的会话、附件及其它文件不受影响。',
      'dialog.untitled': '未命名会话',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.confirm': '永久删除',
      'dialog.deleting': '正在删除…',
      'dialog.force.desc': '“{title}”仍被当前 dsh web 进程持有（通常是某个标签页还开着它）。强制删除会移除磁盘记录；内存里的旧会话要等 dsh web 重启才会消失，建议删除后刷新页面。',
      'dialog.force.confirm': '强制删除',
      'section.label': '归档会话',
      'section.desc': '这里列出所有已归档的会话（包括侧栏里看不到的空白会话）。删除会永久移除磁盘记录。',
      'section.empty': '没有已归档的会话。',
      'section.blank': '空白',
      'section.running': '运行中',
      'section.missing': '记录缺失',
      'section.delete': '删除',
      'toast.deleted': '会话已删除',
      'error.notArchived': '只有已归档的会话才能删除。',
      'error.busy': '会话仍在运行，请先停止它。',
      'error.liveOnly': '该会话的磁盘记录已经删除，但它仍驻留在当前 dsh web 进程内存中；重启 dsh web 后才会从会话列表消失。',
      'error.noArtifact': '会话还没有写入磁盘，暂时无法删除。',
      'error.unauthorized': '页面登录状态已失效，请刷新后重试。',
      'error.invalid': '删除请求无效。',
      'error.failed': '删除失败，请查看宿主日志后重试。',
    };

    const en = {
      'menu.deleteSession': 'Delete session',
      'dialog.title': 'Delete this session permanently?',
      'dialog.desc': '“{title}” will be removed from disk together with its subagent records. This cannot be undone and the session cannot be restored.',
      'dialog.note': 'Only archived sessions can be deleted. Forks, attachments and other files are not touched.',
      'dialog.untitled': 'Untitled session',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.confirm': 'Delete permanently',
      'dialog.deleting': 'Deleting…',
      'dialog.force.desc': '“{title}” is still held by the running dsh web process (usually a tab that still has it open). Force delete removes the on-disk record; the in-memory copy disappears only after dsh web restarts, so refresh the page afterwards.',
      'dialog.force.confirm': 'Force delete',
      'section.label': 'Archived sessions',
      'section.desc': 'Every archived session, including blank ones the sidebar never shows. Deleting removes the on-disk record permanently.',
      'section.empty': 'No archived sessions.',
      'section.blank': 'Blank',
      'section.running': 'Running',
      'section.missing': 'Missing record',
      'section.delete': 'Delete',
      'toast.deleted': 'Session deleted',
      'error.notArchived': 'Only archived sessions can be deleted.',
      'error.busy': 'The session is still running; stop it first.',
      'error.liveOnly': 'Its transcript is already gone, but the session still lives in the running dsh web process; it disappears from the list after dsh web restarts.',
      'error.noArtifact': 'The session has not been written to disk yet, so it cannot be deleted.',
      'error.unauthorized': 'Your page session expired; refresh and retry.',
      'error.invalid': 'The delete request was invalid.',
      'error.failed': 'Deletion failed. Check the host log and retry.',
    };

    // Styles are injected during factory materialization; the client module
    // system tags them with this plugin's id and removes them on unload.
    if (typeof document !== 'undefined' && document.head !== null) {
      const style = document.createElement('style');
      style.textContent = [
        '.dsh-session-delete-danger:not(:disabled){color:var(--dsw-alias-state-error-primary,#e5484d)}',
        '.dsh-session-delete-note{margin-top:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280)}',
        '.dsh-session-delete-error{margin-top:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
        '.dsh-session-delete-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(15,23,42,.45))}',
        '.dsh-session-delete-dialog{box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:20px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 12px 40px rgba(15,23,42,.28)}',
        '.dsh-session-delete-dialog-title{font-size:16px;font-weight:600;line-height:24px}',
        '.dsh-session-delete-dialog-desc{margin-top:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#4b5563)}',
        '.dsh-session-delete-dialog-footer{margin-top:20px;display:flex;justify-content:flex-end;gap:8px}',
        '.dsh-session-delete-fallback-button{padding:4px 12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:8px;background:transparent;color:inherit;font-size:13px;cursor:pointer}',
        '.dsh-session-delete-fallback-button:disabled{opacity:.5;cursor:default}',
        '.dsh-session-delete-warn{margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label,#92400e)}',
        '.dsh-session-delete-section{display:flex;flex-direction:column;gap:12px;font-size:13px}',
        '.dsh-session-delete-section-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280)}',
        '.dsh-session-delete-empty{padding:16px 0;color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:12px}',
        '.dsh-session-delete-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
        '.dsh-session-delete-row{display:flex;align-items:center;gap:12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px}',
        '.dsh-session-delete-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.dsh-session-delete-row-title{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#111827)}',
        '.dsh-session-delete-row-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#6b7280)}',
        '.dsh-session-delete-badge{padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#4b5563)}',
        '.dsh-session-delete-badge-danger{background:var(--dsw-alias-interactive-bg-hover-danger,#fee2e2);color:var(--dsw-alias-state-error-primary,#b91c1c)}',
      ].join('\n');
      document.head.append(style);
    }

    /**
     * Resolve the route base the page is served from (`<base href="./">` is
     * injected by the Web shell), so reverse-proxy mounts keep working.
     * @returns the mount prefix plus this plugin's route segment.
     */
    function routePathOf() {
      let prefix = '';
      try {
        const url = new URL(document.baseURI);
        if (url.protocol === 'http:' || url.protocol === 'https:') prefix = url.pathname.replace(/\/+$/, '');
      } catch {
        prefix = '';
      }
      return prefix + ROUTE_SEGMENT;
    }

    const ROUTE_PATH = routePathOf();

    /**
     * One pending confirmation. The menu captures a target, then the dialog
     * reads this module-level store through `useSyncExternalStore`.
     */
    let pending = null;
    const listeners = new Set();

    function publish() {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.warn('[dsh-session-delete] listener failed: ' + String(error));
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function readPending() {
      return pending;
    }

    function requestDelete(target) {
      pending = {
        sessionId: String(target.sessionId),
        title: typeof target.displayTitle === 'string' ? target.displayTitle.trim() : '',
      };
      publish();
    }

    function settleDelete() {
      if (pending === null) return;
      pending = null;
      publish();
    }

    /**
     * Ask the host to delete one archived Session.
     * @param sessionId - Captured Session id.
     * @param force - Remove a Session an idle background Agent still holds.
     * @returns the parsed success payload.
     * @throws an Error carrying a stable `code` for the dialog.
     */
    async function deleteOnHost(sessionId, force = false) {
      const response = await fetch(ROUTE_PATH + '/delete', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-dsh-session-delete': '1',
        },
        body: JSON.stringify(force === true ? { sessionId, force: true } : { sessionId }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (response.ok && payload?.ok === true) return payload;
      const failure = new Error(typeof payload?.message === 'string' ? payload.message : 'HTTP ' + String(response.status));
      failure.code = typeof payload?.code === 'string'
        ? payload.code
        : response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : 'failed';
      throw failure;
    }

    /**
     * Localize one deletion failure by its stable code.
     * @param error - Failure thrown by the host call.
     * @param t - Bound translator.
     * @returns user-facing text.
     */
    function failureText(error, t) {
      switch (error?.code) {
        case 'not-archived':
          return t('error.notArchived');
        case 'session-active':
          return t('error.busy');
        case 'live-only':
          return t('error.liveOnly');
        case 'no-artifact':
          return t('error.noArtifact');
        case 'unauthorized':
        case 'forbidden':
          return t('error.unauthorized');
        case 'invalid-request':
        case 'invalid-session-id':
          return t('error.invalid');
        default:
          return t('error.failed');
      }
    }

    /** Plain-element dialog used only when the primitives seed is unavailable. */
    function FallbackModal(props) {
      const onClickBackdrop = (event) => {
        if (event.target === event.currentTarget && typeof props.onClose === 'function') props.onClose();
      };
      return jsx('div', {
        className: 'dsh-session-delete-backdrop',
        onClick: onClickBackdrop,
        children: jsxs('div', {
          className: 'dsh-session-delete-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': typeof props.title === 'string' ? props.title : undefined,
          children: [
            jsx('div', { className: 'dsh-session-delete-dialog-title', children: props.title }),
            typeof props.description === 'string' && props.description !== ''
              ? jsx('div', { className: 'dsh-session-delete-dialog-desc', children: props.description })
              : null,
            jsx('div', { className: 'dsh-session-delete-dialog-body', children: props.children }),
            jsx('div', { className: 'dsh-session-delete-dialog-footer', children: props.footer }),
          ],
        }),
      });
    }

    /** Plain-element button used only when the primitives seed is unavailable. */
    function FallbackButton(props) {
      return jsx('button', {
        type: 'button',
        className: 'dsh-session-delete-fallback-button ' + (typeof props.className === 'string' ? props.className : ''),
        disabled: props.disabled === true,
        onClick: props.onClick,
        children: props.children,
      });
    }

    const Modal = typeof primitives?.Modal === 'function' ? primitives.Modal : FallbackModal;
    const Button = typeof primitives?.Button === 'function' ? primitives.Button : FallbackButton;
    const TrashIcon = typeof primitives?.IconTrashOutlineRegular === 'function'
      ? primitives.IconTrashOutlineRegular
      : undefined;

    /** One dialog instance; its in-flight and error state die with the request. */
    function DeleteSessionForm({ request, t, ctx }) {
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [needsForce, setNeedsForce] = React.useState(false);

      const close = () => {
        if (busy) return;
        settleDelete();
      };

      const confirm = () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        deleteOnHost(request.sessionId, needsForce).then(
          () => {
            settleDelete();
            ctx.contextMenus.notify(t('toast.deleted'), true);
            // The host already pushed the archive/workspace updates; one list
            // refresh drops the Session row itself.
            try {
              Promise.resolve(ctx.sessions.refresh()).catch((reason) => {
                console.warn('[dsh-session-delete] session list refresh failed: ' + String(reason));
              });
            } catch (reason) {
              console.warn('[dsh-session-delete] session list refresh unavailable: ' + String(reason));
            }
          },
          (reason) => {
            setBusy(false);
            if (reason?.code === 'session-live') {
              // The log is held by an idle agent that only a restart releases;
              // the second click opts into removing the on-disk record anyway.
              setNeedsForce(true);
              setError(null);
              return;
            }
            setError(failureText(reason, t));
          },
        );
      };

      const title = request.title === '' ? t('dialog.untitled') : request.title;
      return jsxs(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('dialog.close'),
        title: t('dialog.title'),
        description: t('dialog.desc', { title }),
        footer: jsxs(Fragment, {
          children: [
            jsx(Button, { variant: 'outline', disabled: busy, onClick: close, children: t('dialog.cancel') }),
            jsx(Button, {
              variant: 'outline',
              className: 'dsh-session-delete-danger',
              disabled: busy,
              onClick: confirm,
              children: busy ? t('dialog.deleting') : needsForce ? t('dialog.force.confirm') : t('dialog.confirm'),
            }),
          ],
        }),
        children: [
          jsx('div', { className: 'dsh-session-delete-note', children: t('dialog.note') }),
          needsForce
            ? jsx('div', { className: 'dsh-session-delete-warn', role: 'status', children: t('dialog.force.desc', { title }) })
            : null,
          error === null ? null : jsx('div', { className: 'dsh-session-delete-error', role: 'alert', children: error }),
        ],
      });
    }

    /**
     * Build the Settings → “Archived sessions” section. It is the only surface
     * that can reach an archived blank Session, which the sidebar never renders
     * (blank rows exist only as the selected New Session, and an archived
     * Session cannot be selected).
     * @param ctx - Client context.
     * @param t - Bound translator.
     * @returns the section component.
     */
    function makeArchivedSection(ctx, t) {
      const subscribeWorkspaces = (onChange) => ctx.workspaces.list.subscribe(onChange);
      const subscribeSessions = (onChange) => ctx.sessions.list.subscribe(onChange);
      const readWorkspaces = () => ctx.workspaces.list.getSnapshot();
      const readSessions = () => ctx.sessions.list.getSnapshot();

      const formatTime = (value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '';
        try {
          return new Date(value).toLocaleString();
        } catch {
          return '';
        }
      };

      return function ArchivedSessionsSection() {
        const workspaceState = React.useSyncExternalStore(subscribeWorkspaces, readWorkspaces, readWorkspaces);
        const sessionState = React.useSyncExternalStore(subscribeSessions, readSessions, readSessions);
        const archived = Array.isArray(workspaceState?.archivedSessionIds) ? workspaceState.archivedSessionIds : [];
        // Before the first successful catalog pull, an absent row means "not
        // loaded yet", not "the transcript is gone".
        const listReady = sessionState?.phase === 'ready';
        // The archive set is in archive order (oldest first); show the latest
        // archiving at the top, which is the row a user is usually after.
        const rows = [...archived].reverse().map((rawId) => {
          const id = String(rawId);
          const summary = sessionState?.byId?.[id];
          const display = typeof summary?.displayTitle === 'string' ? summary.displayTitle.trim() : '';
          const durable = typeof summary?.title === 'string' ? summary.title.trim() : '';
          const blank = summary?.blank === true;
          const missing = listReady && summary === undefined;
          // A blank Session's display title falls back to its directory name in
          // the catalog, which would read like a real conversation here.
          const fallback = display !== '' ? display : durable;
          return {
            id,
            title: blank ? t('dialog.untitled') : fallback === '' ? (missing ? id : '') : fallback,
            confirmTitle: blank ? `${t('dialog.untitled')} · ${id}` : fallback === '' ? id : fallback,
            blank,
            running: summary?.running === true,
            missing,
            time: formatTime(summary?.updatedAt),
          };
        });

        return jsxs('section', {
          className: 'dsh-session-delete-section',
          children: [
            jsx('div', { className: 'dsh-session-delete-section-desc', children: t('section.desc') }),
            rows.length === 0
              ? jsx('div', { className: 'dsh-session-delete-empty', children: t('section.empty') })
              : jsx('ul', {
                  className: 'dsh-session-delete-list',
                  children: rows.map((row) =>
                    jsx(
                      'li',
                      {
                        children: jsxs('div', {
                          className: 'dsh-session-delete-row',
                          children: [
                            jsxs('div', {
                              className: 'dsh-session-delete-row-main',
                              children: [
                                jsx('div', {
                                  className: 'dsh-session-delete-row-title',
                                  title: row.id,
                                  children: row.title === '' ? row.id : row.title,
                                }),
                                jsxs('div', {
                                  className: 'dsh-session-delete-row-meta',
                                  children: [
                                    jsx('span', { children: row.id }),
                                    row.blank
                                      ? jsx('span', { className: 'dsh-session-delete-badge', children: t('section.blank') })
                                      : null,
                                    row.missing
                                      ? jsx('span', { className: 'dsh-session-delete-badge', children: t('section.missing') })
                                      : null,
                                    row.running
                                      ? jsx('span', {
                                          className: 'dsh-session-delete-badge dsh-session-delete-badge-danger',
                                          children: t('section.running'),
                                        })
                                      : null,
                                    row.time === '' ? null : jsx('span', { children: row.time }),
                                  ],
                                }),
                              ],
                            }),
                            jsx(Button, {
                              variant: 'outline',
                              className: 'dsh-session-delete-danger',
                              onClick: () => {
                                requestDelete({ sessionId: row.id, displayTitle: row.confirmTitle });
                              },
                              children: t('section.delete'),
                            }),
                          ],
                        }),
                      },
                      row.id,
                    ),
                  ),
                }),
          ],
        });
      };
    }

    /**
     * Build the overlay entry: nothing while no confirmation is pending,
     * otherwise one dialog for the captured Session.
     * @param ctx - Client context.
     * @param t - Bound translator.
     * @returns the overlay component.
     */
    function makeDialog(ctx, t) {
      return function DeleteSessionDialog() {
        const request = React.useSyncExternalStore(subscribe, readPending, readPending);
        if (request === null) return null;
        return jsx(DeleteSessionForm, { request, t, ctx }, request.sessionId);
      };
    }

    const name = 'session-delete';
    const inject = ['slots', 'locale', 'contextMenus', 'workspaces', 'sessions'];

    /**
     * Register the menu action, its icon, the confirm dialog, and the strings.
     * @param ctx - Client context with the required services.
     * @returns nothing.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-delete: dictionaries');
      const t = ctx.locale.bind(NS);

      ctx.effect(
        () =>
          ctx.contextMenus.register({
            id: 'dsh-session-delete.delete',
            target: 'session',
            order: 700,
            // Re-resolve when the archive set changes, so a Session unarchived
            // in another tab loses this action on the next menu open.
            observe: () => [ctx.workspaces.list, ctx.locale],
            resolve: (target) => {
              const snapshot = ctx.workspaces.list.getSnapshot();
              const archived = Array.isArray(snapshot?.archivedSessionIds) ? snapshot.archivedSessionIds : [];
              if (!archived.includes(target.sessionId)) return [];
              return [
                {
                  id: 'delete',
                  label: t('menu.deleteSession'),
                  ...(TrashIcon === undefined ? {} : { icon: { key: ICON_KEY } }),
                  danger: true,
                  // Sit next to the built-in archive/restore action in the menu
                  // footer, after the legacy content contributions.
                  afterContent: true,
                  run: () => {
                    requestDelete(target);
                  },
                },
              ];
            },
          }),
        'dsh-session-delete: session menu action',
      );

      if (TrashIcon !== undefined) {
        ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, TrashIcon);
        });
      }

      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'session-delete-confirm', order: 1300 }, makeDialog(ctx, t));
      });

      // The sidebar never renders an archived blank Session, so archive cleanup
      // needs one management surface that lists the archive set directly.
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: 'session-delete-archived',
          order: 45,
          label: () => t('section.label'),
          inject: () => ({ t }),
        }, makeArchivedSection(ctx, t));
      });
    }

    module.exports = { name, inject, apply };
    return module.exports;
  },
});