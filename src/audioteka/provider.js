const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { createHttp } = require('../lib/http');

const { validIsbn } = require('../lib/isbn');

const text = (s) => (s || '').replace(/\s+/g, ' ').trim();
const unique = (list) => [...new Set(list.filter(Boolean))];

function cleanCoverUrl(url) {
  return url ? url.split('?')[0] : url;
}

/** "6 godzin 28 minut", "45 minut", "12 hodin 3 minuty", "8 Stunden 42 Minuten" -> minutes. */
function parseDuration(durationStr) {
  const s = text(durationStr);
  if (!s) return undefined;
  const found = s.match(/^(?:(\d+)\s+[^\d\s]+)?\s*(?:(\d+)\s+[^\d\s]+)$/);
  if (!found) return undefined;
  // One number alone is hours when the unit says so ("6 godzin", "6 hodin", "6 Stunden"), minutes otherwise.
  if (!found[1] && /\d+\s+(?:godz|hod|stund)/i.test(s)) return parseInt(found[2], 10) * 60;
  return (parseInt(found[1] || '0', 10) * 60) + parseInt(found[2] || '0', 10);
}

/** ISO 8601 duration from JSON-LD ("PT6H28M") -> minutes. */
function parseIsoDuration(value) {
  const found = typeof value === 'string' && value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!found) return undefined;
  const minutes = (parseInt(found[1] || '0', 10) * 1440) + (parseInt(found[2] || '0', 10) * 60) + parseInt(found[3] || '0', 10);
  return minutes || undefined;
}

// Labels of the details list (<dt>) per store.
const LABELS = {
  pl: { narrator: ['Głosy', 'Czyta'], duration: ['Długość'], publisher: ['Wydawca'], type: ['Typ'], genres: ['Kategoria'], language: ['Język'] },
  cz: { narrator: ['Interpret', 'Čte', 'Hlasy'], duration: ['Délka', 'Stopáž'], publisher: ['Vydavatel', 'Nakladatel'], type: ['Typ'], genres: ['Kategorie', 'Žánr'], language: ['Jazyk'] },
  de: { narrator: ['Sprecher'], duration: ['Dauer'], publisher: ['Verlag'], type: ['Typ'], genres: ['Kategorie'], language: ['Sprache'] },
};

// One site per store: its search page, the language asked for and the name its books' language gets.
const STORES = {
  pl: { search: 'https://audioteka.com/pl/szukaj/', accept: 'pl-PL,pl;q=0.9', language: 'polish' },
  cz: { search: 'https://audioteka.com/cz/vyhledavani/', accept: 'cs-CZ,cs;q=0.9', language: 'czech' },
  de: { search: 'https://audioteka.com/de/search/', accept: 'de-DE,de;q=0.9', language: 'german' },
};

class AudiotekaProvider {
  constructor(options = {}) {
    this.id = 'audioteka';
    this.name = 'Audioteka';
    this.baseUrl = 'https://audioteka.com';
    this.opts = options || {};
    this.language = this.opts.language || process.env.LANGUAGE || 'pl';
    // An unknown store is the Polish one, as before.
    this.store = STORES[this.language] ? this.language : 'pl';
    // Respect explicit boolean in options.extra.addLinkToDescription. If undefined, fall back to env/default.
    if (this.opts.extra && typeof this.opts.extra.addLinkToDescription !== 'undefined') {
      this.addAudiotekaLinkToDescription = !!this.opts.extra.addLinkToDescription;
    } else {
      this.addAudiotekaLinkToDescription = ((process.env.ADD_AUDIOTEKA_LINK_TO_DESCRIPTION || 'true').toLowerCase() === 'true');
    }
    this.timeoutMs = this.opts.timeoutMs || 10000;
    this.http = this.opts.http || createHttp({
      timeoutMs: this.timeoutMs,
      headers: { 'Accept-Language': STORES[this.store].accept },
    });
    this.searchUrl = STORES[this.store].search;
    this.cache = new NodeCache({ stdTTL: 600 });
  }

