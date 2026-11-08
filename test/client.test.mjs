/**
 * Offline smoke test for the client half.
 *
 * The real surface needs a restarted DSH, so this loads `client.js` in a vm
 * with a minimal module loader, a minimal React (just enough hooks to render
 * one function component), and fake DOM bits. It is not a substitute for the
 * live page; it catches registration and render-path breakage early.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log('ok   ', name);
  } catch (error) {
    fail += 1;
    console.log('FAIL ', name, '\n      ', error.message);
  }
};

const checkAsync = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log('ok   ', name);
  } catch (error) {
    fail += 1;
    console.log('FAIL ', name, '\n      ', error.message);
  }
};

const flatten = (list) => {
  const out = [];
  for (const child of list) {
    if (Array.isArray(child)) out.push(...flatten(child));
    else if (child === null || child === undefined || child === false) continue;
    else out.push(child);
  }
  return out;
};

const Fragment = Symbol('Fragment');
const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: flatten(children),
});

/** Extremely small React: useState/useRef/useEffect/useCallback for one component. */
const createMiniReact = () => {
  const react = { Fragment, createElement };
  let active = null;

  react.useState = (init) => active.useState(init);
  react.useRef = (init) => active.useRef(init);
  react.useEffect = (fn, deps) => active.useEffect(fn, deps);
  react.useCallback = (fn) => active.useCallback(fn);
  react.useMemo = (fn) => active.useMemo(fn);

  const mount = (component, props) => {
    const hooks = [];
    let cursor = 0;
    let pending = [];
    let tree = null;

    const flushEffects = () => {
      const queue = pending;
      pending = [];
      for (const call of queue) {
        const slot = hooks[call.index] ?? (hooks[call.index] = {});
        const same =
          slot.deps !== undefined &&
          call.deps !== undefined &&
          slot.deps.length === call.deps.length &&
          slot.deps.every((value, index) => value === call.deps[index]);
        if (same) continue;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        const cleanup = call.fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
        slot.deps = call.deps;
      }
    };

    const renderOnce = () => {
      cursor = 0;
      pending = [];
      tree = component(props);
      flushEffects();
    };

    const instance = {
      useState(init) {
        const index = cursor++;
        if (hooks[index] === undefined) hooks[index] = { value: typeof init === 'function' ? init() : init };
        const slot = hooks[index];
        return [
          slot.value,
          (next) => {
            slot.value = typeof next === 'function' ? next(slot.value) : next;
            renderOnce();
          },
        ];
      },
      useRef(init) {
        const index = cursor++;
        if (hooks[index] === undefined) hooks[index] = { current: init };
        return hooks[index];
      },
      useEffect(fn, deps) {
        pending.push({ index: cursor++, fn, deps });
      },
      useCallback(fn) {
        cursor += 1;
        return fn;
      },
      useMemo(fn) {
        cursor += 1;
        return fn();
      },
    };

    active = instance;
    renderOnce();
    return {
      get tree() {
        return tree;
      },
      props,
      update(patch) {
        Object.assign(props, patch);
        renderOnce();
      },
    };
  };

  return { react, mount };
};

const { react, mount } = createMiniReact();

function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
}

const findButton = (tree, label) => {
  for (const node of walk(tree)) {
    if (node.type === 'button' && node.children.includes(label)) return node;
  }
  return null;
};

const findBadge = (tree) => {
  for (const node of walk(tree)) {
    if (node.props?.className === 'cq-badge') return node.children.join('');
  }
  return null;
};

const textOf = (node) => {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join(' ');
};

// ---------------------------------------------------------------- sandbox ----
let definition = null;
const listeners = [];
const draftWrites = [];
const notices = [];
const styles = [];
const localStore = new Map();

const window = {
  __ModuleLoader__: {
    load(value) {
      definition = value;
    },
  },
  localStorage: {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
  },
  addEventListener: (type, fn) => {
    if (type === 'keydown') listeners.push(fn);
  },
  removeEventListener: () => {},
  setTimeout,
  clearTimeout,
};

