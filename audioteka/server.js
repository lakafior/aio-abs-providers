const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

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

  // Use the regex provided by the user, REMOVED 'g' and 'm' flags
  const durationRegex = /^(?:(\d+)\s+[^\d\s]+)?\s*(?:(\d+)\s+[^\d\s]+)$/; 
  // No need to reset lastIndex without the 'g' flag
  const matches = durationStr.match(durationRegex);

  // Check if the regex matched successfully
  // Without 'g', matches will be null if no match, or an array like:
  // [fullMatch, captureGroup1, captureGroup2, ...]
  if (matches) { 
    // matches[1] is the hours capture group (optional)
    // matches[2] is the minutes capture group (mandatory part of the pattern)
    
    if (matches[1]) { // Check if hours group was captured
      hours = parseInt(matches[1], 10);
    }
    // matches[2] should exist if matches is not null, based on the regex structure
    if (matches[2]) { 
      minutes = parseInt(matches[2], 10);
    }
  } else {
      // Log if the regex failed to match
      if (durationStr.trim()) {
        console.warn(`Could not parse duration string using provided regex: "${durationStr}"`);
      }
      // Consider if a fallback or different handling is needed for strings
      // that don't match (e.g., only hours "1 hodina")
      return undefined; // Return undefined if parsing fails
  }

  // Ensure we have valid numbers, default to 0 if parseInt resulted in NaN
  if (isNaN(hours)) hours = 0;
  if (isNaN(minutes)) minutes = 0;

  // Return total duration in minutes
  const durationInMinutes = (hours * 60) + minutes;
  // Keep the log to confirm output
  console.log(`Parsed duration in minutes for "${durationStr}": ${durationInMinutes}`);
  return durationInMinutes;
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// Middleware to check for AUTHORIZATION header
app.use((req, res, next) => {
  const apiKey = req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // part to validate API
  next();
});

