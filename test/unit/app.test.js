const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../../src/backbone/app');
const { createConfigStore, BUNDLED_CONFIG_PATH } = require('../../src/lib/config');
const { absMap } = require('../helpers/abs-adapter');
const { silentLog } = require('../helpers/fixtures');

// Two fake sources: "lubimyczytac" (book + audiobook snippets, details fetched one by one) and
// "audioteka" (audiobook, details too).
function fakeProviders(overrides = {}) {
  const calls = { search: [], full: [] };
  class Lubimy {
    constructor(opts) { this.opts = opts; }
    async searchBooks(query, author, language) {
      calls.search.push({ provider: 'lubimyczytac', query, author, language });
      if (overrides.lubimyczytacSearch) return overrides.lubimyczytacSearch();
      return { matches: [
        { id: '1', title: 'Zrost', authors: ['Robert Małecki'], type: 'book', url: 'https://lubimyczytac.pl/ksiazka/1/zrost' },
        { id: '2', title: 'Zrost', authors: ['Robert Małecki'], type: 'audiobook', url: 'https://lubimyczytac.pl/audiobook/2/zrost' },
        { id: '3', title: 'Coś zupełnie innego', authors: ['Ktoś Inny'], type: 'book', url: 'https://lubimyczytac.pl/ksiazka/3/cos' },
      ] };
    }
    async getFullMetadata(m) {
      calls.full.push(m.id);
      return { ...m, description: 'Opis', series: 'Bernard Gross', seriesIndex: 3, languages: ['pol'], publishedDate: '2020-05-01',
        identifiers: { isbn: m.type === 'book' ? '9788300000001' : '', lubimyczytac: m.id } };
    }
  }
  class Audioteka {
    constructor(opts) { this.opts = opts; }
    async searchBooks(query) {
      calls.search.push({ provider: 'audioteka', query });
      if (overrides.audiotekaSearch) return overrides.audiotekaSearch();
      return { matches: [{ id: 'zrost', title: 'Zrost', authors: ['Robert Małecki'], type: 'audiobook', url: 'https://audioteka.com/pl/audiobook/zrost/' }] };
    }
    async getFullMetadata(m) {
      calls.full.push(m.id);
      return { ...m, narrator: 'Filip Kosior', duration: 600, series: ['Bernard Gross'], languages: ['polish'], identifiers: { audioteka: m.id }, _raw: { big: true } };
    }
  }
  const classes = { lubimyczytac: Lubimy, audioteka: Audioteka };
  return { calls, loadProvider: (name) => { if (!classes[name]) throw new Error(`unknown provider ${name}`); return classes[name]; } };
}

function baseConfig(change = () => {}) {
  const cfg = {
    providers: {
      lubimyczytac: { enabled: true, priority: 10, language: 'pl', concurrency: 2, maxResults: 3 },
      audioteka: { enabled: true, priority: 20, language: 'pl', concurrency: 2, maxResults: 3 },
    },
    global: { titleWeight: 60, similarityThreshold: 75, mergeBestResults: false, searchTimeoutMs: 2000 },
  };
  change(cfg);
  return cfg;
}

async function startApp(t, { config = baseConfig(), env = {}, overrides } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const store = createConfigStore({ file, checkIntervalMs: 0, log: silentLog });
  const fakes = fakeProviders(overrides);
  const { app } = createApp({ store, env, loadProvider: fakes.loadProvider, log: silentLog });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (pathAndQuery, options) => {
    const res = await fetch(base + pathAndQuery, options);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (err) { /* a page */ }
    return { status: res.status, headers: res.headers, json, body };
  };
  return { get, base, file, store, calls: fakes.calls };
}

const SEARCH = '/search?mediaType=book&query=Zrost&author=Robert%20Ma%C5%82ecki';

test('search: Audiobookshelf request, answer in its format, details only for candidates', async (t) => {
  const { get, calls } = await startApp(t);
  const { status, json } = await get(SEARCH);

  assert.equal(status, 200);
  assert.deepEqual(json.providers, [{ provider: 'lubimyczytac', count: 3 }, { provider: 'audioteka', count: 1 }]);
  assert.deepEqual(calls.search[0], { provider: 'lubimyczytac', query: 'Zrost', author: 'Robert Małecki', language: 'pl' });
  // "Coś zupełnie innego" is below the threshold: its detail page is never fetched
  assert.deepEqual(calls.full.sort(), ['1', '2', 'zrost']);
  // audiobooks first, the higher priority provider first among them
  assert.deepEqual(json.matches.map((m) => `${m._provider}:${m.type}`), ['audioteka:audiobook', 'lubimyczytac:audiobook', 'lubimyczytac:book']);
  assert.ok(json.matches.every((m) => m.similarity === 1 && !('_raw' in m)));

  const abs = absMap(json);
  assert.deepEqual(abs[0], { title: 'Zrost', author: 'Robert Małecki', narrator: 'Filip Kosior', series: [{ series: 'Bernard Gross' }], language: 'polish', duration: 600 });
  assert.deepEqual(abs[2], { title: 'Zrost', author: 'Robert Małecki', publishedYear: '2020', description: 'Opis', isbn: '9788300000001',
    series: [{ series: 'Bernard Gross', sequence: '3' }], language: 'pol' });
});

