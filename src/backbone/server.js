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

  // Normalize authors field on snippets so scoring code can safely call toLowerCase()
  for (const m of combined) {
    if (Array.isArray(m.authors)) {
      m.authors = m.authors.map(a => (typeof a === 'string' ? a.trim() : (a ? String(a).trim() : ''))).filter(Boolean);
    } else if (m.author && typeof m.author === 'string') {
      // split common separators
      m.authors = m.author.split(/\s*(?:,|;| and )\s*/).map(s => s.trim()).filter(Boolean);
    } else {
      m.authors = [];
    }
  }

  // Log provider snippet counts (minimal but informative)
  try {
    const providerSnippetCounts = {};
    for (const a of all) {
      providerSnippetCounts[a.provider] = (a.matches && a.matches.length) || 0;
    }
    console.log('[search] provider snippets:', JSON.stringify(providerSnippetCounts));
  } catch (e) { /* ignore logging errors */ }

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

  // Log candidate counts and planned full-metadata fetches
  try {
    const candidateCounts = {};
    let plannedFetches = 0;
    for (const [prov, arr] of Object.entries(byProvider)) {
      candidateCounts[prov] = arr.length;
      // we'll fetch only those without _fullFetched
      plannedFetches += arr.filter(i => !i._fullFetched).length;
    }
    console.log('[search] candidates:', JSON.stringify(candidateCounts), 'plannedFullFetches=', plannedFetches);
  } catch (e) { /* ignore logging errors */ }

  // For each provider, fetch full metadata for its candidates
  const fullFetchPromises = Object.entries(byProvider).map(async ([providerName, matches]) => {
    const providerObj = providers.find(p => p.name === providerName);
    if (!providerObj) return [];
    const inst = providerObj.instance;
    // If provider exposes mapWithConcurrency, use it for parallel metadata fetches
    const limit = (config.providers && config.providers[providerName] && config.providers[providerName].concurrency) || 5;
    const toFetch = matches.filter(m => !m._fullFetched);

    // If provider exposes mapWithConcurrency, use it for parallel metadata fetches
    if (typeof inst.mapWithConcurrency === 'function') {
      try {
        const results = await inst.mapWithConcurrency(toFetch, async (match) => {
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
        // Merge fetched results back with matches that were already full
        const fetched = results.filter(Boolean);
        const alreadyFull = matches.filter(m => m._fullFetched);
        return [...alreadyFull, ...fetched];
      } catch (err) {
        console.error(`Error in mapWithConcurrency for provider ${providerName}:`, err && err.message ? err.message : err);
        return matches;
      }
    }

    // Fallback: sequential fetches for the ones that need fetching
    const out = [];
    // include already-full items first
    for (const m of matches.filter(m => m._fullFetched)) out.push(m);
    for (const match of toFetch) {
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

        const hasField = (item, field) => {
          if (!item) return false;
          if (field === 'language') return Array.isArray(item.languages) && item.languages.length;
          if (field === 'identifiers') return item.identifiers && Object.keys(item.identifiers).length > 0;
          const v = item[field];
          if (Array.isArray(v)) return v.length > 0;
          return (typeof v !== 'undefined' && v !== null && v !== '');
        };

        const getFieldValue = (item, field) => {
          if (!item) return undefined;
          if (field === 'language') return Array.isArray(item.languages) && item.languages.length ? item.languages[0] : undefined;
          return item[field];
        };

        const pickFieldAndSource = (field) => {
          const preferred = prefs && prefs[field];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && hasField(i, field));
            if (p) return { value: getFieldValue(p, field), source: preferred };
          }
          const contributor = sortedGroup.find(i => hasField(i, field));
          if (contributor) return { value: getFieldValue(contributor, field), source: contributor._provider };
          return { value: undefined, source: null };
        };

        const pickIdentifierAndSource = (key) => {
          const preferred = prefs && prefs['identifiers'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.identifiers && i.identifiers[key]);
            if (p) return { value: p.identifiers[key], source: preferred };
          }
          for (const it of sortedGroup) {
            if (it.identifiers && it.identifiers[key]) return { value: it.identifiers[key], source: it._provider };
          }
          return { value: undefined, source: null };
        };

        const pickPublishedYearAndSource = () => {
          const preferred = prefs && prefs['publishedYear'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && i.publishedDate);
            if (p) return { value: (new Date(p.publishedDate).getFullYear() || '').toString(), source: preferred };
          }
          for (const it of sortedGroup) {
            if (it.publishedDate) {
              const y = new Date(it.publishedDate).getFullYear();
              if (y) return { value: y.toString(), source: it._provider };
            }
          }
          return { value: undefined, source: null };
        };

        const pickLanguageAndSource = () => {
          const preferred = prefs && prefs['language'];
          if (preferred) {
            const p = sortedGroup.find(i => i._provider === preferred && Array.isArray(i.languages) && i.languages.length);
            if (p) return { value: p.languages[0], source: preferred };
          }
          for (const it of sortedGroup) {
            if (Array.isArray(it.languages) && it.languages.length) return { value: it.languages[0], source: it._provider };
          }
          return { value: undefined, source: null };
        };

        // pick cover using preference and record source
        const coverPick = pickFieldAndSource('cover');
        let coverValue = coverPick.value;
        let coverSource = coverPick.source;
        // prefer audiobook cover if preferred didn't yield
        if (!coverValue) {
          const audioCandidate = sortedGroup.find(i => (i.type === 'audiobook' || (i.format && i.format === 'audiobook')) && i.cover);
          if (audioCandidate) {
            coverValue = audioCandidate.cover;
            coverSource = audioCandidate._provider;
          }
        }

        // merged object: copy many common fields, merging arrays/identifiers
        const merged = {};
        const titlePick = pickFieldAndSource('title'); merged.title = titlePick.value || '';
        const subtitlePick = pickFieldAndSource('subtitle'); merged.subtitle = subtitlePick.value || '';
        const authorsPick = pickFieldAndSource('authors'); merged.authors = authorsPick.value || [];
        const narratorPick = pickFieldAndSource('narrator'); merged.narrator = narratorPick.value || '';
        const descriptionPick = pickFieldAndSource('description'); merged.description = descriptionPick.value || '';
        merged.cover = coverValue || null;
        merged.type = (pickFieldAndSource('type').value) || (topGroup.some(i => i.type === 'audiobook') ? 'audiobook' : 'book');
        merged.similarity = topSim;

        // URL/id/source
  merged.id = (pickFieldAndSource('id').value) || pickIdentifierAndSource('lubimyczytac').value || pickIdentifierAndSource('audioteka').value || '';
  merged.url = (pickFieldAndSource('url').value) || '';
  merged.source = pickFieldAndSource('source').value || null;

        // languages: union
        const langs = new Set();
        for (const it of sortedGroup) {
          if (Array.isArray(it.languages)) for (const L of it.languages) langs.add(L);
        }
        merged.languages = Array.from(langs);

  merged.publisher = pickFieldAndSource('publisher').value || '';
  merged.publishedYear = pickPublishedYearAndSource().value || undefined;
  merged.rating = pickFieldAndSource('rating').value || null;
        // series: respect preference, else gather from any provider (string or array), prefer first non-empty
        const seriesPref = prefs && prefs['series'];
        let chosenSeries = '';
        let seriesIndex = null;
        if (seriesPref) {
          const p = sortedGroup.find(i => i._provider === seriesPref && (i.series || (Array.isArray(i.series) && i.series.length)));
          if (p) {
            if (Array.isArray(p.series)) chosenSeries = p.series[0];
            else chosenSeries = p.series || '';
            seriesIndex = typeof p.seriesIndex !== 'undefined' ? p.seriesIndex : null;
          }
        }
        if (!chosenSeries) {
          const seriesSet = new Set();
          for (const it of sortedGroup) {
            if (Array.isArray(it.series)) for (const s of it.series) if (s) seriesSet.add(s);
            else if (it.series) seriesSet.add(it.series);
            if (!seriesIndex && (typeof it.seriesIndex !== 'undefined' && it.seriesIndex !== null)) seriesIndex = it.seriesIndex;
          }
          const seriesArr = Array.from(seriesSet);
          chosenSeries = seriesArr.length ? seriesArr[0] : '';
        }
        // Provide series in the same shape provider wrappers use (array of { series, sequence })
        // This is what Audiobookshelf expects when importing series information.
        if (chosenSeries) {
          merged.series = [{ series: chosenSeries, sequence: (seriesIndex !== null && typeof seriesIndex !== 'undefined') ? String(seriesIndex) : undefined }];
        } else {
          merged.series = undefined;
        }
        // keep legacy seriesIndex field for compatibility
        merged.seriesIndex = (typeof seriesIndex !== 'undefined' && seriesIndex !== null) ? seriesIndex : null;

  const isbnPick = pickIdentifierAndSource('isbn'); merged.isbn = isbnPick.value || undefined;
  const asinPick = pickIdentifierAndSource('asin'); merged.asin = asinPick.value || undefined;
  const durationPick = pickFieldAndSource('duration'); merged.duration = durationPick.value || undefined;
  merged.url = merged.url || '';
  const languagePick = pickLanguageAndSource(); merged.language = languagePick.value || undefined;

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
  merged._mergedFieldSources.genres = (prefs && prefs['genres']) ? prefs['genres'] : Array.from(new Set(sortedGroup.filter(i=> (i.genres && i.genres.length) || (typeof i.genres === 'string' && i.genres)).map(i=>i._provider)));
  merged._mergedFieldSources.tags = (prefs && prefs['tags']) ? prefs['tags'] : Array.from(new Set(sortedGroup.filter(i=> (i.tags && i.tags.length) || (typeof i.tags === 'string' && i.tags)).map(i=>i._provider)));
  merged._mergedFieldSources.series = (prefs && prefs['series']) ? prefs['series'] : Array.from(new Set(sortedGroup.filter(i=> (i.series && (Array.isArray(i.series) ? i.series.length : !!i.series))).map(i=>i._provider)));

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
        // provenance for specific single-valued fields
        merged._mergedFieldSources = merged._mergedFieldSources || {};
        const singleFields = ['narrator','publisher','language','subtitle','duration','url','source'];
        for (const f of singleFields) {
          const pref = prefs && prefs[f];
          if (pref) {
            const p = sortedGroup.find(i => i._provider === pref && (i[f] || (f==='language' && i.languages && i.languages.length)));
            if (p) merged._mergedFieldSources[f] = pref;
            else {
              const contributor = sortedGroup.find(i => i[f] || (f==='language' && i.languages && i.languages.length));
              if (contributor) merged._mergedFieldSources[f] = contributor._provider;
            }
          } else {
            const contributor = sortedGroup.find(i => i[f] || (f==='language' && i.languages && i.languages.length));
            if (contributor) merged._mergedFieldSources[f] = contributor._provider;
          }
        }
        // optional debug logging
        if (config.global && config.global.mergeDebug) {
          try {
            console.log('mergeBestResults topGroup providers:', topGroup.map(t => ({ provider: t._provider, priority: t._providerPriority, fields: Object.keys(t).filter(k=>!!t[k]) })));
            console.log('mergeBestResults merged:', merged);
          } catch (e) { /* ignore logging errors */ }
        }
        // concise provenance log for regular ops (always useful)
        try {
          if (merged && merged._mergedFieldSources) {
            console.log('[merge] merged from providers:', Array.from(new Set(topGroup.map(i=>i._provider))).join(','), 'fieldSources=', JSON.stringify(merged._mergedFieldSources));
          } else {
            console.log('[merge] merged from providers:', Array.from(new Set(topGroup.map(i=>i._provider))).join(','));
          }
        } catch (e) { /* ignore logging errors */ }
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

  // Normalize author fields for all results so downstream consumers (like Audiobookshelf)
  // reliably see both `authors` (array) and `author` (string).
  const normalizeAuthors = (item) => {
    if (!item) return;
    // Normalize authors -> array of trimmed names
    if (Array.isArray(item.authors)) {
      item.authors = item.authors.map(a => (a || '').toString().trim()).filter(Boolean);
    } else if (item.author && typeof item.author === 'string') {
      // split common separators: comma, semicolon, ' and '
      const parts = item.author.split(/\s*(?:,|;| and )\s*/).map(s => s.trim()).filter(Boolean);
      item.authors = parts;
    } else {
      item.authors = item.authors || [];
    }

    // Ensure singular author string exists (joined)
    if (!item.author || typeof item.author !== 'string' || !item.author.trim()) {
      item.author = item.authors && item.authors.length ? item.authors.join(', ') : undefined;
    } else {
      item.author = item.author.trim();
    }
  };

  for (const it of fullResults) normalizeAuthors(it);
  // Ensure subtitle and publisher exist where possible by looking into identifiers or nested fields
  for (const it of fullResults) {
    if ((!it.subtitle || it.subtitle === '') && it.identifiers && it.identifiers.title) {
      it.subtitle = it.identifiers.title;
    }
    if ((!it.publisher || it.publisher === '') && it.source && it.source.description) {
      it.publisher = it.source.description;
    }
  }

  res.json({ providers: all, matches: fullResults });
});

// Admin endpoints for config — no authentication enforced (LAN use assumed).
function checkAdmin(req, res, next) {
  // deliberately allow all requests; remove ADMIN_TOKEN gating to simplify local use
  return next();
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
