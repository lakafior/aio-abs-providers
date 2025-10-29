const axios = require('axios');
const cheerio = require('cheerio');
const stringSimilarity = require('string-similarity');
const NodeCache = require('node-cache');

class LubimyCzytacProvider {
  constructor() {
    this.id = 'lubimyczytac';
    this.name = 'Lubimy Czytać';
    this.baseUrl = 'https://lubimyczytac.pl';
    this.textDecoder = new TextDecoder('utf-8');
    this.cache = new NodeCache({ stdTTL: 600 });
  }

  decodeText(text) {
    return this.textDecoder.decode(new TextEncoder().encode(text));
  }

  async searchBooks(query, author = '') {
    const cacheKey = `${query}-${author}`;
    const cachedResult = this.cache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }

    try {
      if (!author && query.includes("-")) {
        author = query.split("-")[0].replace(/\./g, " ").trim();
      } else {
        author = author.split("-")[0].replace(/\./g, " ").trim();
      }

      let cleanedTitle = query;
      if (!/^".*"$/.test(cleanedTitle)) {
        cleanedTitle = cleanedTitle.replace(/(\d+kbps)/g, '')
          .replace(/\bVBR\b.*$/gi, '')
          .replace(/^[\w\s.-]+-\s*/g, '')
          .replace(/czyt.*/gi, '')
          .replace(/.*-/, '')
          .replace(/.*?(T[\s.]?\d{1,3}).*?(.*)$/i, '$2')
          .replace(/.*?(Tom[\s.]?\d{1,3}).*?(.*)$/i, '$2')
          .replace(/.*?\(\d{1,3}\)\s*/g, '')
          .replace(/\(.*?\)/g, '')
          .replace(/\[.*?\]/g, '')
          .replace(/\(/g, ' ')
          .replace(/[^\p{L}\d]/gu, ' ')
          .replace(/\./g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/superprodukcja/i, '')
          .trim();
      } else {
        cleanedTitle = cleanedTitle.replace(/^"(.*)"$/, '$1');
      }

      let booksSearchUrl = `${this.baseUrl}/szukaj/ksiazki?phrase=${encodeURIComponent(cleanedTitle)}`;
      let audiobooksSearchUrl = `${this.baseUrl}/szukaj/audiobooki?phrase=${encodeURIComponent(cleanedTitle)}`;
      if (author) {
        booksSearchUrl += `&author=${encodeURIComponent(author)}`;
        audiobooksSearchUrl += `&author=${encodeURIComponent(author)}`;
      }

      const booksResponse = await axios.get(booksSearchUrl, { responseType: 'arraybuffer' });
      const audiobooksResponse = await axios.get(audiobooksSearchUrl, { responseType: 'arraybuffer' });

      const booksMatches = this.parseSearchResults(booksResponse.data, 'book');
      const audiobooksMatches = this.parseSearchResults(audiobooksResponse.data, 'audiobook');

      let allMatches = [...booksMatches, ...audiobooksMatches];

      allMatches = allMatches.map(match => {
        const titleSimilarity = stringSimilarity.compareTwoStrings(match.title.toLowerCase(), cleanedTitle.toLowerCase());

        let combinedSimilarity;
        if (author) {
          const authorSimilarity = Math.max(...match.authors.map(a =>
            stringSimilarity.compareTwoStrings(a.toLowerCase(), author.toLowerCase())
          ));
          combinedSimilarity = (titleSimilarity * 0.6) + (authorSimilarity * 0.4);
        } else {
          combinedSimilarity = titleSimilarity;
        }

        return { ...match, similarity: combinedSimilarity };
      }).sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        const typeValueA = a.type === 'audiobook' ? 1 : 0;
        const typeValueB = b.type === 'audiobook' ? 1 : 0;
        return typeValueB - typeValueA;
      }).slice(0, 20);

      const fullMetadata = await Promise.all(allMatches.map(match => this.getFullMetadata(match)));

      const adjustedMetadata = fullMetadata.map(match => {
        let adjustedSimilarity = match.similarity;
        if (!match.identifiers?.isbn || match.identifiers.isbn === '') {
          adjustedSimilarity *= 0.99;
        }
        return { ...match, similarity: adjustedSimilarity };
      }).sort((a, b) => {
        if (b.similarity !== a.similarity) return b.similarity - a.similarity;
        const typeValueA = a.type === 'audiobook' ? 1 : 0;
        const typeValueB = b.type === 'audiobook' ? 1 : 0;
        return typeValueB - typeValueA;
      });

