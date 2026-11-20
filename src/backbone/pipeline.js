// Pure parts of the search pipeline: scoring, the shape handed to Audiobookshelf, and merging.
// No network and no config file here, so the tests can run them on recorded data.

const stringSimilarity = require('string-similarity');

// Compared without case, diacritics or punctuation: phones type "wiedzmin" for "Wiedźmin.".
const norm = (s) => (s || '').toString().toLowerCase()
  .replace(/ł/g, 'l')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

const isAudio = (m) => m.type === 'audiobook' || m.format === 'audiobook';

const has = (v) => {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && !(v instanceof Date)) return Object.keys(v).length > 0;
  return true;
};

/** `authors` as an array of names, whatever the provider sent (`authors` array or one `author` string). */
function authorsOf(m) {
  if (Array.isArray(m.authors)) return m.authors.map((a) => (a == null ? '' : String(a).trim())).filter(Boolean);
  if (typeof m.author === 'string') return m.author.split(/\s*(?:,|;| and )\s*/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/**
 * Similarity of a snippet to what was asked, 0..1. Title alone, or title and best-matching author weighted
 * by `titleWeight` (0..1) when the caller named an author.
 */
function scoreMatch(m, query, author, titleWeight = 0.6) {
  const cleanedQuery = norm(query);
  const cleanedAuthor = author ? norm(author) : '';
  const title = norm(m.title);
  const authors = authorsOf(m);
  // Free-text callers (Dove) put the author in the query: "andy weir project hail mary" should still match
  // "Project Hail Mary" by Andy Weir, so the query is also compared with author + title, both ways round.
  const names = norm(authors.join(' '));
  const titleSimilarity = Math.max(
    stringSimilarity.compareTwoStrings(title, cleanedQuery),
    names ? stringSimilarity.compareTwoStrings(`${names} ${title}`, cleanedQuery) : 0,
    names ? stringSimilarity.compareTwoStrings(`${title} ${names}`, cleanedQuery) : 0,
  );
  if (cleanedAuthor && authors.length) {
    const bestAuthor = Math.max(...authors.map((a) => stringSimilarity.compareTwoStrings(norm(a), cleanedAuthor)));
    return titleSimilarity * titleWeight + bestAuthor * (1 - titleWeight);
  }
  return titleSimilarity;
}

function yearOf(v) {
  if (!has(v)) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : String(v.getUTCFullYear());
  const found = String(v).match(/\d{4}/);
  return found ? found[0] : undefined;
}

function dateOf(v) {
  if (!has(v)) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  return String(v);
}

const sequenceOf = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));

/** Series as Audiobookshelf reads it: `[{ series, sequence? }]`. Providers send a name, names or objects. */
function seriesOf(m) {
  const list = Array.isArray(m.series) ? m.series : (has(m.series) ? [m.series] : []);
  const out = [];
  for (const s of list) {
    if (typeof s === 'string' && s.trim()) {
      const entry = { series: s.trim() };
      const seq = sequenceOf(m.seriesIndex);
      if (seq && out.length === 0) entry.sequence = seq;
      out.push(entry);
    } else if (s && typeof s.series === 'string' && s.series.trim()) {
      const entry = { series: s.series.trim() };
      const seq = sequenceOf(s.sequence);
      if (seq) entry.sequence = seq;
      out.push(entry);
    }
  }
  return out.length ? out : undefined;
}

function stringList(v) {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : []);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

const ISBN_DIGITS = (v) => String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();

/**
 * One result in the shape every consumer gets. The top-level `title, subtitle, author, narrator, publisher,
 * publishedYear, description, cover, isbn, asin, genres, tags, series, language, duration` are exactly what
 * Audiobookshelf's CustomProviderAdapter reads; the rest (`authors`, `type`, `similarity`, `identifiers`,
 * `url`, `_provider`, ...) is for the search page and other clients.
 */
