/**
 * Client half of the cache-queue bundle.
 *
 * Renders one dock entry in `conversation.input.dock`, directly above the
 * native queue strip: a collapsed bar carrying the entry count, which expands
 * into the cache list plus the common-phrase chips.
 *
 * The cache deliberately does NOT live in the host queue. A queued prompt in
 * DSH is always delivered when the current turn ends, so "hold this message
 * until I click send" can only be implemented by keeping the text outside the
 * session and submitting it on demand through `conversation.send(...)`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cache-queue',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace; registration passes it so the slot injects `t`. */
    const NS = 'cache-queue';

    /** Same-origin endpoint registered by the Host half. */
    const ROUTE = '/api/dsh-cache-queue';

    /** Browser copy used only when the Host half is unreachable. */
    const LOCAL_KEY = 'dsh-cache-queue/v1';

    /** Remembers whether the row was left expanded. */
    const COLLAPSED_KEY = 'dsh-cache-queue/collapsed';

    /** Longest accepted message body (mirrors the Host limit). */
    const MAX_TEXT = 100000;

    /** Longest accepted phrase label (mirrors the Host limit). */
    const MAX_LABEL = 24;

    /**
     * When the last Ctrl+Shift+S landed. Two mounted docks would otherwise both
     * park the same draft, so a 400ms window keeps one keystroke to one entry.
     */
    let lastShortcutAt = 0;

    /**
     * Call the Host half.
     * @param action - one of `list` / `replaceAll`.
     * @param payload - remaining request fields.
     * @returns the parsed JSON reply.
     */
    async function callHost(action, payload) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }

    /** @returns a fresh id for a cache entry or a phrase. */
    function newId(prefix) {
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /** Normalize one cache entry; drops records without usable text. */
    function normalizeItem(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (text.trim() === '') return null;
      return {
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('i'),
        text: text.slice(0, MAX_TEXT),
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      };
    }

    /** Normalize one common phrase; drops records without usable text. */
    function normalizePhrase(raw) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (text.trim() === '') return null;
      const label = typeof raw.label === 'string' ? raw.label.trim() : '';
      return {
        id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('p'),
        label: (label === '' ? text.trim() : label).slice(0, MAX_LABEL),
        text: text.slice(0, MAX_TEXT),
      };
    }

    /** Read the browser fallback copy. */
    function readLocal() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? 'null');
        return {
          items: Array.isArray(parsed?.items) ? parsed.items.map(normalizeItem).filter(Boolean) : [],
          phrases: Array.isArray(parsed?.phrases) ? parsed.phrases.map(normalizePhrase).filter(Boolean) : [],
        };
      } catch {
        return { items: [], phrases: [] };
      }
    }

    /** Write the browser fallback copy; storage failures are not fatal. */
    function writeLocal(document) {
      try {
        window.localStorage.setItem(LOCAL_KEY, JSON.stringify(document));
      } catch {
        // Private mode or a full quota: the Host copy is still authoritative.
      }
    }

    const CSS = `
.cq-row {
  box-sizing: border-box;
  display: flex; flex: none;
  position: relative;
  width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));
  margin: 0 auto;
  padding: 0 var(--dsh-composer-dock-inset);
}
.cq-card {
  box-sizing: border-box; width: 100%;
  position: relative;
  display: flex; flex-direction: column;
  padding: 4px 8px;
  border-radius: var(--dsw-radius-md, 14px);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-base));
  box-shadow: var(--dsw-elevation-soft, 0 0 0 .5px var(--dsw-alias-border-l1));
  font: inherit;
}
.cq-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.cq-title {
  display: inline-flex; align-items: center; gap: 6px;
  box-sizing: border-box; padding: 3px 6px;
  border: 0; border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; cursor: pointer;
  font: inherit; font-size: 13px; line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  transition: color 120ms ease, background 120ms ease;
}
.cq-title:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05)); }
.cq-title:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cq-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
  border-radius: 999px; font-size: 11px; line-height: 1;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .06));
}
.cq-badge[data-filled='true'] { color: var(--dsw-alias-brand-primary); }
.cq-spacer { flex: 1 1 auto; }
.cq-group { display: flex; align-items: center; gap: 4px; flex: none; }
.cq-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  box-sizing: border-box; padding: 3px 9px;
  border: 0; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l1);
  transition: color 120ms ease, background 120ms ease, box-shadow 120ms ease;
}
.cq-btn:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .05));
  box-shadow: var(--dsw-elevation-soft, 0 0 0 .5px var(--dsw-alias-border-l2));
}
.cq-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cq-btn:disabled { opacity: .45; cursor: default; }
.cq-btn-primary { color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 .5px var(--dsw-alias-brand-primary); }
.cq-btn-primary:hover:not(:disabled) { color: var(--dsw-alias-brand-primary); }
.cq-btn-danger { color: var(--dsw-alias-state-error-primary); box-shadow: 0 0 0 .5px var(--dsw-alias-state-error-primary); }
.cq-btn-danger:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); }
.cq-btn-icon { padding: 2px 7px; }
.cq-body {
  display: flex; flex-direction: column; gap: 8px;
  box-sizing: border-box; padding: 2px 2px 8px;
  max-height: min(46vh, 360px); overflow: auto;
}
.cq-body[data-open='false'] { display: none; }
.cq-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow: auto; }
.cq-item {
  display: flex; align-items: flex-start; gap: 8px;
  box-sizing: border-box; padding: 5px 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 10px);
}
.cq-item[data-editing='true'] { align-items: flex-start; }
.cq-index { flex: none; min-width: 15px; font-size: 11px; line-height: 20px; text-align: center; color: var(--dsw-alias-label-secondary); }
.cq-text {
  flex: 1 1 auto; min-width: 0;
  font-size: 13px; line-height: 20px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 60px; overflow: hidden;
}
.cq-item-actions { display: flex; align-items: center; gap: 2px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.cq-edit { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.cq-edit-actions { display: flex; justify-content: flex-end; gap: 6px; }
.cq-empty { padding: 2px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.cq-flash { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.cq-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 1px; }
.cq-chip {
  display: inline-flex; align-items: center; max-width: 220px;
  box-sizing: border-box; padding: 3px 10px;
  border: 0; border-radius: var(--dsw-radius-md, 12px); cursor: pointer;
  font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l1);
  transition: color 120ms ease, box-shadow 120ms ease;
}
.cq-chip:hover { color: var(--dsw-alias-label-primary); box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2), 0 4px 16px rgba(0, 0, 0, .06); }
.cq-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cq-chip-label { overflow: hidden; text-overflow: ellipsis; }
.cq-hint { padding: 1px 2px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); opacity: .85; }
.cq-kbd {
  font: inherit; font-size: 10.5px; line-height: 15px; white-space: nowrap;
  padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  color: var(--dsw-alias-label-secondary); background: transparent;
}
.cq-textarea, .cq-input {
  box-sizing: border-box; padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 18px;
  outline: none; width: 100%;
}
.cq-textarea { resize: vertical; min-height: 40px; max-height: 180px; }
.cq-textarea:focus, .cq-input:focus { border-color: var(--dsw-alias-brand-primary); }
.cq-backdrop {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .35);
}
.cq-panel {
  display: flex; flex-direction: column;
  box-sizing: border-box; width: min(600px, 92vw); max-height: 82vh; padding: 18px;
  border-radius: var(--dsw-radius-panel, 22px);
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-overlay));
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l2), 0 16px 48px rgba(0, 0, 0, .18);
}
.cq-panel-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.cq-panel-title { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; line-height: 22px; }
.cq-panel-body { display: flex; flex-direction: column; gap: 10px; overflow: auto; padding-right: 2px; }
.cq-panel-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.cq-phrase {
  display: flex; flex-direction: column; gap: 6px;
  box-sizing: border-box; padding: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md, 12px);
}
.cq-phrase-head { display: flex; align-items: center; gap: 8px; }
`;

    /** Copy shipped with the plugin, used when the locale seat is unavailable. */
    const DICT = {
      zh: {
        title: '缓存',
        empty: '缓存是空的：在下方输入框写好，点「存进缓存」。',
        loading: '正在读取缓存…',
        'btn.store': '存进缓存',
        'btn.send': '发送',
        'btn.sendAll': '全部发送',
        'btn.edit': '编辑',
        'btn.up': '上移',
        'btn.down': '下移',
        'btn.delete': '删除',
        'btn.confirmDelete': '确认删除',
        'btn.cancel': '取消',
        'btn.save': '保存',
        'btn.close': '关闭',
        'btn.pin': '固定展开缓存队列（鼠标移上去也会展开）',
        'btn.unpin': '取消固定展开',
        'btn.managePhrases': '常用语',
        'btn.savePhrase': '存为常用语',
        'hint.store': '把输入框里的内容收进缓存，不发送（快捷键 Ctrl+Shift+S）。',
        'hint.shortcut': '快捷键：Ctrl+Shift+S 存进缓存 · 编辑时 Ctrl+Enter 保存 / Esc 取消',
        'hint.draftEmpty': '输入框是空的。',
    'hint.phraseExists': '已经在常用语里了。',
        'hint.running': '发送会排进当前这一轮结束后的下一轮。',
        'msg.stored': '已存进缓存。',
        'msg.draftEmpty': '输入框是空的，没有可存的内容。',
        'msg.sendFailed': '发送失败：',
        'msg.noSession': '当前没有可发送的会话。',
        'msg.phraseSaved': '已存为常用语：',
        'msg.phraseExists': '这条已经在常用语里了。',
        'panel.title': '常用语',
        'panel.hint': `点一下常用语，它就会变成一条缓存条目。标签最多 ${MAX_LABEL} 字。`,
        'panel.empty': '还没有常用语，点下面的「新增常用语」。',
        'panel.add': '新增常用语',
        'panel.labelPlaceholder': '按钮上显示的名字，留空则取正文前几个字',
        'panel.textPlaceholder': '正文：点它会原样进入缓存队列',
      },
      en: {
        title: 'Cache',
        empty: 'The cache is empty. Write in the composer below, then click “Save to cache”.',
        loading: 'Reading the cache…',
        'btn.store': 'Save to cache',
        'btn.send': 'Send',
        'btn.sendAll': 'Send all',
        'btn.edit': 'Edit',
        'btn.up': 'Move up',
        'btn.down': 'Move down',
        'btn.delete': 'Delete',
        'btn.confirmDelete': 'Confirm',
        'btn.cancel': 'Cancel',
        'btn.save': 'Save',
        'btn.close': 'Close',
        'btn.pin': 'Keep the cache queue expanded (hovering opens it too)',
        'btn.unpin': 'Stop keeping it expanded',
        'btn.managePhrases': 'Phrases',
        'btn.savePhrase': 'Save as phrase',
        'hint.store': 'Move the composer text into the cache without sending it (Ctrl+Shift+S).',
        'hint.shortcut': 'Shortcuts: Ctrl+Shift+S saves the composer to the cache · Ctrl+Enter saves an edit / Esc cancels',
        'hint.draftEmpty': 'The composer is empty.',
    'hint.phraseExists': 'Already saved as a phrase.',
        'hint.running': 'Sending queues the text for the turn after the current one.',
        'msg.stored': 'Saved to the cache.',
        'msg.draftEmpty': 'The composer is empty; nothing to save.',
        'msg.sendFailed': 'Send failed: ',
        'msg.noSession': 'There is no session to send into.',
        'msg.phraseSaved': 'Saved as a phrase: ',
        'msg.phraseExists': 'That body is already one of the phrases.',
        'panel.title': 'Common phrases',
        'panel.hint': `Clicking a phrase adds it to the cache. Labels hold up to ${MAX_LABEL} characters.`,
        'panel.empty': 'No phrases yet. Use “Add phrase” below.',
        'panel.add': 'Add phrase',
        'panel.labelPlaceholder': 'Label on the chip; blank falls back to the first characters',
        'panel.textPlaceholder': 'Body: clicking the chip puts exactly this into the cache',
      },
    };

    /**
     * Modal editor for the common phrases.
     * @param props - phrases, save/cancel callbacks, and the translate seat.
     */
    function PhrasePanel(props) {
      const t = props.t;
      const [rows, setRows] = React.useState(() => props.phrases.map((entry) => ({ ...entry })));

      const update = (id, patch) =>
        setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
      const add = () => setRows((current) => current.concat([{ id: newId('p'), label: '', text: '' }]));
      const remove = (id) => setRows((current) => current.filter((row) => row.id !== id));

      /** Drop empty rows, default blank labels from the body, then hand them back. */
      const save = () => {
        const clean = [];
        for (const row of rows) {
          const text = String(row.text ?? '');
          if (text.trim() === '') continue;
          const label = String(row.label ?? '').trim();
          clean.push({
            id: row.id,
            label: (label === '' ? text.trim() : label).slice(0, MAX_LABEL),
            text: text.slice(0, MAX_TEXT),
          });
        }
        props.onSave(clean);
      };

      return h(
        'div',
        {
          className: 'cq-backdrop',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onClose();
          },
        },
        h(
          'div',
          { className: 'cq-panel', role: 'dialog', 'aria-modal': 'true' },
          h(
            'div',
            { className: 'cq-panel-head' },
            h('div', { className: 'cq-panel-title' }, t('panel.title'), h('div', { className: 'cq-hint' }, t('panel.hint'))),
            h('button', { type: 'button', className: 'cq-btn', onClick: () => props.onClose() }, t('btn.close')),
          ),
          h(
            'div',
            { className: 'cq-panel-body' },
            rows.length === 0 ? h('div', { className: 'cq-empty' }, t('panel.empty')) : null,
            rows.map((row) =>
              h(
                'div',
                { className: 'cq-phrase', key: row.id },
                h(
                  'div',
                  { className: 'cq-phrase-head' },
                  h('input', {
                    className: 'cq-input',
                    value: row.label,
                    maxLength: MAX_LABEL,
                    placeholder: t('panel.labelPlaceholder'),
                    onChange: (event) => update(row.id, { label: event.target.value }),
                  }),
                  h('button', { type: 'button', className: 'cq-btn cq-btn-danger', onClick: () => remove(row.id) }, t('btn.delete')),
                ),
                h('textarea', {
                  className: 'cq-textarea',
                  rows: 2,
                  value: row.text,
                  placeholder: t('panel.textPlaceholder'),
                  onChange: (event) => update(row.id, { text: event.target.value }),
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'cq-panel-foot' },
            h('button', { type: 'button', className: 'cq-btn', onClick: add }, t('panel.add')),
            h('span', { className: 'cq-spacer' }),
            h('button', { type: 'button', className: 'cq-btn', onClick: () => props.onClose() }, t('btn.cancel')),
            h('button', { type: 'button', className: 'cq-btn cq-btn-primary', onClick: save }, t('btn.save')),
          ),
        ),
      );
    }

    /**
     * The dock row: one collapsed bar, or the bar plus the cache list and the
     * phrase chips once expanded.
     * @param props - InputZone owner props, the session standard kit, the
     *   conversation face injected by the registration, and the locale seat.
     */
    function CacheDock(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => DICT.zh[key] ?? key;
      const conversation = props.conversation;
      const canWrite = Boolean(conversation && typeof conversation.send === 'function');

      const [document, setDocument] = React.useState({ items: [], phrases: [], loaded: false });
      const latest = React.useRef(document);
      const saveChain = React.useRef(Promise.resolve());

      /** Cache entries belong to one conversation; phrases are shared by all. */
      const sessionKey = props.sessionId === undefined ? '' : String(props.sessionId);

      const [hovered, setHovered] = React.useState(false);
      const [pinned, setPinned] = React.useState(() => {
        try {
          return window.localStorage.getItem(COLLAPSED_KEY) === '1';
        } catch {
          return false;
        }
      });
      const closeTimer = React.useRef(0);
      const [editingId, setEditingId] = React.useState(null);
      const [editText, setEditText] = React.useState('');
      const [confirmId, setConfirmId] = React.useState(null);
      const [panelOpen, setPanelOpen] = React.useState(false);
      const [sendingAll, setSendingAll] = React.useState(false);

      /**
       * A self-clearing inline note. The composer notice area is deliberately
       * left alone: it stays on screen until something replaces it.
       */
      const [flash, setFlash] = React.useState('');
      const flashTimer = React.useRef(0);
      const showFlash = (text) => {
        setFlash(text);
        if (flashTimer.current !== 0) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => {
          flashTimer.current = 0;
          setFlash('');
        }, 3000);
      };
      React.useEffect(
        () => () => {
          if (flashTimer.current !== 0) window.clearTimeout(flashTimer.current);
        },
        [],
      );

      React.useEffect(() => {
        let alive = true;
        (async () => {
          let next;
          try {
            const remote = await callHost('list', {});
            next = {
              items: Array.isArray(remote?.items) ? remote.items.map(normalizeItem).filter(Boolean) : [],
              phrases: Array.isArray(remote?.phrases) ? remote.phrases.map(normalizePhrase).filter(Boolean) : [],
            };
            writeLocal(next);
          } catch (error) {
            console.warn('[cache-queue] host copy unavailable, using the local copy', error);
            next = readLocal();
          }
          if (!alive) return;
          /**
           * Entries saved before caches became per-conversation have no session
           * id. Adopt them into the first conversation that opens the dock so
           * they stay visible instead of silently disappearing.
           */
          if (sessionKey !== '' && next.items.some((entry) => entry.sessionId === '')) {
            next = {
              items: next.items.map((entry) =>
                entry.sessionId === '' ? { ...entry, sessionId: sessionKey } : entry,
              ),
              phrases: next.phrases,
            };
            writeLocal(next);
            void callHost('replaceAll', { items: next.items, phrases: next.phrases }).catch(() => {});
          }
          latest.current = next;
          setDocument({ items: next.items, phrases: next.phrases, loaded: true });
        })();
        return () => {
          alive = false;
        };
      }, []);

      /** Optimistic write: browser copy first, then the serialized Host save. */
      const commit = React.useCallback((nextItems, nextPhrases) => {
        const next = { items: nextItems, phrases: nextPhrases };
        latest.current = next;
        setDocument((previous) => ({ ...previous, items: next.items, phrases: next.phrases }));
        writeLocal(next);
        saveChain.current = saveChain.current
          .then(() => callHost('replaceAll', { items: next.items, phrases: next.phrases }))
          .catch((error) => {
            console.warn('[cache-queue] save failed; the local copy still holds it', error);
          });
      }, []);

      /** Entries are per conversation; phrases are shared by every conversation. */
      const items = document.items.filter((entry) => entry.sessionId === sessionKey);
      const phrases = document.phrases;
      const draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : '';

      /**
       * A brand-new conversation stays clean until it has an entry of its own:
       * entries left in other conversations do not pop the strip, and typing
       * alone does not either. A conversation that has already started always
       * keeps it. The component stays mounted while hidden, so Ctrl+Shift+S and
       * the host load keep working.
       */
      const session = props.session;
      const freshSession =
        session === undefined || session.blank === true || session.awaitingFirstTurn === true;
      const quiet = freshSession && items.length === 0;

      /** Hover opens the panel; the grace period lets the pointer cross the gap. */
      const hoverIn = () => {
        if (closeTimer.current !== 0) {
          window.clearTimeout(closeTimer.current);
          closeTimer.current = 0;
        }
        setHovered(true);
      };
      const hoverOut = () => {
        if (closeTimer.current !== 0) window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = 0;
          setHovered(false);
        }, 140);
      };
      React.useEffect(
        () => () => {
          if (closeTimer.current !== 0) window.clearTimeout(closeTimer.current);
        },
        [],
      );

      const open = hovered || pinned;

      /** Pinning keeps the panel open without hovering; remembered across reloads. */
      const togglePinned = () => {
        setPinned((previous) => {
          const next = !previous;
          try {
            window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
          } catch {
            // Pinning is a nicety; ignore storage failures.
          }
          return next;
        });
      };

      /** Clear the composer draft after it has been parked in the cache. */
      const clearDraft = () => {
        try {
          if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
            props.inputActions.setDraft('');
            return;
          }
          if (typeof props.setDraft === 'function') props.setDraft('');
        } catch (error) {
          console.warn('[cache-queue] could not clear the composer draft', error);
        }
      };

      const storeDraft = () => {
        const text = draft.trim();
        if (text === '') return;
        commit(
          latest.current.items.concat([
            { id: newId('i'), text, createdAt: Date.now(), sessionId: sessionKey },
          ]),
          latest.current.phrases,
        );
        clearDraft();
      };

      /**
       * `storeDraft` behind a ref so the one window listener always sees the
       * current draft and phrase list instead of the first render's closure.
       */
      const storeDraftRef = React.useRef(storeDraft);
      storeDraftRef.current = storeDraft;

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
          if (String(event.key).toLowerCase() !== 's') return;
          const now = Date.now();
          if (now - lastShortcutAt < 400) return;
          lastShortcutAt = now;
          event.preventDefault();
          storeDraftRef.current();
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, []);

      /** Send one entry for real; it leaves the cache only after the send lands. */
      const sendItem = async (id) => {
        const item = latest.current.items.find((entry) => entry.id === id);
        if (item === undefined) return false;
        if (!canWrite) {
          showFlash(t('msg.noSession'));
          return false;
        }
        try {
          await conversation.send(item.text);
        } catch (error) {
          showFlash(`${t('msg.sendFailed')}${String(error?.message ?? error)}`);
          return false;
        }
        commit(
          latest.current.items.filter((entry) => entry.id !== id),
          latest.current.phrases,
        );
        return true;
      };

      /** Send in order, stopping at the first refusal so nothing is skipped silently. */
      const sendAll = async () => {
        if (sendingAll) return;
        if (!canWrite) {
          showFlash(t('msg.noSession'));
          return;
        }
        setSendingAll(true);
        try {
          for (const entry of latest.current.items.filter((item) => item.sessionId === sessionKey).slice()) {
            const ok = await sendItem(entry.id);
            if (!ok) break;
          }
        } finally {
          setSendingAll(false);
        }
      };

      /**
       * Reorder inside this conversation only; entries from other conversations
       * keep their positions in the shared document.
       */
      const move = (id, delta) => {
        const list = latest.current.items.slice();
        const mine = list.filter((entry) => entry.sessionId === sessionKey);
        const index = mine.findIndex((entry) => entry.id === id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= mine.length) return;
        const ordered = mine.map((entry) => entry.id);
        const [moved] = ordered.splice(index, 1);
        ordered.splice(target, 0, moved);
        const slots = [];
        list.forEach((entry, position) => {
          if (entry.sessionId === sessionKey) slots.push(position);
        });
        const byId = new Map(list.map((entry) => [entry.id, entry]));
        slots.forEach((position, order) => {
          list[position] = byId.get(ordered[order]);
        });
        commit(list, latest.current.phrases);
      };

      const removeItem = (id) => {
        commit(
          latest.current.items.filter((entry) => entry.id !== id),
          latest.current.phrases,
        );
      };

      const startEdit = (item) => {
        setEditingId(item.id);
        setEditText(item.text);
        setConfirmId(null);
      };

      const cancelEdit = () => {
        setEditingId(null);
        setEditText('');
      };

      const saveEdit = () => {
        const text = editText.trim();
        if (text === '') {
          cancelEdit();
          return;
        }
        commit(
          latest.current.items.map((entry) => (entry.id === editingId ? { ...entry, text: text.slice(0, MAX_TEXT) } : entry)),
          latest.current.phrases,
        );
        cancelEdit();
      };

      /** A phrase chip drops its body straight into this conversation's cache. */
      const addPhrase = (phrase) => {
        commit(
          latest.current.items.concat([
            { id: newId('i'), text: phrase.text, createdAt: Date.now(), sessionId: sessionKey },
          ]),
          latest.current.phrases,
        );
      };

      /** Keep a cached message around as a reusable phrase; duplicates are refused up front. */
      const saveAsPhrase = (item) => {
        const text = String(item.text ?? '').trim();
        if (text === '') return;
        if (latest.current.phrases.some((phrase) => String(phrase.text).trim() === text)) return;
        const firstLine = text.split('\n')[0].trim();
        const label = (firstLine !== '' ? firstLine : text).slice(0, 12);
        commit(
          latest.current.items,
          latest.current.phrases.concat([{ id: newId('p'), label, text: text.slice(0, MAX_TEXT) }]),
        );
      };

      const phraseTextSet = new Set(phrases.map((phrase) => String(phrase.text).trim()));

      const renderItem = (entry, index) =>
        editingId === entry.id
          ? h(
              'div',
              { className: 'cq-item', key: entry.id, 'data-editing': 'true' },
              h('span', { className: 'cq-index' }, String(index + 1)),
              h(
                'div',
                { className: 'cq-edit' },
                h('textarea', {
                  className: 'cq-textarea',
                  rows: 3,
                  value: editText,
                  autoFocus: true,
                  onChange: (event) => setEditText(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEdit();
                    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      saveEdit();
                    }
                  },
                }),
                h(
                  'div',
                  { className: 'cq-edit-actions' },
                  h('button', { type: 'button', className: 'cq-btn', onClick: cancelEdit }, t('btn.cancel')),
                  h('button', { type: 'button', className: 'cq-btn cq-btn-primary', onClick: saveEdit }, t('btn.save')),
                ),
              ),
            )
          : h(
              'div',
              { className: 'cq-item', key: entry.id },
              h('span', { className: 'cq-index' }, String(index + 1)),
              h('div', { className: 'cq-text', title: entry.text }, entry.text),
              h(
                'div',
                { className: 'cq-item-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cq-btn cq-btn-icon cq-btn-primary',
                    disabled: !canWrite || sendingAll,
                    title: t('btn.send'),
                    onClick: () => {
                      void sendItem(entry.id);
                    },
                  },
                  t('btn.send'),
                ),
                h('button', { type: 'button', className: 'cq-btn cq-btn-icon', onClick: () => startEdit(entry) }, t('btn.edit')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cq-btn cq-btn-icon',
                    disabled: phraseTextSet.has(String(entry.text).trim()),
                    title: phraseTextSet.has(String(entry.text).trim()) ? t('hint.phraseExists') : t('btn.savePhrase'),
                    onClick: () => saveAsPhrase(entry),
                  },
                  t('btn.savePhrase'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'cq-btn cq-btn-icon', disabled: index === 0, onClick: () => move(entry.id, -1) },
                  '↑',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cq-btn cq-btn-icon',
                    disabled: index === items.length - 1,
                    onClick: () => move(entry.id, 1),
                  },
                  '↓',
                ),
                confirmId === entry.id
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'cq-btn cq-btn-icon cq-btn-danger',
                          onClick: () => {
                            setConfirmId(null);
                            removeItem(entry.id);
                          },
                        },
                        t('btn.confirmDelete'),
                      ),
                      h('button', { type: 'button', className: 'cq-btn cq-btn-icon', onClick: () => setConfirmId(null) }, t('btn.cancel')),
                    )
                  : h(
                      'button',
                      { type: 'button', className: 'cq-btn cq-btn-icon', onClick: () => setConfirmId(entry.id) },
                      t('btn.delete'),
                    ),
              ),
            );

      const bar = h(
        'div',
        { className: 'cq-bar' },
        h(
          'button',
          {
            type: 'button',
            className: 'cq-title',
            title: pinned ? t('btn.unpin') : t('btn.pin'),
            'aria-expanded': open,
            onClick: togglePinned,
          },
          h('span', null, t('title')),
          h('span', { className: 'cq-badge', 'data-filled': items.length > 0 }, String(items.length)),
        ),
        h('span', { className: 'cq-spacer' }),
        h(
          'div',
          { className: 'cq-group' },
          h('kbd', { className: 'cq-kbd', title: t('hint.shortcut') }, 'Ctrl+Shift+S'),
          h(
            'button',
            {
              type: 'button',
              className: 'cq-btn cq-btn-primary',
              disabled: draft.trim() === '',
              title: draft.trim() === '' ? t('hint.draftEmpty') : t('hint.store'),
              onClick: storeDraft,
            },
            t('btn.store'),
          ),
          items.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'cq-btn',
                  disabled: !canWrite || sendingAll,
                  onClick: () => {
                    void sendAll();
                  },
                },
                sendingAll ? '…' : t('btn.sendAll'),
              )
            : null,
          h('button', { type: 'button', className: 'cq-btn', onClick: () => setPanelOpen(true) }, t('btn.managePhrases')),
        ),
      );

      const body = h(
        'div',
        { className: 'cq-body', 'data-open': String(open) },
            flash === '' ? null : h('div', { className: 'cq-flash' }, flash),
            items.length === 0
              ? h('div', { className: 'cq-empty' }, t('empty'))
              : h('div', { className: 'cq-list' }, items.map((entry, index) => renderItem(entry, index))),
            h(
              'div',
              { className: 'cq-chips' },
              phrases.map((phrase) =>
                h(
                  'button',
                  {
                    key: phrase.id,
                    type: 'button',
                    className: 'cq-chip',
                    title: phrase.text,
                    onClick: () => addPhrase(phrase),
                  },
                  h('span', { className: 'cq-chip-label' }, phrase.label),
                ),
              ),
            ),
            h('div', { className: 'cq-hint' }, t('hint.shortcut')),
            document.loaded === false ? h('div', { className: 'cq-hint' }, t('loading')) : null,
          );

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'cq-row', style: quiet ? { display: 'none' } : undefined },
          h(
            'div',
            {
              className: 'cq-card',
              'data-open': String(open),
              onMouseEnter: hoverIn,
              onMouseLeave: hoverOut,
            },
            body,
            bar,
          ),
        ),
        panelOpen
          ? h(PhrasePanel, {
              phrases,
              t,
              onClose: () => setPanelOpen(false),
              onSave: (clean) => {
                commit(latest.current.items, clean);
                setPanelOpen(false);
              },
            })
          : null,
      );
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT));

        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-cache-queue', '');
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        });

        /**
         * Resolve the per-session conversation face: the verbs that submit text
         * into this session and that write the composer notice/draft.
         */
        ctx.effect(() =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'cache-queue',
                order: 25,
                locale: NS,
                inject: (sessionId) => {
                  const scope = ctx.sessions.scope(sessionId);
                  const conversation = scope === undefined ? undefined : scope.get('conversation');
                  const writeDraft = (text) => {
                    if (conversation === undefined) return;
                    const row = conversation.input.for(scope);
                    if (typeof row.setDraft === 'function') row.setDraft(text);
                    else if (row.actions && typeof row.actions.setDraft === 'function') row.actions.setDraft(text);
                  };
                  return {
                    conversation,
                    sessionId: String(sessionId),
                    setDraft: writeDraft,
                  };
                },
              },
              CacheDock,
            ),
          ),
        );
      },
    };
  },
});