  async searchBooks(query) {
    const cacheKey = `${this.language}|${query}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const response = await this.http.get(`${this.searchUrl}?phrase=${encodeURIComponent(query)}`, { responseType: 'text' });
    // Lightweight snippets. Backbone will call getFullMetadata for selected candidates.
    const result = { matches: this.parseSearchResults(response.data) };
    this.cache.set(cacheKey, result);
    return result;
  }

  parseSearchResults(html) {
    const $ = cheerio.load(String(html));
    const matches = [];
    const seen = new Set();

    // CSS-module class names carry a build hash (teaser_title__hDeCG): match their stable prefix.
    $('[class*="teaser_teaser__"]').each((index, element) => {
      const $book = $(element);

      const title = text($book.find('[class*="teaser_title__"]').first().text());
      const href = $book.find('[class*="teaser_link__"]').first().attr('href') || $book.find('a[href*="/audiobook/"]').first().attr('href');
      // Products only: the results also list cycles (/pl/cykl/, /cz/serie/), which have no detail page to read.
      if (!title || !href || !/\/(audiobook|audiokniha)\//.test(href)) return;
      const bookUrl = href.startsWith('http') ? href : this.baseUrl + href;
      if (seen.has(bookUrl)) return;
      seen.add(bookUrl);

      const authors = text($book.find('[class*="teaser_author__"]').first().text()).split(/\s*,\s*/).filter(Boolean);

      // try common lazy-load attributes and fallbacks for cover
      const teaserEl = $book.find('[class*="teaser_coverImage__"], img').first();
      let coverSrc = teaserEl.attr('src') || teaserEl.attr('data-src') || teaserEl.attr('data-srcset') || teaserEl.attr('srcset');
      if (coverSrc && coverSrc.includes(',')) coverSrc = coverSrc.split(',')[0].trim().split(' ')[0];
      // Lazily loaded teasers keep the image in <noscript>, which is plain text to the parser.
      if (!coverSrc || !/^https?:/.test(coverSrc)) {
        const lazy = ($book.find('noscript').first().text() || '').match(/src="([^"]+)"/);
        if (lazy) coverSrc = lazy[1].replace(/&amp;/g, '&');
      }
      const cover = coverSrc && /^https?:/.test(coverSrc) ? cleanCoverUrl(coverSrc) : null;
      const rating = parseFloat(text($book.find('[class*="teaser-footer_rating__"]').first().text()).replace(',', '.')) || null;

      // The address ends in the product's slug: /pl/audiobook/krew-elfow-tom-1/
      const id = $book.attr('data-item-id') || bookUrl.split('/').filter(Boolean).pop();

      matches.push({
        id,
        title,
        authors,
        url: bookUrl,
        cover,
        rating,
        type: 'audiobook', // explicit: Audioteka provides audiobooks
        source: { id: this.id, description: this.name, link: this.baseUrl },
      });
    });

    return matches;
  }

  async getFullMetadata(match) {
    try {
      const host = new URL(match.url).hostname;
      if (host !== 'audioteka.com' && !host.endsWith('.audioteka.com')) return match;
      const response = await this.http.get(match.url, { responseType: 'text' });
      return this.parseDetail(response.data, match);
    } catch (error) {
      console.error(`Audioteka: detail page failed for "${match.title}": ${error.message}`);
      return match;
    }
  }

  /** `null` drops the product (a Czech-store listing that is not in Czech). */
  parseDetail(html, match) {
    const $ = cheerio.load(String(html));
    const labels = LABELS[this.store];

    // The page describes the product twice: as JSON-LD (schema.org Audiobook) and as a details list
    // (<dt>Głosy</dt><dd>...</dd>). JSON-LD first, the list fills what it lacks.
    let product = {};
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const data = JSON.parse($(el).text());
        for (const node of Array.isArray(data) ? data : [data]) {
          const types = [].concat((node && node['@type']) || []);
          if (types.includes('Audiobook') || types.includes('Product') || types.includes('Book')) product = node;
        }
      } catch (err) {
        // not JSON: ignore
      }
    });
    const names = (v) => unique([].concat(v || []).map((n) => text(typeof n === 'string' ? n : n && n.name)));

    const dd = (wanted) => $('dt').filter((i, el) => wanted.includes(text($(el).text()))).first().next('dd');
    const ddList = (wanted) => {
      const cell = dd(wanted);
      const links = unique(cell.find('a').map((i, el) => text($(el).text())).get());
      return links.length ? links : (text(cell.text()) ? [text(cell.text())] : []);
    };

    const bookLanguage = text(dd(labels.language).text());
    if (this.language === 'cz' && bookLanguage && !/češtin|česky/i.test(bookLanguage)) return null;

    let narrators = ddList(labels.narrator);
    if (!narrators.length) narrators = names(product.readBy);
    let publisher = ddList(labels.publisher).join(', ');
    if (!publisher) publisher = names(product.brand).join(', ') || names(product.publisher).join(', ');
    let genres = ddList(labels.genres);
    if (!genres.length) genres = names(product.genre);
    // School reading lists ("Lektury szkoła średnia") are shop shelves, not genres.
    genres = genres.filter((g) => !/^Lektury\b/i.test(g));
    const duration = parseDuration(dd(labels.duration).text()) || parseIsoDuration(product.duration);
    const productType = text(dd(labels.type).text());

    // "Collections this product is in": real cycles ("Wiedźmin") and shop shelves ("Bestsellery", "Lektury
    // szkoła średnia") look the same on the page, so they are tags, not a series.
    const tags = unique($('[class*="collections_list__"] a').map((i, el) => text($(el).text())).get());

    const ratingValue = Number(product.aggregateRating && product.aggregateRating.ratingValue);
    const rating = Number.isFinite(ratingValue) && ratingValue > 0 ? ratingValue : (match.rating || null);

    const descriptionHtml = $('[class*="description_description__"], #audiobook-description, .product-description, .book-description').first().html();
    const sanitizedDescription = descriptionHtml
      ? descriptionHtml
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
          .trim()
      : '';
    let description = sanitizedDescription;
    if (this.addAudiotekaLinkToDescription) {
      description = `<a href="${match.url}">Audioteka link</a><br><br>${sanitizedDescription}`;
    }

    const cover = cleanCoverUrl(typeof product.image === 'string' ? product.image : [].concat(product.image || [])[0]) || match.cover || null;

    const fullMetadata = {
      ...match,
      cover,
      narrator: narrators.join(', '),
      type: match.type || 'audiobook',
      duration,
      publisher,
      description,
      // The page's "Typ" (e.g. "Audiobook", "Słuchowisko"); `type` stays "audiobook" for filtering.
      productType: productType || undefined,
      genres,
      series: [],
      tags,
      rating,
      languages: [STORES[this.store].language],
      identifiers: {
        audioteka: match.id,
      },
    };

    // Some stores list the ISBN (the German one does).
    const isbn = validIsbn(text(dd(['ISBN']).text())) || validIsbn(product.isbn);
    if (isbn) fullMetadata.identifiers.isbn = isbn;

    const subtitle = product.alternativeHeadline || product.subtitle;
    if (typeof subtitle === 'string' && subtitle.trim()) fullMetadata.subtitle = subtitle.trim();

    return fullMetadata;
  }
}

module.exports = AudiotekaProvider;
module.exports.parseDuration = parseDuration;
module.exports.parseIsoDuration = parseIsoDuration;
// supported languages for admin UI
module.exports.supportedLanguages = Object.keys(STORES);
