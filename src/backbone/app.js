const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');

const { mapWithConcurrency, statusOf } = require('../lib/http');
const { norm, isAudio, scoreMatch, toAbsMatch, sortResults, mergeBestResults, ISBN_DIGITS } = require('./pipeline');
const providersMeta = require('../config/providers.meta.json');

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const BLOCK_STATUSES = new Set([403, 429]);
const BLOCK_COOLDOWN_MS = 60 * 1000;

function loadProviderClass(name) {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(path.resolve(__dirname, '..', name, 'provider.js'));
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * The backbone as an Express app, without listening.
 *
 * @param {object} options
 * @param {{get: Function, save: Function, status: Function}} options.store  config store (src/lib/config.js)
 * @param {object} [options.env]            environment (API_KEY, DISABLE_ADMIN, DISABLE_SEARCH_UI, HOST)
 * @param {Function} [options.loadProvider] name -> provider class; the tests pass fakes
 * @param {object} [options.log]            console-like logger
 */
function createApp({ store, env = process.env, loadProvider = loadProviderClass, log = console } = {}) {
  const API_KEY = (env.API_KEY || '').trim();
  const adminEnabled = !truthy(env.DISABLE_ADMIN);
  const searchUiEnabled = !truthy(env.DISABLE_SEARCH_UI);
  const loopbackOnly = LOOPBACK_HOSTS.has((env.HOST || '').trim().toLowerCase());
  const startedAt = Date.now();

  // Config and provider instances are read once per request (`getRuntime()`), so a config change in the
  // middle of a search cannot mix old and new settings.
  let runtime = null;
  function getRuntime() {
    const config = store.get();
    if (runtime && runtime.config === config) return runtime;
    const providers = [];
    for (const [name, opts] of Object.entries(config.providers || {})) {
      if (!opts.enabled) continue;
      try {
        const ProviderClass = loadProvider(name);
        providers.push({ name, opts, instance: new ProviderClass(opts) });
      } catch (err) {
        log.error(`Could not load provider ${name}: ${err.message}`);
      }
    }
    log.log(`Providers: ${providers.map((p) => p.name).join(', ') || '(none)'}`);
    runtime = { config, providers, fullCache: new NodeCache({ stdTTL: 600, useClones: false }) };
    return runtime;
  }

  // A source that answered 403/429 is left alone for a while instead of being asked again on every search.
  const blockedUntil = new Map();

  const app = express();
  app.disable('x-powered-by');

  // Bound to the loopback interface: refuse requests addressed to any other host name, so a web page cannot
  // reach the server through a DNS name it controls.
  if (loopbackOnly) {
    app.use((req, res, next) => {
      const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
      if (LOOPBACK_HOSTS.has(host)) return next();
      res.status(403).json({ error: 'Forbidden host' });
    });
  }

  // Liveness, without the key: says nothing about the config beyond which providers run.
  app.get('/healthz', (req, res) => {
    const status = store.status();
    // From the config, without loading the provider modules: this must answer at once after start.
    const providers = Object.entries(store.get().providers || {}).filter(([, opts]) => opts.enabled).map(([name]) => name);
    res.json({
      status: 'ok',
      uptimeMs: Date.now() - startedAt,
      providers,
      configLoadedAt: status.loadedAt,
      configError: status.error ? 'invalid config on disk, previous one in use' : null,
    });
  });

  // Optional shared key (API_KEY env). When set, every other endpoint asks for it: `Authorization: <key>` (what
  // Audiobookshelf and Dove send), `Authorization: Bearer <key>`, or `?key=<key>` (the admin and search pages).
  app.use((req, res, next) => {
    if (!API_KEY) return next();
    const header = (req.get('authorization') || '').trim();
    const given = header.replace(/^Bearer\s+/i, '') || (req.query.key || '').toString();
    if (given && safeEqual(given, API_KEY)) return next();
    res.status(401).json({ error: 'API key required' });
  });

  async function runProvider(p, ctx) {
    const until = blockedUntil.get(p.name) || 0;
    if (until > Date.now()) {
      return { provider: p.name, count: 0, results: [], error: `skipped: source refused requests, retry in ${Math.ceil((until - Date.now()) / 1000)} s` };
    }
    let snippets;
    try {
      const found = await p.instance.searchBooks(ctx.query, ctx.author, p.opts.language);
      snippets = (found && found.matches) || [];
    } catch (err) {
      const status = statusOf(err);
      if (BLOCK_STATUSES.has(status)) blockedUntil.set(p.name, Date.now() + BLOCK_COOLDOWN_MS);
      return { provider: p.name, count: 0, results: [], error: status ? `HTTP ${status}` : String(err.message || err) };
    }

    const priority = typeof p.opts.priority === 'number' ? p.opts.priority : 0;
    let scored = snippets
      .filter((m) => m && m.title)
      .map((m) => ({ ...m, similarity: scoreMatch(m, ctx.query, ctx.author, ctx.titleWeight) }))
      .filter((m) => (isAudio(m) ? ctx.wantAudio : ctx.wantBooks))
      .sort((a, b) => b.similarity - a.similarity);
    // Per-provider cap before the threshold, to limit noisy providers.
    if (p.opts.maxResults > 0) scored = scored.slice(0, p.opts.maxResults);
    const candidates = scored.filter((m) => m.similarity >= ctx.threshold);

    const full = await mapWithConcurrency(candidates, async (m) => {
      let item = m;
      if (!m._fullFetched && typeof p.instance.getFullMetadata === 'function') {
        const key = `${p.name}|${m.type}|${m.id || m.url}`;
        item = ctx.fullCache.get(key);
        if (!item) {
          item = await p.instance.getFullMetadata(m);
          // A provider hands the snippet back when the detail page failed: do not remember that.
          if (item && item !== m) ctx.fullCache.set(key, item);
        }
      }
      if (!item) return null;
      const { _raw, _fullFetched, ...rest } = item;
      return { ...rest, similarity: m.similarity, _provider: p.name, _providerPriority: priority };
    }, p.opts.concurrency || 3);

    return { provider: p.name, count: snippets.length, candidates: candidates.length, results: full.filter(Boolean) };
  }

  app.options('/search', cors());
  app.get('/search', cors(), async (req, res) => {
    try {
      const str = (v) => (Array.isArray(v) ? v[0] : v || '').toString().trim();
      const query = str(req.query.query);
      const author = str(req.query.author);
      const isbn = ISBN_DIGITS(str(req.query.isbn));
      if (!query) return res.status(400).json({ error: 'query required' });

      // Audiobookshelf sends the library kind: `book` covers audiobooks too. There are no podcasts here.
      if (str(req.query.mediaType).toLowerCase() === 'podcast') return res.json({ providers: [], matches: [] });

      const { config, providers, fullCache } = getRuntime();
      const global = config.global || {};
      // `format=audiobook` or `format=ebook` (`book`) keeps one kind; Audiobookshelf sends neither and gets both.
      const format = str(req.query.format).toLowerCase();
      const ctx = {
        query,
        author,
        fullCache,
        titleWeight: (typeof global.titleWeight === 'number' ? global.titleWeight : 60) / 100,
        threshold: Math.max(0, Math.min(100, typeof global.similarityThreshold === 'number' ? global.similarityThreshold : 0)) / 100,
        wantAudio: global.allowAudiobooks !== false && format !== 'ebook' && format !== 'book',
        wantBooks: global.allowBooks !== false && format !== 'audiobook',
      };

      // The caller waits a limited time (Audiobookshelf: 10 s): a slow source is dropped, the rest is returned.
      const budgetMs = typeof global.searchTimeoutMs === 'number' ? global.searchTimeoutMs : 9000;
      const deadline = Date.now() + budgetMs;
      const outcomes = await mapWithConcurrency(providers, (p) => {
        let timer;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ provider: p.name, count: 0, results: [], error: `timeout after ${budgetMs} ms` }),
            Math.max(0, deadline - Date.now()));
        });
        return Promise.race([runProvider(p, ctx), timeout]).finally(() => clearTimeout(timer));
      }, global.maxProvidersParallel || 5);

      let results = outcomes.flatMap((o) => (o && o.results) || []).map(toAbsMatch);
      // An ISBN given by the caller settles it: that edition goes first.
      if (isbn) {
        for (const r of results) if (r.isbn && ISBN_DIGITS(r.isbn) === isbn) r.similarity = 1;
      }
      sortResults(results);

      if (global.mergeBestResults) {
        try {
          const merged = mergeBestResults(results, global.mergePreferences || {});
          if (merged) {
            results = [merged, ...results];
            log.log('[merge] from', merged._mergedFrom.map((i) => i.provider).join(','), global.mergeDebug ? JSON.stringify(merged._mergedFieldSources) : '');
          }
        } catch (err) {
          log.error('Error during mergeBestResults:', err.message);
        }
      }

      const summary = outcomes.filter(Boolean).map((o) => ({ provider: o.provider, count: o.count, error: o.error }));
      log.log('[search]', JSON.stringify({ query, author: author || undefined, providers: summary, matches: results.length, ms: budgetMs - (deadline - Date.now()) }));
      res.json({ providers: summary, matches: results });
    } catch (err) {
      log.error('Search failed:', err && err.stack ? err.stack : err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  // Config endpoints and pages. Same-origin only (no CORS): another site must not be able to rewrite the config.
  if (adminEnabled) {
    app.get('/admin/config', (req, res) => res.json(store.get()));

    // Every known provider, enabled or not: what the admin form needs to offer.
    app.get('/admin/providers/meta', (req, res) => {
      res.json(Object.entries(providersMeta.providers).map(([name, meta]) => ({ name, ...meta })));
    });

    app.put('/admin/config', express.json({ limit: '256kb' }), (req, res) => {
      try {
        const config = store.save(req.body);
        res.json({ ok: true, config });
      } catch (err) {
        res.status(400).json({ error: err.message, details: err.details || null });
      }
    });

    app.get('/admin', (req, res) => res.sendFile(path.resolve(__dirname, 'admin.html')));
  }

  if (searchUiEnabled) {
    app.get('/search-ui', (req, res) => res.sendFile(path.resolve(__dirname, 'search.html')));
  }

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) log.error('Request failed:', err.message);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
  });

  return { app, warmUp: () => { try { getRuntime(); } catch (err) { log.error(err.message); } } };
}

module.exports = { createApp, norm };