test('search: details are cached between searches', async (t) => {
  const { get, calls } = await startApp(t);
  await get(SEARCH);
  await get(SEARCH);
  assert.equal(calls.full.length, 3);
});

test('search: parameters', async (t) => {
  const { get } = await startApp(t);
  assert.equal((await get('/search')).status, 400);
  assert.deepEqual((await get('/search?mediaType=podcast&query=Zrost')).json, { providers: [], matches: [] });
  // a repeated parameter must not break the handler
  assert.equal((await get('/search?query=Zrost&query=Inne')).status, 200);

  const audio = (await get(SEARCH + '&format=audiobook')).json.matches;
  assert.deepEqual([...new Set(audio.map((m) => m.type))], ['audiobook']);
  const books = (await get(SEARCH + '&format=ebook')).json.matches;
  assert.deepEqual(books.map((m) => `${m._provider}:${m.type}`), ['lubimyczytac:book']);
});

test('search: an ISBN from the caller puts that edition first', async (t) => {
  const { get } = await startApp(t);
  const { json } = await get('/search?query=Zrost&author=Robert%20M&isbn=978-83-00000-00-1');
  assert.equal(json.matches[0].isbn, '9788300000001');
  assert.equal(json.matches[0].similarity, 1);
  assert.ok(json.matches[1].similarity < 1);
});

test('search: global allowBooks / allowAudiobooks', async (t) => {
  const { get } = await startApp(t, { config: baseConfig((c) => { c.global.allowBooks = false; }) });
  const { json } = await get(SEARCH);
  assert.ok(json.matches.length > 0 && json.matches.every((m) => m.type === 'audiobook'));
});

test('search: merging on and off', async (t) => {
  const off = await startApp(t);
  assert.ok((await off.get(SEARCH)).json.matches.every((m) => m._provider !== 'merged'));

  const on = await startApp(t, { config: baseConfig((c) => {
    c.global.mergeBestResults = true;
    c.global.mergePreferences = { series: 'lubimyczytac', narrator: 'audioteka', language: 'lubimyczytac' };
  }) });
  const { json } = await on.get(SEARCH);
  assert.equal(json.matches.length, 4);
  const [merged] = absMap(json);
  assert.equal(json.matches[0]._provider, 'merged');
  assert.deepEqual(merged, { title: 'Zrost', author: 'Robert Małecki', narrator: 'Filip Kosior', publishedYear: '2020', description: 'Opis',
    isbn: '9788300000001', series: [{ series: 'Bernard Gross', sequence: '3' }], language: 'pol', duration: 600 });
});

test('search: a failing source is reported and the others still answer', async (t) => {
  const { get } = await startApp(t, { overrides: { audiotekaSearch: async () => { throw new Error('connect ETIMEDOUT'); } } });
  const { status, json } = await get(SEARCH);
  assert.equal(status, 200);
  assert.deepEqual(json.providers[1], { provider: 'audioteka', count: 0, error: 'connect ETIMEDOUT' });
  assert.equal(json.matches.length, 2);
});

test('search: a source that refuses (429) is left alone for a while', async (t) => {
  const refused = Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } });
  const { get, calls } = await startApp(t, { overrides: { audiotekaSearch: async () => { throw refused; } } });
  assert.equal((await get(SEARCH)).json.providers[1].error, 'HTTP 429');
  const second = await get('/search?query=Inna%20ksi%C4%85%C5%BCka');
  assert.match(second.json.providers[1].error, /^skipped: source refused requests/);
  assert.equal(calls.search.filter((c) => c.provider === 'audioteka').length, 1);
});

test('search: a slow source is dropped at the deadline', async (t) => {
  const slow = () => new Promise((resolve) => { setTimeout(() => resolve({ matches: [] }), 1500).unref(); });
  const { get } = await startApp(t, { config: baseConfig((c) => { c.global.searchTimeoutMs = 1000; }), overrides: { lubimyczytacSearch: slow } });
  const started = Date.now();
  const { json } = await get(SEARCH);
  assert.ok(Date.now() - started < 1400);
  assert.deepEqual(json.providers[0], { provider: 'lubimyczytac', count: 0, error: 'timeout after 1000 ms' });
  assert.equal(json.matches.length, 1);
});

test('search: a provider that throws something odd does not take the server down', async (t) => {
  const { get } = await startApp(t, { overrides: { lubimyczytacSearch: async () => ({ matches: [null, { title: 'Zrost', authors: 'nie tablica', type: 'book' }] }) } });
  const { status, json } = await get(SEARCH);
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.matches));
});

