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

  // Apply per-provider maxResults cap BEFORE thresholding to limit noisy providers
  // Group filtered items by provider
  const byProviderAll = filtered.reduce((acc, m) => {
    (acc[m._provider] = acc[m._provider] || []).push(m);
    return acc;
  }, {});

  // For each provider, sort by similarity and apply maxResults if configured (>0)
  const cappedByProvider = {};
  for (const [providerName, matches] of Object.entries(byProviderAll)) {
    const providerCfg = (config.providers && config.providers[providerName]) || {};
    const max = typeof providerCfg.maxResults === 'number' ? providerCfg.maxResults : 0;
    let sorted = matches.slice().sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    if (max > 0) sorted = sorted.slice(0, max);
    cappedByProvider[providerName] = sorted;
  }

  const capped = Object.values(cappedByProvider).flat();

  // Candidates above threshold (after per-provider capping)
  const candidates = capped.filter(m => (typeof m.similarity === 'number') ? (m.similarity >= threshold) : false);

  // Group by provider name for metadata fetching
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

  // Optionally create a merged "best result" at the top that combines fields from top-equal items
  try {
    const mergeEnabled = config.global && !!config.global.mergeBestResults;
    if (mergeEnabled && fullResults && fullResults.length) {
      // find top similarity value
      const topSim = fullResults[0].similarity || 0;
      // allow tiny epsilon
      const EPS = 1e-6;
      const topGroup = fullResults.filter(fr => Math.abs((fr.similarity || 0) - topSim) <= EPS);
      if (topGroup.length > 1) {
        // Prefer items with higher provider priority and more metadata when selecting fields
        const countNonEmpty = (item) => {
          const fields = ['title','authors','narrator','description','cover','type','url','id','languages','publisher','publishedDate','series','genres','tags','identifiers'];
          let c = 0;
          for (const f of fields) if (item[f]) c++;
          return c;
        };

        const sortedGroup = topGroup.slice().sort((a, b) => {
          const pa = typeof a._providerPriority === 'number' ? a._providerPriority : 0;
          const pb = typeof b._providerPriority === 'number' ? b._providerPriority : 0;
          if (pb !== pa) return pb - pa;
          return countNonEmpty(b) - countNonEmpty(a);
        });

        const prefs = (config.global && config.global.mergePreferences) || {};
        const pickFieldFromSorted = (field) => {
          // If user configured a preferred provider for this field, try it first
          const preferred = prefs && prefs[field];
          if (preferred) {
            const preferredItem = sortedGroup.find(i => i._provider === preferred && i[field]);
            if (preferredItem) return preferredItem[field];
          }
          for (const item of sortedGroup) {
            if (item[field]) return item[field];
          }
          return undefined;
        };

        // helpers for alias fields
        const pickIdentifier = (key) => {
          // preferred provider first
          const preferred = prefs && prefs['identifiers'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.identifiers && i.identifiers[key]);
            if (p) return p.identifiers[key];
          }
          for (const it of sortedGroup) {
            if (it.identifiers && it.identifiers[key]) return it.identifiers[key];
          }
          return undefined;
        };

        const pickPublishedYear = () => {
          const preferred = prefs && prefs['publishedYear'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.publishedDate);
            if (p) return (new Date(p.publishedDate).getFullYear() || '').toString();
          }
          for (const it of sortedGroup) {
            if (it.publishedDate) {
              const y = new Date(it.publishedDate).getFullYear();
              if (y) return y.toString();
            }
          }
          return undefined;
        };

        const pickLanguage = () => {
          const preferred = prefs && prefs['language'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.languages && i.languages.length);
            if (p) return p.languages[0];
          }
          for (const it of sortedGroup) {
            if (Array.isArray(it.languages) && it.languages.length) return it.languages[0];
          }
          return undefined;
        };

        // pick cover: prefer audiobook (square) covers when available among sortedGroup, otherwise first available
        let cover = null;
        const audioCandidate = sortedGroup.find(i => (i.type === 'audiobook' || (i.format && i.format === 'audiobook')) && i.cover);
        if (audioCandidate) cover = audioCandidate.cover;
        if (!cover) cover = pickFieldFromSorted('cover') || pickFieldFromSorted('image') || null;

        // merged object: copy many common fields, merging arrays/identifiers
        const merged = {};
  merged.title = pickFieldFromSorted('title') || '';
  merged.subtitle = pickFieldFromSorted('subtitle') || '';
  merged.authors = pickFieldFromSorted('authors') || [];
  merged.narrator = pickFieldFromSorted('narrator') || pickFieldFromSorted('lector') || '';
  merged.description = pickFieldFromSorted('description') || pickFieldFromSorted('summary') || '';
        merged.cover = cover;
        merged.type = pickFieldFromSorted('type') || pickFieldFromSorted('format') || (topGroup.some(i => i.type === 'audiobook') ? 'audiobook' : 'book');
        merged.similarity = topSim;

        // URL/id/source
  merged.id = pickFieldFromSorted('id') || pickFieldFromSorted('_id') || pickIdentifier('lubimyczytac') || pickIdentifier('audioteka') || '';
  merged.url = pickFieldFromSorted('url') || pickFieldFromSorted('link') || '';
  merged.source = pickFieldFromSorted('source') || null;

        // languages: union
        const langs = new Set();
        for (const it of sortedGroup) {
          if (Array.isArray(it.languages)) for (const L of it.languages) langs.add(L);
        }
        merged.languages = Array.from(langs);

  merged.publisher = pickFieldFromSorted('publisher') || '';
  merged.publishedYear = pickPublishedYear() || undefined;
  merged.rating = pickFieldFromSorted('rating') || null;
        // series: gather from any provider (string or array), prefer first non-empty
        const seriesSet = new Set();
        let seriesIndex = null;
        for (const it of sortedGroup) {
          if (Array.isArray(it.series)) for (const s of it.series) seriesSet.add(s);
          else if (it.series) seriesSet.add(it.series);
          if (!seriesIndex && (typeof it.seriesIndex !== 'undefined' && it.seriesIndex !== null)) seriesIndex = it.seriesIndex;
        }
        const seriesArr = Array.from(seriesSet);
  merged.series = seriesArr.length ? seriesArr[0] : '';
  merged.seriesIndex = seriesIndex || null;

  merged.isbn = pickIdentifier('isbn') || undefined;
  merged.asin = pickIdentifier('asin') || undefined;
  merged.duration = pickFieldFromSorted('duration') || undefined;
  merged.url = merged.url || pickFieldFromSorted('url') || undefined;
  merged.language = pickLanguage() || undefined;

        // genres/tags: respect preference, else union and normalize/dedupe
        const normalize = (s) => (s || '').toString().trim().toLowerCase();
        const pickListPrefOrUnion = (field) => {
          const preferredProvider = prefs && prefs[field];
          if (preferredProvider) {
            const p = sortedGroup.find(i => i._provider === preferredProvider && Array.isArray(i[field]) && i[field].length);
            if (p) return p[field].slice();
          }
          const set = new Set();
          for (const it of sortedGroup) {
            if (Array.isArray(it[field])) for (const v of it[field]) {
              const n = normalize(v);
              if (n) set.add(n);
            }
          }
          return Array.from(set);
        };

        merged.genres = pickListPrefOrUnion('genres');
        merged.tags = pickListPrefOrUnion('tags');

        // record provenance for these merged lists
        merged._mergedFieldSources = merged._mergedFieldSources || {};
        merged._mergedFieldSources.genres = (prefs && prefs['genres']) ? prefs['genres'] : Array.from(new Set(sortedGroup.filter(i=>i.genres && i.genres.length).map(i=>i._provider)));
        merged._mergedFieldSources.tags = (prefs && prefs['tags']) ? prefs['tags'] : Array.from(new Set(sortedGroup.filter(i=>i.tags && i.tags.length).map(i=>i._provider)));

        // identifiers: merge keys preferring earlier providers
        const identifiers = {};
        for (const it of sortedGroup) {
          if (it.identifiers && typeof it.identifiers === 'object') {
            for (const [k, v] of Object.entries(it.identifiers)) {
              if (!identifiers[k] && v) identifiers[k] = v;
            }
          }
        }
        merged.identifiers = identifiers;

  merged._mergedFrom = topGroup.map(i => ({ provider: i._provider, id: i.id || i._id || null }));
        // optional debug logging
        if (config.global && config.global.mergeDebug) {
          try {
            console.log('mergeBestResults topGroup providers:', topGroup.map(t => ({ provider: t._provider, priority: t._providerPriority, fields: Object.keys(t).filter(k=>!!t[k]) })));
            console.log('mergeBestResults merged:', merged);
          } catch (e) { /* ignore logging errors */ }
        }
  // mark this synthetic result so frontends can easily identify it
  merged._provider = 'merged';
  // give merged a priority slightly above the highest provider in the group
  merged._providerPriority = (Math.max(...topGroup.map(i => (typeof i._providerPriority === 'number' ? i._providerPriority : 0))) || 0) + 1;
  merged.source = merged.source || { id: 'merged', description: 'Merged result' };

        // Insert merged at the top if it is not redundant with the existing top item.
        const top = fullResults[0];
        const sameTitleAuthors = top.title === merged.title && top.authors && merged.authors && top.authors.join('|') === merged.authors.join('|');
        const mergedFields = ['narrator', 'description', 'cover', 'languages', 'identifiers', 'genres', 'tags'];
        const topHasAllMergedFields = mergedFields.every(f => {
          if (!merged[f] || (Array.isArray(merged[f]) && merged[f].length === 0)) return true; // merged doesn't have it, ignore
          if (Array.isArray(merged[f])) return Array.isArray(top[f]) && top[f].length > 0;
          if (f === 'identifiers') return top[f] && Object.keys(top[f]).length > 0;
          return !!top[f]; // merged has it -> top must also have it
        });
        if (!(sameTitleAuthors && topHasAllMergedFields)) {
          fullResults.unshift(merged);
        }
      }
    }
  } catch (err) {
    console.error('Error during mergeBestResults:', err && err.message ? err.message : err);
  }

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