const sandbox = {
  window,
  document: {
    createElement: () => {
      const element = { textContent: '', setAttribute: () => {}, remove: () => {} };
      styles.push(element);
      return element;
    },
    head: { appendChild: () => {} },
  },
  console,
  fetch: async () => {
    throw new Error('offline');
  },
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  Math,
  JSON,
  String,
  Number,
  Object,
  Array,
  Boolean,
  Error,
  Symbol,
  RegExp,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

check('module loader registers the bundle id', () => {
  assert.equal(definition?.id, 'dsh-cache-queue');
  assert.equal(typeof definition.factory, 'function');
});

const module = definition.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require: ${name}`);
});

check('module injects slots, locale and sessions', () => {
  assert.deepEqual([...module.inject].sort(), ['locale', 'sessions', 'slots']);
});

// ------------------------------------------------------------------- apply ---
let slotOptions = null;
let registeredComponent = null;
let dictionaries = null;
const conversation = {
  send: async () => {},
  input: {
    for: () => ({
      setDraft: (text) => draftWrites.push(text),
      notify: (level, text) => notices.push([level, text]),
    }),
  },
};

const ctx = {
  effect: (fn) => {
    const cleanup = fn();
    return typeof cleanup === 'function' ? cleanup : () => {};
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => {
      slotOptions = options;
      registeredComponent = component;
      return () => {};
    },
  },
  locale: {
    register: (namespace, dict) => {
      dictionaries = { namespace, dict };
      return () => {};
    },
  },
  sessions: {
    scope: () => ({ get: (name) => (name === 'conversation' ? conversation : undefined) }),
  },
};

check('apply registers the dock row and both dictionaries', () => {
  module.apply(ctx);
  assert.ok(dictionaries, 'locale dictionaries registered');
  assert.equal(dictionaries.namespace, 'cache-queue');
  assert.ok(slotOptions, 'slot registration happened');
  assert.equal(slotOptions.name, 'conversation.input.dock');
  assert.equal(slotOptions.id, 'cache-queue');
  assert.equal(slotOptions.order, 25);
});

check('injected props expose the conversation face', () => {
  const props = slotOptions.inject('session-1');
  assert.equal(props.conversation, conversation);
  assert.equal(props.sessionId, 'session-1');
  props.setDraft('kept');
  assert.deepEqual(draftWrites, ['kept']);
  assert.equal('notify' in props, false, 'the composer notice area is left alone');
});

// ------------------------------------------------------------------ render ---
const t = (key) => key;
const props = {
  t,
  conversation,
  session: { blank: false, awaitingFirstTurn: false },
  input: { draft: '第一条缓存内容' },
  inputActions: { setDraft: (text) => draftWrites.push(`composer:${text}`) },
  notify: (level, text) => notices.push([level, text]),
};

const view = mount(registeredComponent, props);

const findCard = (tree) => {
  for (const node of walk(tree)) if (node.props?.className === 'cq-card') return node;
  return null;
};

const bodyOpen = () => {
  for (const node of walk(view.tree)) if (node.props?.className === 'cq-body') return node.props['data-open'];
  return null;
};

check('the row starts collapsed and opens on hover', () => {
  assert.equal(bodyOpen(), 'false', 'body hidden before hovering');
  findCard(view.tree).props.onMouseEnter();
  assert.equal(bodyOpen(), 'true', 'body shown after hovering');
});

check('the panel grows above the bar in normal flow', () => {
  const card = findCard(view.tree);
  const classes = card.children.map((child) => child.props?.className);
  const bodyAt = classes.indexOf('cq-body');
  const barAt = classes.indexOf('cq-bar');
  assert.ok(bodyAt >= 0 && barAt >= 0, 'both halves rendered');
  assert.ok(bodyAt < barAt, 'the body renders before the bar, so opening pushes the dock up');
});

check('the stylesheet keeps the panel in flow instead of overlaying', () => {
  const css = styles.map((style) => style.textContent).join('\n');
  assert.ok(css.includes('.cq-flash'), 'inline note style present');
  assert.ok(!/\.cq-body\s*\{[^}]*position:\s*absolute/.test(css), 'body is not absolutely positioned');
  assert.ok(!/z-index:\s*30/.test(css), 'no stacking hack left over');
});

check('render shows the shortcut hint and the store button', () => {
  const tree = view.tree;
  const all = textOf(tree);
  assert.ok(all.includes('Ctrl+Shift+S'), 'kbd hint rendered');
  assert.ok(all.includes('hint.shortcut'), 'shortcut legend rendered');
  assert.ok(findButton(tree, 'btn.store'), 'store button rendered');
  assert.equal(findCard(tree).props['data-open'], 'true', 'card marked open');
});

await checkAsync('hovering out keeps the panel up for a moment before hiding it', async () => {
  findCard(view.tree).props.onMouseLeave();
  assert.equal(bodyOpen(), 'true', 'still open during the grace period');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(bodyOpen(), 'false', 'hidden after the grace period');
});

await checkAsync('pinning keeps the panel open without hovering', async () => {
  const titleButton = () => {
    for (const node of walk(view.tree)) {
      if (node.type === 'button' && node.props?.className === 'cq-title') return node;
    }
    return null;
  };
  titleButton().props.onClick();
  assert.equal(bodyOpen(), 'true', 'pinned open');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(bodyOpen(), 'true', 'stays open after the grace period');
  titleButton().props.onClick();
  assert.equal(bodyOpen(), 'false', 'unpinned and closed');
});

check('storing the draft moves it into the cache and clears the composer', () => {
  const before = notices.length;
  findButton(view.tree, 'btn.store').props.onClick();
  const all = textOf(view.tree);
  assert.ok(all.includes('第一条缓存内容'), 'entry visible in the list');
  assert.equal(notices.length, before, 'storing raises no composer notice');
  assert.ok(draftWrites.includes('composer:'), 'composer cleared');
});

check('Ctrl+Shift+S stores the composer text without sending', () => {
  view.update({ input: { draft: '快捷键存进来的' } });
  const handler = listeners.at(-1);
  assert.equal(typeof handler, 'function');
  let prevented = false;
  handler({ ctrlKey: true, shiftKey: true, altKey: false, key: 's', preventDefault: () => (prevented = true) });
  assert.ok(prevented, 'default prevented');
  assert.ok(textOf(view.tree).includes('快捷键存进来的'), 'shortcut entry visible');
});

check('a cached entry can be saved as a phrase, once', () => {
  const first = findButton(view.tree, 'btn.savePhrase');
  assert.ok(first, 'save-as-phrase button rendered');
  assert.notEqual(first.props.disabled, true, 'offered before the phrase exists');
  const before = notices.length;
  first.props.onClick();
  assert.ok(textOf(view.tree).includes('第一条缓存内容'), 'chip labelled from the body');
  assert.equal(notices.length, before, 'saving a phrase is silent');

  const countChips = () => {
    let count = 0;
    for (const node of walk(view.tree)) if (node.props?.className === 'cq-chip') count += 1;
    return count;
  };
  const chips = countChips();
  const again = findButton(view.tree, 'btn.savePhrase');
  assert.equal(again.props.disabled, true, 'the duplicate is disabled instead of nagging');
  again.props.onClick();
  assert.equal(countChips(), chips, 'duplicate phrase not added');
});

const rowOf = (tree) => {
  for (const node of walk(tree)) if (node.props?.className === 'cq-row') return node;
  return null;
};

check('a brand-new conversation leaves the strip out of the way', () => {
  const freshProps = {
    t,
    conversation,
    sessionId: 'session-fresh',
    input: { draft: '' },
    inputActions: { setDraft: (text) => draftWrites.push(`fresh:${text}`) },
    session: { blank: true, awaitingFirstTurn: true },
  };
  const before = listeners.length;
  const fresh = mount(registeredComponent, freshProps);
  assert.equal(rowOf(fresh.tree)?.props.style?.display, 'none', 'hidden while empty');
  assert.ok(listeners.length > before, 'the shortcut listener is still live while hidden');

  fresh.update({ input: { draft: '先写一半' } });
  assert.equal(rowOf(fresh.tree)?.props.style?.display, 'none', 'typing alone does not reveal it');

  fresh.update({ input: { draft: '' } });
  assert.equal(rowOf(fresh.tree)?.props.style?.display, 'none', 'still hidden when emptied');

  fresh.update({ input: { draft: '要存起来的' } });
  findButton(fresh.tree, 'btn.store').props.onClick();
  fresh.update({ input: { draft: '' } });
  assert.notEqual(
    rowOf(fresh.tree)?.props.style?.display,
    'none',
    'appears once this conversation stored an entry',
  );
});

await checkAsync('entries cached in other conversations do not reveal a new chat', async () => {
  localStore.set(
    'dsh-cache-queue/v1',
    JSON.stringify({
      items: [{ id: 'i-other', text: '别处存的', createdAt: 1, sessionId: 'session-elsewhere' }],
      phrases: [],
    }),
  );
  const fresh = mount(registeredComponent, {
    t,
    conversation,
    sessionId: 'session-foreign',
    input: { draft: '' },
    inputActions: {},
    session: { blank: true, awaitingFirstTurn: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    rowOf(fresh.tree)?.props.style?.display,
    'none',
    'foreign entries stay hidden in an untouched new chat',
  );
  localStore.delete('dsh-cache-queue/v1');
});

await checkAsync('entries stay with the conversation that stored them', async () => {
  localStore.delete('dsh-cache-queue/v1');
  const alpha = mount(registeredComponent, {
    t,
    conversation,
    sessionId: 's-alpha',
    input: { draft: '只属于 A' },
    inputActions: {},
    session: { blank: true, awaitingFirstTurn: true },
  });
  findButton(alpha.tree, 'btn.store').props.onClick();
  alpha.update({ input: { draft: '' } });
  assert.notEqual(rowOf(alpha.tree)?.props.style?.display, 'none', 'A sees its own entry');
  const saved = JSON.parse(localStore.get('dsh-cache-queue/v1'));
  assert.equal(saved.items[0].sessionId, 's-alpha', 'the entry remembers its conversation');

  const beta = mount(registeredComponent, {
    t,
    conversation,
    sessionId: 's-beta',
    input: { draft: '' },
    inputActions: {},
    session: { blank: true, awaitingFirstTurn: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rowOf(beta.tree)?.props.style?.display, 'none', 'B stays hidden with A entries around');
  assert.equal(findBadge(beta.tree), '0', 'B counts only its own entries');
  localStore.delete('dsh-cache-queue/v1');
});

check('a conversation that already has content always shows the strip', () => {
  const opened = mount(registeredComponent, {
    t,
    conversation,
    input: { draft: '' },
    inputActions: { setDraft: () => {} },
    session: { blank: false, awaitingFirstTurn: false },
  });
  assert.notEqual(rowOf(opened.tree)?.props.style?.display, 'none', 'visible on an existing session');
});

check('the unbound new-chat screen hides the strip too', () => {
  const hero = mount(registeredComponent, {
    t,
    conversation: undefined,
    input: { draft: '' },
    inputActions: {},
  });
  assert.equal(rowOf(hero.tree)?.props.style?.display, 'none', 'hidden while the new chat is empty');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
