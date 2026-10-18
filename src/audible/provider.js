const axios = require('axios');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 600 });

// Audible stores by region code (config `language` or `extra.region`).
const DOMAINS = {
  us: 'com',
  uk: 'co.uk',
  de: 'de',
  fr: 'fr',
  it: 'it',
  es: 'es',
  ca: 'ca',
  au: 'com.au',
  in: 'in',
  jp: 'co.jp',
};

/**
 * Audible's public catalog API (the one Audiobookshelf's built-in Audible provider uses): no key, JSON.
 * Search answers everything the snippet needs, so getFullMetadata only reshapes it (no detail requests).
 */
class AudibleProvider {
  constructor(options = {}) {
    this.id = 'audible';
    this.name = 'Audible';
    this.opts = options || {};
    const region = ((this.opts.extra && this.opts.extra.region) || this.opts.language || 'us').toLowerCase();
    this.region = DOMAINS[region] ? region : 'us';
    this.domain = DOMAINS[this.region];
    this.timeoutMs = this.opts.timeoutMs || 10000;
    this.maxResults = 10;
  }

  async searchBooks(query, author = '') {
    const cacheKey = `${this.region}|${query}|${author}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    try {
      const params = {
        num_results: String(this.maxResults),
        products_sort_by: 'Relevance',
        response_groups: 'contributors,media,product_desc,product_attrs,series',
      };
      // Title and author apart when the caller gives the author, else free keywords.
      if (author) {
        params.title = query;
        params.author = author;
      } else {
        params.keywords = query;
      }
      const response = await axios.get(`https://api.audible.${this.domain}/1.0/catalog/products`, {
        params,
        timeout: this.timeoutMs,
        headers: { Accept: 'application/json' },
      });
      const products = (response.data && response.data.products) || [];
      const matches = products.map(p => this.format(p)).filter(Boolean);
      const result = { matches };
      cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Audible search failed:', error && error.message ? error.message : error);
      return { matches: [] };
    }
  }

  format(product) {
    if (!product || !product.title) return null;
    // Translators are listed as authors ("Name - translator").
    const authors = (product.authors || [])
      .map(a => a && a.name)
      .filter(name => name && !/\s-\stranslator$/i.test(name));
    const narrators = (product.narrators || []).map(n => n && n.name).filter(Boolean);
    const images = product.product_images || {};
    const coverKey = Object.keys(images).sort((a, b) => Number(b) - Number(a))[0];
    const series = (product.series || [])
      .filter(s => s && s.title)
      .map(s => ({ series: s.title, sequence: s.sequence ? String(s.sequence) : undefined }));
    const description = (product.merchandising_summary || product.publisher_summary || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    return {
      id: product.asin,
      title: product.title.replace(/\s*\((Un)?abridged\)\s*$/i, ''),
      subtitle: product.subtitle || undefined,
      authors,
      narrator: narrators.join(', ') || undefined,
      publisher: product.publisher_name || undefined,
      publishedYear: product.release_date ? product.release_date.slice(0, 4) : undefined,
      publishedDate: product.release_date || undefined,
      description: description || undefined,
      cover: coverKey ? images[coverKey] : undefined,
      asin: product.asin,
      series: series.length ? series : undefined,
      language: product.language || undefined,
      duration: product.runtime_length_min || undefined,
      url: `https://www.audible.${this.domain}/pd/${product.asin}`,
      type: 'audiobook',
      identifiers: { asin: product.asin },
      source: { id: this.id, description: this.name, link: `https://www.audible.${this.domain}` },
      _fullFetched: true,
    };
  }

  async getFullMetadata(snippet) {
    return snippet;
  }
}

module.exports = AudibleProvider;
// Regions for the admin UI (Audible stores).
module.exports.supportedLanguages = Object.keys(DOMAINS);