const language = process.env.LANGUAGE || 'pl';  // Default to Polish if not specified
const addAudiotekaLinkToDescription = (process.env.ADD_AUDIOTEKA_LINK_TO_DESCRIPTION || 'true').toLowerCase() === 'true';
// Metadata fetch concurrency (configurable via env var). Default to 5 when not provided or invalid.
const DEFAULT_METADATA_CONCURRENCY = 5;
const metadataConcurrency = (() => {
  const v = parseInt(process.env.METADATA_CONCURRENCY, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_METADATA_CONCURRENCY;
})();

class AudiotekaProvider {
  constructor() {
    this.id = 'audioteka';
    this.name = 'Audioteka';
    this.baseUrl = 'https://audioteka.com';
    this.searchUrl = language === 'cz' ? 'https://audioteka.com/cz/vyhledavani' : 'https://audioteka.com/pl/szukaj';
  }

  async searchBooks(query, author = '', requestId = 'req') {
    try {
      console.log(`[${requestId}] Searching for: "${query}" by "${author}"`);
      const searchUrl = `${this.searchUrl}?phrase=${encodeURIComponent(query)}`;
      
      const response = await axios.get(searchUrl, {
        headers:
         {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Language': language === 'cz' ? 'cs-CZ' : 'pl-PL'
        }
      });
      const $ = cheerio.load(response.data);

  console.log(`[${requestId}] Search URL:`, searchUrl);

      const matches = [];
      const $books = $('.adtk-item.teaser_teaser__FDajW');
  console.log(`[${requestId}] Number of books found:`, $books.length);

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

  // Fetch full metadata with limited concurrency to avoid overloading the site
  const fullMetadata = await this.mapWithConcurrency(matches, match => this.getFullMetadata(match, requestId), metadataConcurrency);
      
      // Filter out null results (non-Czech books for Czech users)
      const filteredMetadata = fullMetadata.filter(book => book !== null);
      
  console.log(`[${requestId}] Filtered ${fullMetadata.length - filteredMetadata.length} non-Czech books`);
      
      return { matches: filteredMetadata };
    } catch (error) {
      console.error(`[${requestId}] Error searching books:`, error.message, error.stack);
      return { matches: [] };
    }
  }
  // Helper to map over items with limited concurrency
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
          // keep error isolated per-item
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
      // backward compatible when requestId is not passed
      let requestId = 'req';
      // if caller passed a requestId as second arg, it will be available in arguments
      if (arguments.length >= 2 && arguments[1]) requestId = arguments[1];
      console.log(`[${requestId}] Fetching full metadata for: ${match.title}`);
      const response = await axios.get(match.url);
      const $ = cheerio.load(response.data);

      // Debug: Log all table rows to see the actual structure
  console.log(`[${requestId}] === DEBUG: All table rows ===`);
      $('table tr').each((i, el) => {
        const firstCell = $(el).find('td:first-child').text().trim();
        const lastCell = $(el).find('td:last-child').text().trim();
        console.log(`Row ${i}: "${firstCell}" -> "${lastCell}"`);
      });

      // Debug: Try different div structures for Czech site
  console.log(`[${requestId}] === DEBUG: Trying different selectors ===`);
  console.log(`[${requestId}] All tables count:`, $('table').length);
  console.log(`[${requestId}] All tr count:`, $('tr').length);
  console.log(`[${requestId}] All td count:`, $('td').length);
      
      // Debug: Look for different structures
      console.log(`[${requestId}] === DEBUG: Looking for dt/dd structure ===`);
      $('dt, dd').each((i, el) => {
        console.log(`[${requestId}] dt/dd ${i}: "${$(el).text().trim()}"`);
      });      // Get narrator - improved selectors for Czech site
      let narrators = '';
      if (language === 'cz') {
        // Try multiple selector approaches for Czech site
        let narratorCell = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Interpret' || text === 'Čte';
        }).find('td:last-child');
        
        // Check if there are individual links for narrators
        const narratorLinks = narratorCell.find('a');
        if (narratorLinks.length > 0) {
          narrators = narratorLinks.map((i, el) => $(el).text().trim()).get().join(', ');
        } else {
          narrators = narratorCell.text().trim();
        }
        
        // Fallback: try dt/dd structure
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
        
        // Fallback: try div structure
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
        
        // If we still have concatenated names without separators, try to add commas
        if (narrators && !narrators.includes(',') && narrators.match(/[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/)) {
          // Split on capital letters that follow lowercase letters (indicating new names)
          narrators = narrators.replace(/([a-záčďéěíňóřšťúůýž])([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])/g, '$1, $2');
        }
        
        console.log(`[${requestId}] Narrator extracted: "${narrators}"`);
      } else {
        // Polish site narrator extraction
        let narratorCell = $('dt').filter(function() {
          return $(this).text().trim() === 'Głosy';
        }).next('dd');
        
        // Check if there are individual links for narrators
        const narratorLinks = narratorCell.find('a');
        if (narratorLinks.length > 0) {
          narrators = narratorLinks.map((i, el) => $(el).text().trim()).get().join(', ');
        } else {
          narrators = narratorCell.text().trim();
        }
        
        // Fallback: try table structure
        if (!narrators) {
          narrators = $('.product-table tr:contains("Głosy") td:last-child a')
            .map((i, el) => $(el).text().trim())
            .get()
            .join(', ') || $('.product-table tr:contains("Głosy") td:last-child').text().trim();
        }
        
        // If we still have concatenated names without separators, try to add commas
        if (narrators && !narrators.includes(',') && narrators.match(/[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+[A-ZĄĆĘŁŃÓŚŹŻ]/)) {
          // Split on capital letters that follow lowercase letters (indicating new names)
          narrators = narrators.replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1, $2');
        }
        
        console.log(`[${requestId}] Narrator extracted: "${narrators}"`);
      }

      // Get duration - improved selectors for Czech site
      let durationStr = '';
      if (language === 'cz') {
        // Try multiple selector approaches for Czech site
        durationStr = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Délka' || text === 'Stopáž';
        }).find('td:last-child').text().trim();
        
        // Fallback: try dt/dd structure
        if (!durationStr) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Délka' || text === 'Stopáž') {
              durationStr = $(el).next('dd').text().trim();
            }
          });
        }
        
        // Fallback: try div structure
        if (!durationStr) {
          durationStr = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Délka' || 
                   $(this).find('.label').text().trim() === 'Stopáž';
          }).find('.value').text().trim();
        }
        
        console.log(`[${requestId}] Duration extracted: "${durationStr}"`);
      } else {
        durationStr = $('.product-table tr:contains("Długość") td:last-child').text().trim();
      }

      const durationInMinutes = parseDuration(durationStr);

      // Get publisher - improved selectors for Czech site
      let publisher = '';
      if (language === 'cz') {
        // Try multiple selector approaches for Czech site
        publisher = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Vydavatel' || text === 'Nakladatel';
        }).find('td:last-child').text().trim();
        
        // Fallback: try dt/dd structure
        if (!publisher) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Vydavatel' || text === 'Nakladatel') {
              publisher = $(el).next('dd').text().trim();
            }
          });
        }
        
        // Fallback: try div structure
        if (!publisher) {
          publisher = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Vydavatel' || 
                   $(this).find('.label').text().trim() === 'Nakladatel';
          }).find('.value').text().trim();
        }
        
        console.log(`Publisher extracted: "${publisher}"`);
      } else {
        publisher = $('.product-table tr:contains("Wydawca") td:last-child a').text().trim() ||
                    $('.product-table tr:contains("Wydawca") td:last-child').text().trim();
      }

      // Get type - improved selectors for Czech site
      let type = '';
      if (language === 'cz') {
        // Try multiple selector approaches for Czech site
        type = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Typ';
        }).find('td:last-child').text().trim();
        
        // Fallback: try dt/dd structure
        if (!type) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Typ') {
              type = $(el).next('dd').text().trim();
            }
          });
        }
        
        // Fallback: try div structure
        if (!type) {
          type = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Typ';
          }).find('.value').text().trim();
        }
        
        console.log(`Type extracted: "${type}"`);
      } else {
        type = $('.product-table tr:contains("Typ") td:last-child').text().trim();
      }

      // Get categories/genres - improved selectors for Czech site
      let genres = [];
      if (language === 'cz') {
        // Try multiple selector approaches for Czech site
        genres = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Kategorie' || text === 'Žánr';
        }).find('td:last-child a')
          .map((i, el) => $(el).text().trim())
          .get();
        
        // Fallback: try dt/dd structure
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
        
        // Fallback: try div structure
        if (genres.length === 0) {
          genres = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Kategorie' || 
                   $(this).find('.label').text().trim() === 'Žánr';
          }).find('.value a')
            .map((i, el) => $(el).text().trim())
            .get();
        }
        
        console.log(`Genres extracted: ${JSON.stringify(genres)}`);
      } else {
        genres = $('.product-table tr:contains("Kategoria") td:last-child a')
          .map((i, el) => $(el).text().trim())
          .get();
      }

      // Get language - improved selectors for Czech site
      const bookLanguage = language === 'cz' ? (() => {
        // Try multiple selector approaches for Czech site
        let lang = $('table tr').filter(function() {
          const text = $(this).find('td:first-child').text().trim();
          return text === 'Jazyk';
        }).find('td:last-child').text().trim();
        
        // Fallback: try dt/dd structure
        if (!lang) {
          $('dt').each((i, el) => {
            const text = $(el).text().trim();
            if (text === 'Jazyk') {
              lang = $(el).next('dd').text().trim();
            }
          });
        }
        
        // Fallback: try div structure
        if (!lang) {
          lang = $('.product-detail-item').filter(function() {
            return $(this).find('.label').text().trim() === 'Jazyk';
          }).find('.value').text().trim();
        }
        
        return lang;
      })() : null;

  console.log(`[${requestId}] Book language found: "${bookLanguage}"`);

      // Filter out non-Czech books for Czech users
      if (language === 'cz' && bookLanguage && !bookLanguage.toLowerCase().includes('čeština')) {
        console.log(`[${requestId}] Filtering out ${match.title} - language is "${bookLanguage}", not Czech`);
        return null;
      }

      // Get series information - updated selectors
      const series = $('.collections_list__09q3I li a, .product-series a, .series-info a, .product-table tr:contains("Seria") td:last-child a')
        .map((i, el) => $(el).text().trim())
        .get();

      // Get rating - try multiple selectors for rating
      const rating = parseFloat($('.StarIcon__Label-sc-6cf2a375-2, .rating-value, .product-rating .value, .rating .value').text().trim()) || 
                     parseFloat($('[class*="rating"]').text().trim()) || null;
      
      // Get description with HTML - updated selectors for both sites
      const descriptionHtml = $('.description_description__6gcfq, .product-description, .book-description, .product-desc').html();
      
      // Basic sanitization
      const sanitizedDescription = descriptionHtml
        ? descriptionHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
        : '';

      let description = sanitizedDescription;
      if (addAudiotekaLinkToDescription) {
        const audioTekaLink = `<a href="${match.url}">Audioteka link</a>`;
        description = `${audioTekaLink}<br><br>${sanitizedDescription}`;
        console.log(`Audioteka link will be added to the description for ${match.title}`);
      }

      // Get main cover image - updated selectors for both sites
      const cover = cleanCoverUrl($('.product-top_cover__Pth8B, .product-cover img, .book-cover img, .product-image img').attr('src') || match.cover);

      const languages = language === 'cz' 
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

        console.log(`[${requestId}] Full metadata for ${match.title}:`, JSON.stringify(fullMetadata, null, 2));
      return fullMetadata;
    } catch (error) {
      // try to capture request-scoped info if available
      let requestId = 'req';
      if (arguments.length >= 2 && arguments[1]) requestId = arguments[1];
      console.error(`[${requestId}] Error fetching full metadata for ${match.title}:`, error.message, error.stack);
      return match;
    }
  }
}

