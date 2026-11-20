// What Audiobookshelf keeps from a custom provider's match: the mapping of its
// server/providers/CustomProviderAdapter.js (v2.38.0, GPL-3.0), minus the HTML sanitizer.
// A field that is missing here after mapping is a field Audiobookshelf throws away.

const toStringOrUndefined = (value) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) return value.join(',');
  return undefined;
};

const validateSeriesArray = (series) => {
  if (!Array.isArray(series) || !series.length) return undefined;
  return series
    .map((s) => {
      if (!s?.series || typeof s.series !== 'string') return undefined;
      const _series = { series: s.series };
      if (s.sequence && (typeof s.sequence === 'string' || typeof s.sequence === 'number')) _series.sequence = String(s.sequence);
      return _series;
    })
    .filter((s) => s !== undefined);
};

const validateTagsGenresArray = (tagsGenres) => {
  if (!tagsGenres || (typeof tagsGenres !== 'string' && !Array.isArray(tagsGenres))) return undefined;
  if (typeof tagsGenres === 'string') tagsGenres = tagsGenres.split(',');
  else if (!tagsGenres.every((t) => typeof t === 'string')) return undefined;
  tagsGenres = tagsGenres.map((t) => t.trim()).filter(Boolean);
  if (!tagsGenres.length) return undefined;
  return [...new Set(tagsGenres)];
};

/** `null` when Audiobookshelf would reject the whole response. */
function absMap(responseBody) {
  if (!responseBody || !Array.isArray(responseBody.matches)) return null;
  return responseBody.matches.map((match) => {
    const { title, subtitle, author, narrator, publisher, publishedYear, description, cover, isbn, asin, genres, tags, series, language, duration } = match;
    const payload = {
      title: toStringOrUndefined(title),
      subtitle: toStringOrUndefined(subtitle),
      author: toStringOrUndefined(author),
      narrator: toStringOrUndefined(narrator),
      publisher: toStringOrUndefined(publisher),
      publishedYear: toStringOrUndefined(publishedYear),
      description: description && typeof description === 'string' ? description : undefined,
      cover: toStringOrUndefined(cover),
      isbn: toStringOrUndefined(isbn),
      asin: toStringOrUndefined(asin),
      genres: validateTagsGenresArray(genres),
      tags: validateTagsGenresArray(tags),
      series: validateSeriesArray(series),
      language: toStringOrUndefined(language),
      duration: !isNaN(duration) && duration !== null ? Number(duration) : undefined,
    };
    for (const key in payload) if (payload[key] === undefined) delete payload[key];
    return payload;
  });
}

module.exports = { absMap };
