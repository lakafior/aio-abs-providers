const axios = require('axios');
const cheerio = require('cheerio');

function cleanCoverUrl(url) {
  if (url) {
    return url.split('?')[0];
  }
  return url;
}

function parseDuration(durationStr) {
  if (!durationStr) return undefined;

  let hours = 0;
  let minutes = 0;

  const durationRegex = /^(?:(\d+)\s+[^\d\s]+)?\s*(?:(\d+)\s+[^\d\s]+)$/;
  const matches = durationStr.match(durationRegex);

  if (matches) {
    if (matches[1]) {
      hours = parseInt(matches[1], 10);
    }
    if (matches[2]) {
      minutes = parseInt(matches[2], 10);
    }
  } else {
    if (durationStr.trim()) {
      console.warn(`Could not parse duration string using provided regex: "${durationStr}"`);
    }
    return undefined;
  }

  if (isNaN(hours)) hours = 0;
  if (isNaN(minutes)) minutes = 0;

  return (hours * 60) + minutes;
}

const DEFAULT_METADATA_CONCURRENCY = 5;

class AudiotekaProvider {
  constructor(options = {}) {
    this.id = 'audioteka';
    this.name = 'Audioteka';
    this.baseUrl = 'https://audioteka.com';
    this.opts = options || {};
    this.language = this.opts.language || process.env.LANGUAGE || 'pl';
    this.addAudiotekaLinkToDescription = (this.opts.extra && this.opts.extra.addLinkToDescription) || ((process.env.ADD_AUDIOTEKA_LINK_TO_DESCRIPTION || 'true').toLowerCase() === 'true');
    this.metadataConcurrency = (this.opts.concurrency && Number.isFinite(this.opts.concurrency)) ? this.opts.concurrency : (() => {
      const v = parseInt(process.env.METADATA_CONCURRENCY, 10);
      return Number.isFinite(v) && v > 0 ? v : DEFAULT_METADATA_CONCURRENCY;
    })();
    this.searchUrl = this.language === 'cz' ? 'https://audioteka.com/cz/vyhledavani' : 'https://audioteka.com/pl/szukaj';
  }

