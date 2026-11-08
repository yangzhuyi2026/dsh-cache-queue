/**
 * Offline check for the cache-queue Host half: mounts apply() on a fake host
 * context, exposes the registered route on a real local HTTP server, and walks
 * list -> replaceAll -> list plus the failure paths. No DSH process involved.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const dir = await mkdtemp(join(tmpdir(), 'cq-test-'));
let route;
let provided;

const ctx = {
  effect(fn) {
    return fn();
  },
  provide(key, value) {
    provided = { key, value };
  },
  inject(_names, callback) {
    callback({
      effect(fn) {
        return fn();
      },
      webServer: {
        register(descriptor) {
          route = descriptor;
          return () => {};
        },
      },
    });
  },
};

const plugin = await import(new URL('../index.js', import.meta.url).href);
plugin.apply(ctx, { dshHome: dir });

if (route === undefined) throw new Error('no route registered');
if (route.path !== '/api/dsh-cache-queue') throw new Error(`unexpected path ${route.path}`);
if (route.kind !== 'exact') throw new Error(`unexpected kind ${route.kind}`);
if (provided?.key !== 'cacheQueue') throw new Error('cacheQueue service not provided');

const server = http.createServer((req, res) => {
  void route.handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${route.path}`;

const post = async (body) => {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const checks = [];
const check = (name, condition, detail) => {
  checks.push({ name, ok: Boolean(condition), detail });
};

const first = await post({ action: 'list' });
check('first list seeds three phrases', first.body.ok === true && first.body.phrases.length === 3, first.body);
check('first list has no entries', first.body.items.length === 0);
check('list reports the file', typeof first.body.file === 'string' && first.body.file.endsWith('cache-queue.json'), first.body.file);
check('document written on first read', existsSync(join(dir, 'cache-queue.json')));

const saved = await post({
  action: 'replaceAll',
  items: [
    { text: '第一行', sessionId: 'sess-a' },
    { id: 'keep-me', text: '第二行', createdAt: 5 },
  ],
  phrases: [{ label: '', text: '正文当标签' }, { id: 'p1', label: 'L', text: 'T' }],
});
check('replaceAll accepted', saved.body.ok === true, saved.body);
check('entries normalized', saved.body.items.length === 2 && saved.body.items[0].id !== undefined, saved.body.items);
check('kept id preserved', saved.body.items[1].id === 'keep-me');
check('entry session id kept', saved.body.items[0].sessionId === 'sess-a', saved.body.items[0]);
check('missing session id becomes empty', saved.body.items[1].sessionId === '', saved.body.items[1]);
check('blank label falls back to body', saved.body.phrases[0].label === '正文当标签', saved.body.phrases);
check('stored phrases kept', saved.body.phrases[1].label === 'L');

const disk = JSON.parse(await readFile(join(dir, 'cache-queue.json'), 'utf8'));
check('disk matches reply', disk.items.length === 2 && disk.phrases.length === 2, disk);

const second = await post({ action: 'list' });
check('second list reads it back', second.body.items.length === 2 && second.body.phrases.length === 2);

const invalid = await post({ action: 'replaceAll', items: 'nope', phrases: [] });
check('invalid body rejected', invalid.body.ok === false, invalid.body);

const badAction = await post({ action: 'whatever' });
check('unknown action rejected', badAction.status === 400 && badAction.body.ok === false, badAction.body);

const get = await fetch(base);
check('GET rejected with 405', get.status === 405);

const emptyText = await post({ action: 'replaceAll', items: [{ text: '   ' }], phrases: [] });
check('blank entry dropped', emptyText.body.ok === true && emptyText.body.items.length === 0, emptyText.body);

const service = provided.value;
check('service.list works', (await service.list()).items.length === 0);
check('service.file()', service.file().endsWith('cache-queue.json'));

await new Promise((resolve) => server.close(resolve));
await rm(dir, { recursive: true, force: true });

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `  -> ${JSON.stringify(item.detail)}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