function toAbsMatch(m) {
  const authors = authorsOf(m);
  const series = seriesOf(m);
  const identifiers = { ...(m.identifiers || {}) };
  const isbn = has(m.isbn) ? String(m.isbn) : (has(identifiers.isbn) ? String(identifiers.isbn) : undefined);
  const asin = has(m.asin) ? String(m.asin) : (has(identifiers.asin) ? String(identifiers.asin) : undefined);
  for (const k of Object.keys(identifiers)) if (!has(identifiers[k])) delete identifiers[k];
  if (isbn) identifiers.isbn = isbn;
  if (asin) identifiers.asin = asin;

  // `language` is the main one; `languages` lists it first.
  const languages = stringList([...(has(m.language) ? [String(m.language)] : []), ...(Array.isArray(m.languages) ? m.languages : [])]);
  const publishedDate = dateOf(m.publishedDate);
  const publishedYear = has(m.publishedYear) ? yearOf(m.publishedYear) : yearOf(publishedDate);
  const duration = Number(m.duration);
  const narrator = Array.isArray(m.narrator) ? m.narrator : (typeof m.narrator === 'string' ? m.narrator.split(',') : []);

  const out = {
    title: has(m.title) ? String(m.title).trim() : undefined,
    subtitle: has(m.subtitle) ? String(m.subtitle).trim() : undefined,
    author: authors.length ? authors.join(', ') : undefined,
    authors,
    narrator: stringList(narrator).join(', ') || undefined,
    publisher: has(m.publisher) ? String(m.publisher).trim() : undefined,
    publishedYear,
    publishedDate,
    description: typeof m.description === 'string' && m.description.trim() ? m.description.trim() : undefined,
    cover: typeof m.cover === 'string' && m.cover ? m.cover : undefined,
    isbn,
    asin,
    genres: stringList(m.genres),
    tags: stringList(m.tags),
    series,
    seriesIndex: series && series[0].sequence !== undefined ? series[0].sequence : undefined,
    language: languages[0],
    languages,
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    type: isAudio(m) ? 'audiobook' : 'book',
    rating: has(m.rating) ? m.rating : undefined,
    id: has(m.id) ? m.id : undefined,
    url: has(m.url) ? m.url : undefined,
    source: m.source || undefined,
    identifiers,
    similarity: m.similarity,
    // Older importers look for these two names.
    published: publishedYear,
    published_date: publishedDate,
    _provider: m._provider,
    _providerPriority: m._providerPriority,
  };
  if (m.productType) out.productType = m.productType;
  if (m._mergedFrom) out._mergedFrom = m._mergedFrom;
  if (m._mergedFieldSources) out._mergedFieldSources = m._mergedFieldSources;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Results ordered for display: similarity, then audiobooks first, then provider priority. */
function sortResults(results) {
  return results.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    if (isAudio(b) !== isAudio(a)) return (isAudio(b) ? 1 : 0) - (isAudio(a) ? 1 : 0);
    return (b._providerPriority || 0) - (a._providerPriority || 0);
  });
}

const MERGE_SINGLE_FIELDS = ['title', 'subtitle', 'authors', 'narrator', 'description', 'cover', 'type', 'publisher',
  'rating', 'duration', 'url', 'id', 'source', 'publishedDate', 'publishedYear', 'language'];
const COUNTED_FIELDS = ['title', 'authors', 'narrator', 'description', 'cover', 'type', 'url', 'id', 'languages',
  'publisher', 'publishedDate', 'series', 'genres', 'tags', 'identifiers'];

/** Same work in the same form: equal title, the same kind (audiobook or book) and an author in common. */
function sameEdition(a, b) {
  if (norm(a.title) !== norm(b.title) || isAudio(a) !== isAudio(b)) return false;
  const authorsA = (a.authors || []).map(norm).filter(Boolean);
  const authorsB = new Set((b.authors || []).map(norm).filter(Boolean));
  if (!authorsA.length || !authorsB.size) return authorsA.length === authorsB.size;
  return authorsA.some((name) => authorsB.has(name));
}