  async searchBooks(query, author = '', requestId = 'req') {
    try {
      console.log(`[${requestId}] Searching for: "${query}" by "${author}"`);
      const searchUrl = `${this.searchUrl}?phrase=${encodeURIComponent(query)}`;

      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Language': this.language === 'cz' ? 'cs-CZ' : 'pl-PL'
        }
      });
      const $ = cheerio.load(response.data);

      const matches = [];
      const $books = $('.adtk-item.teaser_teaser__FDajW');

      $books.each((index, element) => {
        const $book = $(element);

        const title = $book.find('.teaser_title__hDeCG').text().trim();
        const bookUrl = this.baseUrl + $book.find('.teaser_link__fxVFQ').attr('href');
        const authors = [$book.find('.teaser_author__LWTRi').text().trim()];
        const cover = cleanCoverUrl($book.find('.teaser_coverImage__YMrBt').attr('src'));
        const rating = parseFloat($book.find('.teaser-footer_rating__TeVOA').text().trim()) || null;

        const id = $book.attr('data-item-id') || bookUrl.split('/').pop();

        if (title && bookUrl && authors.length > 0) {
          matches.push({
            id,
            title,
            authors,
            url: bookUrl,
            cover,
            rating,
            source: {
              id: this.id,
              description: this.name,
              link: this.baseUrl,
            },
          });
        }
      });

  const fullMetadata = await this.mapWithConcurrency(matches, match => this.getFullMetadata(match, requestId), this.metadataConcurrency);
      const filteredMetadata = fullMetadata.filter(book => book !== null);

      return { matches: filteredMetadata };
    } catch (error) {
      console.error(`[${requestId}] Error searching books:`, error.message, error.stack);
      return { matches: [] };
    }
  }

  async mapWithConcurrency(items, iteratorFn, limit = 5) {
    const results = new Array(items.length);
    let i = 0;
    const workers = Array(Math.min(limit, items.length)).fill().map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        try {
          results[idx] = await iteratorFn(items[idx]);
        } catch (err) {
          console.error('Error in mapWithConcurrency item:', err && err.message || err);
          results[idx] = null;
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async getFullMetadata(match) {
    try {
      let requestId = 'req';
      if (arguments.length >= 2 && arguments[1]) requestId = arguments[1];
      console.log(`[${requestId}] Fetching full metadata for: ${match.title}`);
      const response = await axios.get(match.url);
      const $ = cheerio.load(response.data);

      let narrators = '';
  if (this.language === 'cz') {
        let narratorCell = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Interpret' || text === 'Čte';
        }).find('td:last-child');

        const narratorLinks = narratorCell.find('a');
        if (narratorLinks.length > 0) {
          narrators = narratorLinks.map((i, el) => $(el).text().trim()).get().join(', ');
        } else {
          narrators = narratorCell.text().trim();
        }

        if (!narrators) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Interpret' || text === 'Čte') {
              const ddElement = $(el).next('dd');
              const ddLinks = ddElement.find('a');
              if (ddLinks.length > 0) {
                narrators = ddLinks.map((i, el) => $(el).text().trim()).get().join(', ');
              } else {
                narrators = ddElement.text().trim();
              }
            }
          });
        }

        if (!narrators) {
          const narratorDiv = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Interpret' || 
                   $(this).find('.label').text().trim() === 'Čte';
          }).find('.value');

          const divLinks = narratorDiv.find('a');
          if (divLinks.length > 0) {
            narrators = divLinks.map((i, el) => $(el).text().trim()).get().join(', ');
          } else {
            narrators = narratorDiv.text().trim();
          }
        }

        if (narrators && !narrators.includes(',') && narrators.match(/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/)) {
          narrators = narrators.replace(/([a-záčďéěíňóřšťúůýž])([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])/g, '$1, $2');
        }
      } else {
        let narratorCell = $('dt').filter(function() {
          return $(this).text().trim() === 'Głosy';
        }).next('dd');

        const narratorLinks = narratorCell.find('a');
        if (narratorLinks.length > 0) {
          narrators = narratorLinks.map((i, el) => $(el).text().trim()).get().join(', ');
        } else {
          narrators = narratorCell.text().trim();
        }

        if (!narrators) {
          narrators = $('.product-table tr:contains("Głosy") td:last-child a')
            .map((i, el) => $(el).text().trim())
            .get()
            .join(', ') || $('.product-table tr:contains("Głosy") td:last-child').text().trim();
        }

        if (narrators && !narrators.includes(',') && narrators.match(/[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+[A-ZĄĆĘŁŃÓŚŹŻ]/)) {
          narrators = narrators.replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1, $2');
        }
      }

      let durationStr = '';
      if (language === 'cz') {
        durationStr = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Délka' || text === 'Stopáž';
        }).find('td:last-child').text().trim();

        if (!durationStr) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Délka' || text === 'Stopáž') {
              durationStr = $(el).next('dd').text().trim();
            }
          });
        }

        if (!durationStr) {
          durationStr = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Délka' || 
                   $(this).find('.label').text().trim() === 'Stopáž';
          }).find('.value').text().trim();
        }
      } else {
        durationStr = $('.product-table tr:contains("Długość") td:last-child').text().trim();
      }

      const durationInMinutes = parseDuration(durationStr);

      let publisher = '';
      if (language === 'cz') {
        publisher = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Vydavatel' || text === 'Nakladatel';
        }).find('td:last-child').text().trim();

        if (!publisher) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Vydavatel' || text === 'Nakladatel') {
              publisher = $(el).next('dd').text().trim();
            }
          });
        }

        if (!publisher) {
          publisher = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Vydavatel' || 
                   $(this).find('.label').text().trim() === 'Nakladatel';
          }).find('.value').text().trim();
        }
      } else {
        publisher = $('.product-table tr:contains("Wydawca") td:last-child a').text().trim() ||
                    $('.product-table tr:contains("Wydawca") td:last-child').text().trim();
      }

      let type = '';
      if (language === 'cz') {
        type = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Typ';
        }).find('td:last-child').text().trim();

        if (!type) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Typ') {
              type = $(el).next('dd').text().trim();
            }
          });
        }

        if (!type) {
          type = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Typ';
          }).find('.value').text().trim();
        }
      } else {
        type = $('.product-table tr:contains("Typ") td:last-child').text().trim();
      }

      let genres = [];
      if (language === 'cz') {
        genres = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Kategorie' || text === 'Žánr';
        }).find('td:last-child a')
          .map((i, el) => $(el).text().trim())
          .get();

        if (genres.length === 0) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Kategorie' || text === 'Žánr') {
              genres = $(el).next('dd').find('a')
                .map((i, el) => $(el).text().trim())
                .get();
            }
          });
        }

        if (genres.length === 0) {
          genres = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Kategorie' || 
                   $(this).find('.label').text().trim() === 'Žánr';
          }).find('.value a')
            .map((i, el) => $(el).text().trim())
            .get();
        }
      } else {
        genres = $('.product-table tr:contains("Kategoria") td:last-child a')
          .map((i, el) => $(el).text().trim())
          .get();
      }

      const bookLanguage = language === 'cz' ? (() => {
        let lang = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Jazyk';
        }).find('td:last-child').text().trim();

        if (!lang) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Jazyk') {
              lang = $(el).next('dd').text().trim();
            }
          });
        }

        if (!lang) {
          lang = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Jazyk';
          }).find('.value').text().trim();
        }

        return lang;
      })() : null;

      if (language === 'cz' && bookLanguage && !bookLanguage.toLowerCase().includes('čeština')) {
        return null;
      }

      const series = $('.collections_list__09q3I li a, .product-series a, .series-info a, .product-table tr:contains("Seria") td:last-child a')
        .map((i, el) => $(el).text().trim())
        .get();

      const rating = parseFloat($('.StarIcon__Label-sc-6cf2a375-2, .rating-value, .product-rating .value, .rating .value').text().trim()) || 
                     parseFloat($('[class*="rating"]').text().trim()) || null;

      const descriptionHtml = $('.description_description__6gcfq, .product-description, .book-description, .product-desc').html();

      const sanitizedDescription = descriptionHtml
        ? descriptionHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        : '';

      let description = sanitizedDescription;
      if (this.addAudiotekaLinkToDescription) {
        const audioTekaLink = `<a href="${match.url}">Audioteka link</a>`;
        description = `${audioTekaLink}<br><br>${sanitizedDescription}`;
      }

      const cover = cleanCoverUrl($('.product-top_cover__Pth8B, .product-cover img, .book-cover img, .product-image img').attr('src') || match.cover);

      const languages = this.language === 'cz' 
        ? ['czech'] 
        : ['polish'];

      const fullMetadata = {
        ...match,
        cover,
        narrator: narrators,
        duration: durationInMinutes,
        publisher,
        description,
        type,
        genres,
        series: [],
        tags: series,
        rating,
        languages, 
        identifiers: {
          audioteka: match.id,
        },
      };

      return fullMetadata;
    } catch (error) {
      let requestId = 'req';
      if (arguments.length >= 2 && arguments[1]) requestId = arguments[1];
      console.error(`[${requestId}] Error fetching full metadata for ${match.title}:`, error.message, error.stack);
      return match;
    }
  }
}

module.exports = AudiotekaProvider;
// supported languages for admin UI
module.exports.supportedLanguages = ['pl', 'cz'];
