const express = require('express');
const cors = require('cors');

// Simple backbone that loads provider modules by relative path and proxies /search
// Expected usage: set PROVIDERS env var as a comma-separated list of provider folder paths,
// e.g. PROVIDERS="./audioteka,./lubimyczytac"

const path = require('path');

// Load config and create providers from config
const configLoader = require('../lib/config');
let config = {};
try {
  config = configLoader.loadConfig();
} catch (err) {
  console.error('Failed to load config, exiting:', err.message);
  process.exit(1);
}

const providers = [];
for (const [name, opts] of Object.entries(config.providers || {})) {
  if (!opts.enabled) {
    console.log(`Provider ${name} is disabled in config`);
    continue;
  }

  // Try to resolve provider module in ./<name>/provider.js
  try {
    const candidate = require.resolve(path.resolve(__dirname, '..', name, 'provider.js'));
    // eslint-disable-next-line import/no-dynamic-require
    const ProviderClass = require(candidate);
  const instance = new ProviderClass(opts);
  providers.push({ name, instance, opts, ProviderClass });
    console.log(`Loaded provider ${name}`);
  } catch (err) {
    console.error(`Could not load provider ${name}:`, err.message);
  }
}

const app = express();
const port = process.env.PORT || 4000;
app.use(cors());

const stringSimilarity = require('string-similarity');

app.get('/search', async (req, res) => {
  const q = req.query.query;
  const author = req.query.author;
  if (!q) return res.status(400).json({ error: 'query required' });

  const tasks = providers.map(async (p) => {
    try {
      const results = await p.instance.searchBooks(q, author);
      return { provider: p.name, matches: results.matches || [] };
    } catch (err) {
      return { provider: p.name, error: String(err) };
    }
  });

  const all = await Promise.all(tasks);
  // Flatten matches and tag with provider
  const combined = all.reduce((acc, cur) => {
    if (cur.matches) {
      const providerCfg = (config.providers && config.providers[cur.provider]) || {};
      const priority = typeof providerCfg.priority === 'number' ? providerCfg.priority : 0;
      const tagged = cur.matches.map(m => ({ ...m, _provider: cur.provider, _providerPriority: priority }));
      return acc.concat(tagged);
    }
    return acc;
  }, []);

  // Compute unified similarity for each match across all providers.
  // Strategy: compare match.title to query (case-insensitive) for titleSimilarity.
  // If author provided, compute best author similarity across match.authors and combine: 0.6*title + 0.4*author.
  // Otherwise use titleSimilarity only. On tie, prefer audiobooks over books.
  const cleanedQuery = q.trim().toLowerCase();
  const cleanedAuthor = author ? author.trim().toLowerCase() : '';

  const scored = combined.map(m => {
    const title = (m.title || '').toString().toLowerCase();
    const titleSimilarity = stringSimilarity.compareTwoStrings(title, cleanedQuery);

    let combinedSimilarity = titleSimilarity;
    if (cleanedAuthor && Array.isArray(m.authors) && m.authors.length) {
      const bestAuthorSim = Math.max(...m.authors.map(a => stringSimilarity.compareTwoStrings((a||'').toLowerCase(), cleanedAuthor)));
      combinedSimilarity = (titleSimilarity * 0.6) + (bestAuthorSim * 0.4);
    }

    return { ...m, similarity: combinedSimilarity };
  });

  // Apply global allowBooks/allowAudiobooks filters from config
  const allowBooks = config.global && typeof config.global.allowBooks !== 'undefined' ? !!config.global.allowBooks : true;
  const allowAudiobooks = config.global && typeof config.global.allowAudiobooks !== 'undefined' ? !!config.global.allowAudiobooks : true;

  const filtered = scored.filter(m => {
    const isAudio = (m.type === 'audiobook' || (m.format && m.format === 'audiobook')) ? true : false;
    if (isAudio && !allowAudiobooks) return false;
    if (!isAudio && !allowBooks) return false;
    return true;
  });

  // Sort by similarity desc; on equal similarity, prefer audiobooks over books
  filtered.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    const aIsAudio = (a.type === 'audiobook' || (a.format && a.format === 'audiobook')) ? 1 : 0;
    const bIsAudio = (b.type === 'audiobook' || (b.format && b.format === 'audiobook')) ? 1 : 0;
    if (bIsAudio !== aIsAudio) return bIsAudio - aIsAudio; // audiobook first
    // If both same type (both audiobook or both book), use provider priority (higher first)
    const aPriority = typeof a._providerPriority === 'number' ? a._providerPriority : 0;
    const bPriority = typeof b._providerPriority === 'number' ? b._providerPriority : 0;
    return bPriority - aPriority;
  });

  res.json({ providers: all, matches: filtered });
});

// Admin endpoints for config. If ADMIN_TOKEN is set, require Bearer token; otherwise allow (LAN internal use).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
function checkAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // no auth required
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  const token = header.substring(7);
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Invalid token' });
  next();
}

app.get('/admin/config', checkAdmin, (req, res) => {
  res.json(config);
});

// Provide provider metadata (supported languages etc) to admin UI
app.get('/admin/providers/meta', checkAdmin, (req, res) => {
  const meta = providers.map(p => {
    const supported = (p.ProviderClass && p.ProviderClass.supportedLanguages) || (p.ProviderClass && p.ProviderClass.supportedLanguages) || [];
    return { name: p.name, supportedLanguages: supported };
  });
  res.json(meta);
});

app.put('/admin/config', checkAdmin, express.json(), (req, res) => {
  try {
    const newCfg = req.body;
    // validate and save
    configLoader.saveConfig(newCfg);
    // reload in-memory
    config = configLoader.loadConfig();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, details: err.details || null });
  }
});

// Serve a tiny admin UI for editing the JSON config
app.get('/admin', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'admin.html'));
});

// Serve a small search UI that calls the /search API and renders results
app.get('/search-ui', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'search.html'));
});

app.listen(port, () => console.log(`Backbone listening on ${port}; providers: ${providers.map(p=>p.name).join(',')}`));