const provider = new AudiotekaProvider();

app.get('/search', async (req, res) => {
  try {
    console.log('Received search request:', req.query);
    const query = req.query.query;
    const author = req.query.author;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }

    const results = await provider.searchBooks(query, author);
    
    // Format the response according to the OpenAPI specification
    const formattedResults = {
      matches: results.matches.map(book => ({
        title: book.title,
        subtitle: book.subtitle || undefined,
        author: book.authors.join(', '),
        narrator: book.narrator || undefined,
        publisher: book.publisher || undefined,
        publishedYear: book.publishedDate ? new Date(book.publishedDate).getFullYear().toString() : undefined,
        description: book.description || undefined,
        cover: book.cover || undefined,
        isbn: book.identifiers?.isbn || undefined,
        asin: book.identifiers?.asin || undefined,
        genres: book.genres || undefined,
        tags: book.tags || undefined,
        series: book.series ? book.series.map(seriesName => ({
          series: seriesName,
          sequence: undefined // Audioteka doesn't provide sequence numbers
        })) : undefined,
        language: book.languages && book.languages.length > 0 ? book.languages[0] : undefined,
        duration: book.duration // This will now be the value in minutes from getFullMetadata
      }))
    };

    console.log('Sending response:', JSON.stringify(formattedResults, null, 2));
    res.json(formattedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Audioteka provider listening on port ${port}, language: ${language}, add link to description: ${addAudiotekaLinkToDescription}`);
  console.log(`Metadata fetch concurrency: ${metadataConcurrency}`);
});
