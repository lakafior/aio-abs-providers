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

let providers = [];

function reloadProviders(cfg) {
  providers = [];
  for (const [name, opts] of Object.entries((cfg && cfg.providers) || {})) {
    if (!opts.enabled) {
      console.log(`Provider ${name} is disabled in config`);
      continue;
    }

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
}

// initial load
reloadProviders(config);

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
      // Pass provider configured language (if available) so providers like Storytel can use it
      const providerLang = (config.providers && config.providers[p.name] && config.providers[p.name].language) || undefined;
      const results = await p.instance.searchBooks(q, author, providerLang);
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
  const titleWeight = (config.global && typeof config.global.titleWeight === 'number') ? (config.global.titleWeight / 100) : 0.6; // fraction
  const authorWeight = 1 - titleWeight;

  const scored = combined.map(m => {
    const title = (m.title || '').toString().toLowerCase();
    const titleSimilarity = stringSimilarity.compareTwoStrings(title, cleanedQuery);

    let combinedSimilarity = titleSimilarity;
    if (cleanedAuthor && Array.isArray(m.authors) && m.authors.length) {
      const bestAuthorSim = Math.max(...m.authors.map(a => stringSimilarity.compareTwoStrings((a||'').toLowerCase(), cleanedAuthor)));
      combinedSimilarity = (titleSimilarity * titleWeight) + (bestAuthorSim * authorWeight);
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

  // At this point 'filtered' contains scored items we may want to show.
  // Apply similarity threshold: only fetch full metadata for matches >= threshold and show those.
  const thresholdPct = (config.global && typeof config.global.similarityThreshold === 'number') ? config.global.similarityThreshold : 0;
  const threshold = Math.max(0, Math.min(100, thresholdPct)) / 100;

  // Candidates above threshold
  const candidates = filtered.filter(m => (typeof m.similarity === 'number') ? (m.similarity >= threshold) : false);

  // Group by provider name
  const byProvider = candidates.reduce((acc, m) => {
    (acc[m._provider] = acc[m._provider] || []).push(m);
    return acc;
  }, {});

  // For each provider, fetch full metadata for its candidates
  const fullFetchPromises = Object.entries(byProvider).map(async ([providerName, matches]) => {
    const providerObj = providers.find(p => p.name === providerName);
    if (!providerObj) return [];
    const inst = providerObj.instance;
    // If provider exposes mapWithConcurrency, use it for parallel metadata fetches
    if (typeof inst.mapWithConcurrency === 'function') {
      try {
        const limit = (config.providers && config.providers[providerName] && config.providers[providerName].concurrency) || 5;
        const results = await inst.mapWithConcurrency(matches, async (match) => {
          try {
            if (typeof inst.getFullMetadata === 'function') {
              return await inst.getFullMetadata(match);
            }
            return match;
          } catch (err) {
            console.error(`Error fetching metadata for provider ${providerName}:`, err && err.message ? err.message : err);
            return null;
          }
        }, limit);
        return results.filter(Boolean);
      } catch (err) {
        console.error(`Error in mapWithConcurrency for provider ${providerName}:`, err && err.message ? err.message : err);
        return [];
      }
    }

    // Fallback: sequential fetches
    const out = [];
    for (const match of matches) {
      try {
        if (typeof inst.getFullMetadata === 'function') {
          const full = await inst.getFullMetadata(match);
          if (full) out.push(full);
        } else {
          out.push(match);
        }
      } catch (err) {
        console.error(`Error fetching metadata for provider ${providerName}:`, err && err.message ? err.message : err);
      }
    }
    return out;
  });

  const nested = await Promise.all(fullFetchPromises);
  const fullResults = nested.flat();

  // Sort final results same as before (similarity desc, audiobook preference, provider priority)
  fullResults.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    const aIsAudio = (a.type === 'audiobook' || (a.format && a.format === 'audiobook')) ? 1 : 0;
    const bIsAudio = (b.type === 'audiobook' || (b.format && b.format === 'audiobook')) ? 1 : 0;
    if (bIsAudio !== aIsAudio) return bIsAudio - aIsAudio;
    const aPriority = typeof a._providerPriority === 'number' ? a._providerPriority : 0;
    const bPriority = typeof b._providerPriority === 'number' ? b._providerPriority : 0;
    return bPriority - aPriority;
  });

  res.json({ providers: all, matches: fullResults });
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
    // reload provider instances in background
    try {
      reloadProviders(config);
    } catch (err) {
      console.error('Error reloading providers after config save:', err && err.message ? err.message : err);
    }
    console.log('Config saved. global.titleWeight=', (config.global && config.global.titleWeight));
    res.json({ ok: true, config });
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
