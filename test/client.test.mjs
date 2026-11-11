/**
 * Browser-half tests for dsh-session-delete.
 *
 * The client bundle is a plain side-effect script for the Web shell's module
 * system. This test loads it twice (normal primitives and the degraded path),
 * drives the registered menu action and confirmation dialog with a minimal
 * React stand-in, and checks the request the dialog sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const registered = [];

globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registered.push(registration);
    },
  },
};

const styleTags = [];
globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/app/dsh/',
  head: { append: (element) => styleTags.push(element) },
  createElement: () => ({ textContent: '' }),
};

/** Minimal element factory with React's `jsx` call shape. */
function jsx(type, props, key) {
  return { type, props: props ?? {}, key };
}
const jsxs = jsx;
const Fragment = Symbol('Fragment');

const jsxRuntime = { jsx, jsxs, Fragment };

/** React stand-in: hooks are only invoked from component calls in this test. */
const react = {
  useState(initial) {
    return [initial, () => {}];
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot();
  },
};

const Modal = (props) => ({ type: 'Modal', props });
const Button = (props) => ({ type: 'Button', props });
const IconTrashOutlineRegular = (props) => ({ type: 'IconTrash', props });
const primitives = { Modal, Button, IconTrashOutlineRegular };

/**
 * Build a translator over the plugin's English dictionary.
 * @param dicts - Registered dictionaries.
 * @returns a `t` function with `{name}` substitution.
 */
function translator(dicts) {
  return (key, params) => {
    const value = dicts.en[key] ?? key;
    if (params === undefined) return value;
    return value.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

/**
 * Build the client context fake and its registries.
 * @param options - Archived ids and the service overrides.
 * @returns the fake context plus captured registrations.
 */
function makeClientCtx(options = {}) {
  const captured = { menus: [], slots: [], locale: undefined, notifications: [], refreshes: 0, archived: [...(options.archived ?? [])] };
  const ctx = {
    archived: captured.archived,
    effect(callback) {
      return callback();
    },
    locale: {
      register(namespace, dicts) {
        captured.locale = { namespace, dicts };
        return () => {};
      },
      bind() {
        return translator(captured.locale.dicts);
      },
    },
    contextMenus: {
      register(contribution) {
        captured.menus.push(contribution);
        return () => {};
      },
      notify(text, success) {
        captured.notifications.push({ text, success });
      },
    },
    slots: {
      inject(_name, generator) {
        generator().next();
      },
      register(entry, component) {
        captured.slots.push({ entry, component });
        return () => {};
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({ archivedSessionIds: ctx.archived }),
      },
    },
    sessions: {
      async refresh() {
        captured.refreshes += 1;
      },
    },
  };
  return { ctx, captured };
}

/**
 * Load one fresh client module instance and materialize its factory.
 * @param options - Whether the primitives seed is available.
 * @returns the plugin exports and the module registration.
 */
async function loadClient(options = {}) {
  const url = new URL('../lib/client.js', import.meta.url);
  url.searchParams.set('case', String(registered.length));
  await import(url.href);
  const registration = registered[registered.length - 1];
  const require = (specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.withPrimitives === false) throw new Error('primitives unavailable');
      return primitives;
    }
    throw new Error('unexpected require: ' + specifier);
  };
  return { exports: registration.factory(require), registration };
}

test('the client bundle registers the package id and exports a Cordis plugin', async () => {
  const { exports, registration } = await loadClient();
  assert.equal(registration.id, 'dsh-session-delete');
  assert.equal(exports.name, 'session-delete');
  assert.deepEqual(exports.inject, ['slots', 'locale', 'contextMenus', 'workspaces', 'sessions']);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(styleTags.length > 0, true);
});