/**
 * Builds one result out of the top result and the results that describe the same thing: the same score, title
 * and kind, and an author in common (expects `results` sorted and in the `toAbsMatch` shape). An audiobook is
 * never mixed with the printed book, nor with another work that merely scored the same. Each field comes from
 * the provider named in `prefs[field]` when that provider has it, otherwise from the highest-priority result
 * that has it; genres, tags and languages without a preferred provider are the union. Returns `null` when
 * there is nothing to merge or the top result already has it all.
 */
function mergeBestResults(results, prefs = {}) {
  if (!results.length) return null;
  const topSim = results[0].similarity || 0;
  const group = results.filter((r) => Math.abs((r.similarity || 0) - topSim) <= 1e-6 && sameEdition(results[0], r));
  if (group.length < 2) return null;

  const filled = (item) => COUNTED_FIELDS.filter((f) => has(item[f])).length;
  const sorted = group.slice().sort((a, b) => ((b._providerPriority || 0) - (a._providerPriority || 0)) || (filled(b) - filled(a)));

  const sources = {};
  const pick = (field, prefKeys = [field]) => {
    for (const key of prefKeys) {
      const preferred = prefs[key];
      if (!preferred) continue;
      const item = sorted.find((i) => i._provider === preferred && has(i[field]));
      if (item) {
        sources[field] = preferred;
        return item[field];
      }
    }
    const item = sorted.find((i) => has(i[field]));
    if (!item) return undefined;
    sources[field] = item._provider;
    return item[field];
  };
  const pickList = (field) => {
    const preferred = prefs[field];
    const item = preferred && sorted.find((i) => i._provider === preferred && has(i[field]));
    if (item) {
      sources[field] = preferred;
      return item[field].slice();
    }
    const contributors = sorted.filter((i) => has(i[field]));
    if (contributors.length) sources[field] = [...new Set(contributors.map((i) => i._provider))];
    return stringList(contributors.flatMap((i) => i[field]));
  };

  const merged = {};
  for (const f of MERGE_SINGLE_FIELDS) merged[f] = pick(f);
  merged.isbn = pick('isbn', ['isbn', 'identifiers']);
  merged.asin = pick('asin', ['asin', 'identifiers']);
  merged.genres = pickList('genres');
  merged.tags = pickList('tags');
  merged.languages = stringList(sorted.flatMap((i) => i.languages || []));

  const series = pick('series');
  if (series) {
    merged.series = series.map((s) => ({ ...s }));
    // The preferred source may name the series without a volume number: take it from one that has it.
    if (merged.series[0].sequence === undefined) {
      const sameName = norm(merged.series[0].series);
      const numbered = sorted.find((i) => has(i.series) && i.series[0].sequence !== undefined && norm(i.series[0].series) === sameName)
        || sorted.find((i) => has(i.series) && i.series[0].sequence !== undefined);
      if (numbered) merged.series[0].sequence = numbered.series[0].sequence;
    }
  }

  const identifiers = {};
  for (const item of sorted) {
    for (const [k, v] of Object.entries(item.identifiers || {})) if (!identifiers[k] && has(v)) identifiers[k] = v;
  }
  merged.identifiers = identifiers;

  merged.similarity = topSim;
  merged.source = merged.source || { id: 'merged', description: 'Merged result' };
  merged._provider = 'merged';
  merged._providerPriority = Math.max(...group.map((i) => i._providerPriority || 0)) + 1;
  merged._mergedFrom = group.map((i) => ({ provider: i._provider, id: i.id || null }));
  merged._mergedFieldSources = sources;

  const result = toAbsMatch(merged);

  // Not worth showing when the top result already says the same.
  const top = results[0];
  const sameTitleAuthors = top.title === result.title && (top.authors || []).join('|') === (result.authors || []).join('|');
  const topHasAll = ['narrator', 'description', 'cover', 'languages', 'identifiers', 'genres', 'tags', 'series', 'isbn', 'duration']
    .every((f) => !has(result[f]) || has(top[f]));
  return sameTitleAuthors && topHasAll ? null : result;
}

module.exports = { norm, isAudio, has, authorsOf, scoreMatch, toAbsMatch, sortResults, mergeBestResults, ISBN_DIGITS, yearOf };
