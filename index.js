/**
 * Host half of the cache-queue bundle.
 *
 * Owns the durable document (cache entries + common phrases) as one JSON file
 * under `$DSH_HOME`, and serves it to the Client half over one fixed HTTP
 * route. Durable state lives here rather than in the browser so clearing site
 * data cannot silently drop the user's cache.
 *
 * Writes are atomic (temp file then rename) and serialized, so an interrupted
 * write cannot leave a truncated document behind and two concurrent saves
 * cannot lose each other's edits.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Absolute path of this plugin's browser-facing endpoint. */
const ROUTE_PATH = '/api/dsh-cache-queue';

/** Upper bound on a request body, so one call cannot exhaust memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Longest accepted message body. */
const MAX_TEXT = 100000;

/** Longest accepted phrase label. */
const MAX_LABEL = 24;

/** Seed phrases used only when the document does not exist yet. */
const SEED_PHRASES = [
  { id: 'seed-continue', label: '继续', text: '继续' },
  { id: 'seed-options', label: '给方案', text: '给我三个可选方案，并说明各自的取舍。' },
  { id: 'seed-tests', label: '跑测试', text: '运行全部测试，并修复失败的用例。' },
];

/** @returns a fresh, collision-resistant id. */
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize one cache entry.
 * `sessionId` is the conversation that owns the entry; entries saved before
 * caches became per-conversation keep an empty id and are adopted by the client.
 * @returns the clean entry, or null when it has no usable text.
 */
function normalizeItem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.trim() === '') return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : newId('i'),
    text: text.slice(0, MAX_TEXT),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
  };
}

/**
 * Normalize one common phrase.
 * @returns the clean phrase, or null when it has no usable text.
 */
function normalizePhrase(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (text.trim() === '') return null;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : newId('p'),
    label: (label === '' ? text.trim().slice(0, MAX_LABEL) : label).slice(0, MAX_LABEL),
    text: text.slice(0, MAX_TEXT),
  };
}

/**
 * Coerce a parsed document into a valid one.
 * Unusable records are dropped instead of failing the whole read, so one bad
 * hand-edit cannot take the row down.
 */
function normalizeDocument(parsed) {
  const items = Array.isArray(parsed?.items) ? parsed.items.map(normalizeItem).filter(Boolean) : [];
  const phrases = Array.isArray(parsed?.phrases) ? parsed.phrases.map(normalizePhrase).filter(Boolean) : [];
  return { items, phrases };
}

/** Serialized, atomic JSON document holding the cache and the phrase list. */
class CacheStore {
  /** @param file - absolute path of the JSON document this store owns. */
  constructor(file) {
    this.file = file;
    /** Tail of the mutation queue; always resolves so one failure cannot stall later writes. */
    this.queue = Promise.resolve();
  }

  /** Read the document, seeding it on first run. */
  async read() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const seeded = { items: [], phrases: SEED_PHRASES.map((entry) => ({ ...entry })) };
      await this.write(seeded);
      return seeded;
    }
    try {
      return normalizeDocument(JSON.parse(text));
    } catch {
      // A corrupt document must not break the row; the next write repairs it.
      return { items: [], phrases: [] };
    }
  }

  /** Replace the document atomically. */
  async write(document) {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  /** Run one read-modify-write against the document without interleaving. */
  mutate(operation) {
    const run = this.queue.then(async () => {
      const current = await this.read();
      const { next, result } = await operation(current);
      if (next) await this.write(next);
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/**
 * Build the store, register the browser-facing route, and expose the service.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin row configuration.
 */
export function apply(ctx, config = {}) {
  const home = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const file = config.file ?? join(home, 'cache-queue.json');
  const store = new CacheStore(file);

  /** The one implementation the Client half calls. */
  const service = {
    /** @returns the current document plus the backing path for display. */
    list: async () => ({ ok: true, ...(await store.read()), file }),
    /** Replace the whole document; used on every edit from the browser. */
    replaceAll: (items, phrases) =>
      store.mutate(() => {
        if (!Array.isArray(items) || !Array.isArray(phrases)) {
          return { result: { ok: false, error: 'items 与 phrases 必须是数组。' } };
        }
        const next = normalizeDocument({ items, phrases });
        return { next, result: { ok: true, ...next, file } };
      }),
  };

  ctx.effect(() => ctx.provide('cacheQueue', { ...service, file: () => file }));

  ctx.inject(['webServer'], (wsCtx) => {
    const server = wsCtx.webServer;
    if (!server || typeof server.register !== 'function') return;

    wsCtx.effect(() =>
      server.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          const reply = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(text),
              'cache-control': 'no-store',
            });
            res.end(text);
          };

          if (req.method !== 'POST') {
            res.setHeader('allow', 'POST');
            reply(405, { ok: false, error: '仅支持 POST。' });
            return;
          }

          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              reply(413, { ok: false, error: '请求体过大。' });
              return;
            }
            chunks.push(chunk);
          }

          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            reply(400, { ok: false, error: '请求体不是合法 JSON。' });
            return;
          }

          try {
            switch (body?.action) {
              case 'list':
                reply(200, await service.list());
                return;
              case 'replaceAll':
                reply(200, await service.replaceAll(body?.items, body?.phrases));
                return;
              default:
                reply(400, { ok: false, error: `未知操作：${String(body?.action)}` });
                return;
            }
          } catch (error) {
            reply(500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      }),
    );
  });
}