test('the menu action is offered only for archived sessions', async () => {
  const { exports } = await loadClient();
  const { ctx, captured } = makeClientCtx({ archived: [] });
  exports.apply(ctx);

  const contribution = captured.menus.find((entry) => entry.id === 'dsh-session-delete.delete');
  assert.equal(contribution.target, 'session');
  assert.equal(contribution.order, 700);

  const target = { kind: 'session', value: { sessionId: 'abc', displayTitle: 'Chat' } };
  assert.deepEqual(contribution.resolve(target.value), []);

  ctx.archived.push('abc');
  const actions = contribution.resolve(target.value);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'delete');
  assert.equal(actions[0].label, 'Delete session');
  assert.equal(actions[0].danger, true);
  assert.equal(actions[0].icon.key, 'session.delete');

  // The icon provider is registered under the same key, and the overlay entry
  // exists for the confirmation dialog.
  assert.equal(captured.slots.some((slot) => slot.entry.name === 'contextMenu.icon' && slot.entry.key === 'session.delete'), true);
  assert.equal(captured.slots.some((slot) => slot.entry.name === 'shell.overlay'), true);
  assert.equal(captured.locale.namespace, 'session-delete');
});

test('confirming sends an authenticated same-origin delete request and settles', async () => {
  const { exports } = await loadClient();
  const { ctx, captured } = makeClientCtx({ archived: ['abc'] });
  exports.apply(ctx);

  const menu = captured.menus.find((entry) => entry.id === 'dsh-session-delete.delete');
  const [action] = menu.resolve({ sessionId: 'abc', displayTitle: 'Chat' });
  action.run();

  const overlay = captured.slots.find((slot) => slot.entry.name === 'shell.overlay');
  const dialogElement = overlay.component({});
  assert.equal(dialogElement.props.request.sessionId, 'abc');

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'abc', deleted: ['abc'], freedBytes: 12 }) };
  };

  const modalElement = dialogElement.type(dialogElement.props);
  const buttons = modalElement.props.footer.props.children;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[1].props.children, 'Delete permanently');
  buttons[1].props.onClick();

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/app/dsh/dsh-session-delete/delete');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['content-type'], 'application/json');
  assert.equal(requests[0].init.headers['x-dsh-session-delete'], '1');
  assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: 'abc' });
  assert.deepEqual(captured.notifications, [{ text: 'Session deleted', success: true }]);
  assert.equal(captured.refreshes, 1);
  assert.equal(overlay.component({}), null);
});

test('a host refusal stays in the dialog with a localized message', async () => {
  const { exports } = await loadClient();
  const { ctx, captured } = makeClientCtx({ archived: ['abc'] });
  exports.apply(ctx);

  const menu = captured.menus.find((entry) => entry.id === 'dsh-session-delete.delete');
  menu.resolve({ sessionId: 'abc', displayTitle: 'Chat' })[0].run();
  const overlay = captured.slots.find((slot) => slot.entry.name === 'shell.overlay');
  const dialogElement = overlay.component({});

  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, code: 'not-archived', message: 'session is not archived' }),
  });

  let errorText;
  const originalUseState = react.useState;
  react.useState = (initial) => {
    const [value, setter] = originalUseState(initial);
    if (initial === null) {
      return [value, (next) => { errorText = next; setter(next); }];
    }
    return [value, setter];
  };
  try {
    dialogElement.type(dialogElement.props).props.footer.props.children[1].props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    react.useState = originalUseState;
  }

  assert.equal(errorText, 'Only archived sessions can be deleted.');
  assert.deepEqual(captured.notifications, []);
  assert.notEqual(overlay.component({}), null);
});

test('degrades to a plain dialog when the primitives seed is missing', async () => {
  const { exports } = await loadClient({ withPrimitives: false });
  const { ctx, captured } = makeClientCtx({ archived: ['abc'] });
  exports.apply(ctx);

  const menu = captured.menus.find((entry) => entry.id === 'dsh-session-delete.delete');
  const [action] = menu.resolve({ sessionId: 'abc', displayTitle: '' });
  assert.equal(action.icon, undefined);
  action.run();

  const overlay = captured.slots.find((slot) => slot.entry.name === 'shell.overlay');
  const dialogElement = overlay.component({});
  const formElement = dialogElement.type(dialogElement.props);
  // Without the primitives the form renders the plugin's own modal stand-in.
  const fallback = formElement.type(formElement.props);
  assert.equal(fallback.props.className, 'dsh-session-delete-backdrop');
});