      const result = { matches: adjustedMetadata };
      this.cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Error searching books:', error.message, error.stack);
      return { matches: [] };
    }
  }

  parseSearchResults(responseData, type) {
    const decodedData = this.decodeText(responseData);
    const $ = cheerio.load(decodedData);
    const matches = [];

    $('.authorAllBooks__single').each((index, element) => {
      const $book = $(element);
      const $bookInfo = $book.find('.authorAllBooks__singleText');

      const title = $bookInfo.find('.authorAllBooks__singleTextTitle').text().trim();
      const bookUrl = $bookInfo.find('.authorAllBooks__singleTextTitle').attr('href');
      const authors = $bookInfo.find('a[href*="/autor/"]').map((i, el) => $(el).text().trim()).get();

      if (title && bookUrl) {
        matches.push({
          id: bookUrl.split('/').pop(),
          title: this.decodeUnicode(title),
          authors: authors.map(author => this.decodeUnicode(author)),
          url: `${this.baseUrl}${bookUrl}`,
          type: type,
          source: {
            id: this.id,
            description: this.name,
            link: this.baseUrl,
          },
        });
      }
    });

    return matches;
  }

  async getFullMetadata(match) {
    try {
      const response = await axios.get(match.url, { responseType: 'arraybuffer' });
      const decodedData = this.decodeText(response.data);
      const $ = cheerio.load(decodedData);

      const cover = $('.book-cover a').attr('data-cover') ||
              $('.book-cover source').attr('srcset') ||
              $('.book-cover img').attr('src') ||
              $('meta[property="og:image"]').attr('content') || '';
      const publisher = $('dt:contains("Wydawnictwo:")').next('dd').find('a').text().trim() || '';
      const languages = $('dt:contains("Język:")').next('dd').text().trim().split(', ') || [];
      const description = $('.collapse-content').html() || $('meta[property="og:description"]').attr('content') || '';
      const seriesElement = $('span.d-none.d-sm-block.mt-1:contains("Cykl:")').find('a').text().trim();
      const series = this.extractSeriesName(seriesElement);
      const seriesIndex = this.extractSeriesIndex(seriesElement);
      const genres = this.extractGenres($);
      const tags = this.extractTags($);
      const rating = parseFloat($('meta[property="books:rating:value"]').attr('content')) / 2 || null;
      const isbn = $('meta[property="books:isbn"]').attr('content') || '';

      let publishedDate, pages;
      try {
        publishedDate = this.extractPublishedDate($);
        pages = this.extractPages($);
      } catch (error) {
        console.error('Error extracting published date or pages:', error.message);
      }

      const translator = this.extractTranslator($);

      const fullMetadata = {
        ...match,
        cover,
        description: this.enrichDescription(description, pages, publishedDate, translator),
        languages: languages.map(lang => this.getLanguageName(lang)),
        publisher,
        publishedDate,
        rating,
        series,
        seriesIndex,
        genres,
        tags,
        identifiers: {
          isbn,
          lubimyczytac: match.id,
        },
      };

      return fullMetadata;
    } catch (error) {
      console.error(`Error fetching full metadata for ${match.title}:`, error.message, error.stack);
      return match;
    }
  }

  extractSeriesName(seriesElement) {
    if (!seriesElement) return null;
    return seriesElement.replace(/\s*\(tom \d+.*?\)\s*$/, '').trim();
  }

  extractSeriesIndex(seriesElement) {
    if (!seriesElement) return null;
    const match = seriesElement.match(/\(tom (\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  extractPublishedDate($) {
    const dateText = $('dt[title*="Data pierwszego wydania"]').next('dd').text().trim();
    return dateText ? new Date(dateText) : null;
  }

  extractPages($) {
    try {
      const pagesText = $('script[type="application/ld+json"]').text();
      if (pagesText) {
        const data = JSON.parse(pagesText);
        return data.numberOfPages || null;
      }
    } catch (error) {
      console.error('Error parsing JSON for pages:', error.message);
    }
    return null;
  }

  extractTranslator($) {
    return $('dt:contains("Tłumacz:")').next('dd').find('a').text().trim() || null;
  }

  extractGenres($) {
    const genreText = $('.book__category.d-sm-block.d-none').text().trim();
    return genreText ? genreText.split(',').map(genre => genre.trim()) : [];
  }

  extractTags($) {
    return $('a[href*="/ksiazki/t/"]').map((i, el) => $(el).text().trim()).get() || [];
  }

  stripHtmlTags(html) {
    return html.replace(/<[^>]*>/g, '');
  }

  enrichDescription(description, pages, publishedDate, translator) {
    let enrichedDescription = this.stripHtmlTags(description);

    if (enrichedDescription === "Ta książka nie posiada jeszcze opisu.") {
      enrichedDescription = "Brak opisu.";
    } else {
      if (pages) {
        enrichedDescription += `\n\nKsiążka ma ${pages} stron.`;
      }

      if (publishedDate) {
        enrichedDescription += `\n\nData pierwszego wydania: ${publishedDate.toLocaleDateString()}`;
      }

      if (translator) {
        enrichedDescription += `\n\nTłumacz: ${translator}`;
      }
    }

    return enrichedDescription;
  }

  getLanguageName(language) {
    const languageMap = {
      polski: 'pol',
      angielski: 'eng',
    };
    return languageMap[language.toLowerCase()] || language;
  }

  decodeUnicode(str) {
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  }
}

module.exports = LubimyCzytacProvider;