test('API key: required everywhere except /healthz', async (t) => {
  const { get } = await startApp(t, { env: { API_KEY: 'sekret' } });
  assert.equal((await get(SEARCH)).status, 401);
  assert.equal((await get('/admin/config')).status, 401);
  assert.equal((await get(SEARCH, { headers: { Authorization: 'zly' } })).status, 401);
  assert.equal((await get(SEARCH, { headers: { Authorization: 'sekret' } })).status, 200);
  assert.equal((await get(SEARCH, { headers: { Authorization: 'Bearer sekret' } })).status, 200);
  assert.equal((await get(SEARCH + '&key=sekret')).status, 200);
  const health = await get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.deepEqual(health.json.providers, ['lubimyczytac', 'audioteka']);
});

test('admin and search pages can be switched off', async (t) => {
  const on = await startApp(t);
  assert.equal((await on.get('/admin')).status, 200);
  assert.equal((await on.get('/search-ui')).status, 200);
  assert.equal((await on.get('/admin/config')).status, 200);

  const off = await startApp(t, { env: { DISABLE_ADMIN: '1', DISABLE_SEARCH_UI: 'true' } });
  for (const p of ['/admin', '/admin/config', '/admin/providers/meta', '/search-ui']) assert.equal((await off.get(p)).status, 404, p);
  assert.equal((await off.get('/admin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await off.get(SEARCH)).status, 200);
});

test('admin: metadata lists every provider, config is validated and saved', async (t) => {
  const { get, file } = await startApp(t);
  const meta = (await get('/admin/providers/meta')).json;
  assert.deepEqual(meta.map((m) => m.name), ['lubimyczytac', 'audioteka', 'storytel', 'audible']);
  assert.deepEqual(meta[1].supportedLanguages, ['pl', 'cz']);

  const put = (body) => get('/admin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const bad = await put({ providers: { audioteka: { enabled: 'tak' } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Invalid config/);

  const good = await put(baseConfig((c) => { c.providers.lubimyczytac.enabled = false; }));
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).providers.lubimyczytac.enabled, false);
  // the running server uses it at once
  assert.deepEqual((await get(SEARCH)).json.providers.map((p) => p.provider), ['audioteka']);
});

test('admin endpoints are not open to other web origins', async (t) => {
  const { get } = await startApp(t);
  const preflight = await get('/admin/config', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  const read = await get('/admin/config', { headers: { Origin: 'https://evil.example' } });
  assert.equal(read.headers.get('access-control-allow-origin'), null);
  // the search API stays readable from pages
  assert.equal((await get(SEARCH, { headers: { Origin: 'https://app.example' } })).headers.get('access-control-allow-origin'), '*');
});

test('bound to loopback: requests for another host name are refused', async (t) => {
  const { base } = await startApp(t, { env: { HOST: '127.0.0.1' } });
  const http = require('http');
  const status = (host) => new Promise((resolve, reject) => {
    http.get(base + '/healthz', { headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await status('evil.example'), 403);
  assert.equal(await status('localhost:4000'), 200);
  assert.equal(await status(new URL(base).host), 200);
});

test('config file changed by another process is picked up; a broken one keeps the last good config', async (t) => {
  const { get, file } = await startApp(t);
  assert.equal((await get(SEARCH)).json.providers.length, 2);

  fs.writeFileSync(file, JSON.stringify(baseConfig((c) => { c.providers.audioteka.enabled = false; })));
  assert.deepEqual((await get(SEARCH)).json.providers.map((p) => p.provider), ['lubimyczytac']);
  assert.equal((await get('/healthz')).json.configError, null);

  fs.writeFileSync(file, '{ to nie jest json');
  assert.deepEqual((await get(SEARCH)).json.providers.map((p) => p.provider), ['lubimyczytac']);
  assert.match((await get('/healthz')).json.configError, /invalid config/);

  fs.writeFileSync(file, JSON.stringify(baseConfig()));
  assert.equal((await get(SEARCH)).json.providers.length, 2);
  assert.equal((await get('/healthz')).json.configError, null);
});

test('config: created from the bundled default when missing; the default is valid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-test-'));
  const file = path.join(dir, 'nested', 'dir', 'config.json');
  const store = createConfigStore({ file, log: silentLog });
  assert.ok(fs.existsSync(file));
  assert.deepEqual(Object.keys(store.get().providers), ['lubimyczytac', 'audioteka', 'storytel', 'audible']);
  assert.equal(store.get().global.searchTimeoutMs, 9000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8')));
  // nothing half-written is left behind after a save
  store.save(store.get());
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config: schema defaults and limits', () => {
  const { validateConfig } = require('../../src/lib/config');
  const cfg = validateConfig({ providers: { audible: { enabled: true } }, global: {} });
  assert.deepEqual(cfg.providers.audible, { enabled: true, priority: 0, maxResults: 0, timeoutMs: 10000 });
  assert.deepEqual(cfg.global, { maxProvidersParallel: 5, allowBooks: true, allowAudiobooks: true, titleWeight: 60, similarityThreshold: 30,
    searchTimeoutMs: 9000, mergeBestResults: false, mergeDebug: false });
  assert.throws(() => validateConfig({ providers: {}, global: { titleWeight: 101 } }), /Invalid config/);
  assert.throws(() => validateConfig({ providers: { '../zle': { enabled: true } } }), /Invalid config/);
  assert.throws(() => validateConfig({ global: {} }), /Invalid config/);
});
