const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const { createHttp } = require("../lib/http");

const text = (s) => (s || "").replace(/\s+/g, " ").trim();

/** Every JSON-LD node on the page (`@graph` flattened); scripts that do not parse are skipped. */
function jsonLdNodes($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).text());
      for (const node of Array.isArray(data) ? data : [data]) {
        if (!node || typeof node !== "object") continue;
        nodes.push(node);
        if (Array.isArray(node["@graph"])) nodes.push(...node["@graph"]);
      }
    } catch (err) {
      // not JSON: ignore
    }
  });
  return nodes;
}

class LubimyCzytacProvider {
  constructor(options = {}) {
    this.id = "lubimyczytac";
    this.name = "Lubimy Czytać";
    this.baseUrl = "https://lubimyczytac.pl";
    this.opts = options || {};
    this.language = this.opts.language || "pl";
    this.concurrency = this.opts.concurrency || 3;
    this.timeoutMs = this.opts.timeoutMs || 10000;
    this.http = this.opts.http || createHttp({ timeoutMs: this.timeoutMs, headers: { "Accept-Language": "pl-PL,pl;q=0.9" } });
    this.cache = new NodeCache({ stdTTL: 600 });
  }

  /**
   * The query as a title to search for. Audiobookshelf may send a folder or file name
   * ("Autor - Seria Tom 2 - Tytuł (2019) [64kbps] czyta Jan Kowalski"); a plain title must come out unchanged.
   * A query in double quotes is taken literally.
   */
  static cleanTitle(query) {
    const q = (query || "").toString();
    if (/^".*"$/.test(q)) return q.slice(1, -1);
    return q
      .replace(/\d+\s*kbps/gi, "")
      .replace(/\bVBR\b.*$/gi, "")
      .replace(/superprodukcja/gi, "")
      .replace(/\s+czyt(?:a|ają|\.)\s+\p{Lu}.*$/u, "") // "... czyta Jan Kowalski"
      .replace(/^.*\s-\s+(?=\S)/, "") // "Autor - Tytuł": what follows the last spaced dash
      .replace(/^.*?\b(?:T|Tom)[\s.]?\d{1,3}\b[\s.,:-]*(?=\S)/i, "") // "Seria Tom 2 Tytuł"
      .replace(/[\s.,:-]*\bTom[\s.]?\d{1,3}\s*$/i, "") // "Tytuł. Tom 2"
      .replace(/^.*?\(\d{1,3}\)\s*(?=\S)/, "") // "Seria (2) Tytuł"
      .replace(/\(.*?\)/g, "")
      .replace(/\[.*?\]/g, "")
      .replace(/[^\p{L}\d]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** The author to filter by: the one given, else the part before " - " in an "Autor - Tytuł" query. */
  static cleanAuthor(query, author) {
    let a = (author || "").toString();
    if (!a && /\s-\s/.test(query || "")) a = query.split(/\s-\s/)[0];
    return a.split(/\s-\s/)[0].replace(/\./g, " ").replace(/\s+/g, " ").trim();
  }

  async searchBooks(query, author = "") {
    const cacheKey = `${query}-${author}`;
    const cachedResult = this.cache.get(cacheKey);
    if (cachedResult) return cachedResult;

    const cleanedAuthor = LubimyCzytacProvider.cleanAuthor(query, author);
    // A query that is nothing but markers ("Tom 1") is searched as given.
    const cleanedTitle = LubimyCzytacProvider.cleanTitle(query) || (query || "").toString().trim();

    let params = `phrase=${encodeURIComponent(cleanedTitle)}`;
    if (cleanedAuthor) params += `&author=${encodeURIComponent(cleanedAuthor)}`;

    const [books, audiobooks] = await Promise.all([
      this.http.get(`${this.baseUrl}/szukaj/ksiazki?${params}`, { responseType: "text" }),
      this.http.get(`${this.baseUrl}/szukaj/audiobooki?${params}`, { responseType: "text" }),
    ]);

    // Snippets only: the backbone scores them and fetches detail pages (getFullMetadata) for the few
    // candidates above its threshold.
    const matches = [
      ...this.parseSearchResults(books.data, "book"),
      ...this.parseSearchResults(audiobooks.data, "audiobook"),
    ].slice(0, 40);

    const result = { matches };
    this.cache.set(cacheKey, result);
    return result;
  }

  parseSearchResults(responseData, type) {
    const $ = cheerio.load(Buffer.isBuffer(responseData) ? responseData.toString("utf8") : String(responseData));
    const matches = [];

    $(".book-card--l").each((index, element) => {
      const $book = $(element);

      // Skip promoted offers
      if ($book.closest(".promoted-offers__list, .promoted-offers").length > 0) return;

      const title = text($book.find(".book-card__title").first().text());
      const bookUrl = $book.find(".book-card__title").first().attr("href");
      const authors = $book
        .find(".book-card__author a")
        .map((i, el) => text($(el).text()))
        .get()
        .filter(Boolean);

      if (!title || !bookUrl) return;
      const url = bookUrl.startsWith("http") ? bookUrl : `${this.baseUrl}${bookUrl}`;
      const idFromUrl = url.match(/\/(?:ksiazka|audiobook|ebook)\/(\d+)/);

      matches.push({
        id: $book.attr("data-book-id") || (idFromUrl ? idFromUrl[1] : null),
        title: this.decodeUnicode(title),
        authors: authors.map((a) => this.decodeUnicode(a)),
        url,
        type,
        source: { id: this.id, description: this.name, link: this.baseUrl },
      });
    });

    return matches;
  }

  async getFullMetadata(match) {
    try {
      // Only pages of the site itself: the address comes from a scraped search result.
      const host = new URL(match.url).hostname;
      if (host !== "lubimyczytac.pl" && !host.endsWith(".lubimyczytac.pl")) return match;
      const response = await this.http.get(match.url, { responseType: "text" });
      return this.parseDetail(response.data, match);
    } catch (error) {
      console.error(`LubimyCzytać: detail page failed for "${match.title}": ${error.message}`);
      return match;
    }
  }

  parseDetail(html, match) {
    const $ = cheerio.load(Buffer.isBuffer(html) ? html.toString("utf8") : String(html));
    const ld = jsonLdNodes($);
    const book = ld.find((n) => /Book/i.test([].concat(n["@type"] || []).join(" "))) || {};
    // The details list: <dt>Label:</dt><dd>value</dd>
    const dd = (label) => {
      const dt = $("dt").filter((i, el) => text($(el).text()).startsWith(label)).first();
      return dt.length ? dt.next("dd") : $();
    };

    // An audiobook's record has no image: its page's preview picture is the cover. The site's stand-in
    // for a missing cover is no cover.
    const coverFound =
      $("a#js-lightboxCover").attr("href") ||
      $(".book-cover__link").attr("href") ||
      (typeof book.image === "string" ? book.image : "") ||
      $('meta[property="og:image"]').attr("content") ||
      "";
    const cover = coverFound.includes("default-book") ? "" : coverFound.replace(/^http:\/\//, "https://");

    const publisher =
      text($('span.book__txt:contains("Wydawnictwo:")').find("a").first().text()) ||
      $("[data-ga-book-publishers]").attr("data-ga-book-publishers") ||
      (book.publisher && (book.publisher.name || (typeof book.publisher === "string" ? book.publisher : ""))) ||
      "";

    const languages = text(dd("Język").text())
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => this.getLanguageName(l));

    const description = $("#book-description").html() || "";

    const cycle =
      text($('span.d-none.d-sm-block.mt-1:contains("Cykl:")').find("a").first().text()) ||
      text(dd("Cykl").find("a").first().text() || dd("Cykl").text());
    let series = this.extractSeriesName(cycle);
    let seriesIndex = this.extractSeriesIndex(cycle);
    // The page's record names the series too. A "/cykl/" is the author's cycle; a "/seria/" is only the
    // publisher's imprint and is not a series.
    const part = [].concat(book.isPartOfSeries || []).find((s) => s && typeof s.url === "string" && s.url.includes("/cykl/"));
    if (!series && part && typeof part.name === "string" && part.name.trim()) {
      series = text(part.name);
      const position = String(part.position ?? "").replace(",", ".");
      if (position) seriesIndex = /^\d+$/.test(position) ? parseInt(position, 10) : position;
    }

    const ratingValue = parseFloat(
      ($('meta[property="books:rating:value"]').attr("content") || text($(".rating-value .big-number").first().text())).replace(",", "."),
    );
    const rating = Number.isFinite(ratingValue) ? ratingValue / 2 : null; // the site rates out of 10

    const isbn =
      $('meta[property="books:isbn"]').attr("content") ||
      text(dd("ISBN").text()) ||
      (typeof book.isbn === "string" ? book.isbn : "") ||
      "";

    const publishedDate = this.extractPublishedDate($, dd, book);
    const original = text(dd("Tytuł oryginału").text());
    const pages = this.extractPages($, ld);
    const translator = text(dd("Tłumacz").find("a").map((i, el) => text($(el).text())).get().join(", ")) || null;
    const narrator = text(dd("Lektor").text()) || text(dd("Czyta").text());

    const fullMetadata = {
      ...match,
      cover,
      description: this.enrichDescription(description, pages, publishedDate, translator),
      narrator: narrator || undefined,
      languages,
      publisher: publisher || undefined,
      publishedDate: publishedDate || undefined,
      rating,
      series,
      seriesIndex,
      genres: this.extractGenres($, dd),
      tags: this.extractTags($),
      identifiers: {
        isbn,
        lubimyczytac: match.id,
      },
    };

    const subtitle = book.alternativeHeadline || book.subtitle;
    if (typeof subtitle === "string" && subtitle.trim()) fullMetadata.subtitle = subtitle.trim();
    // What a translation is called in its own language.
    if (original && original !== match.title) fullMetadata.originalTitle = original;

    return fullMetadata;
  }

  extractSeriesName(seriesElement) {
    if (!seriesElement) return null;
    return seriesElement.replace(/\s*\(tom [^)]*\)\s*$/i, "").trim() || null;
  }

  /** Volume number as the site shows it: 1, or "2.5" / "1-2" as a string. */
  extractSeriesIndex(seriesElement) {
    if (!seriesElement) return null;
    const found = seriesElement.match(/\(tom ([\d.,-]+)\)/i);
    if (!found) return null;
    const value = found[1].replace(",", ".");
    return /^\d+$/.test(value) ? parseInt(value, 10) : value;
  }

  /**
   * As `YYYY-MM-DD` (or whatever the site shows): the first Polish edition, then the first edition anywhere,
   * then this edition's date.
   */
  extractPublishedDate($, dd, book = {}) {
    const titled = (title) => text($("dt").filter((i, el) => ($(el).attr("title") || "").trim() === title).first().next("dd").text());
    const values = [
      titled("Data pierwszego wydania polskiego") || text(dd("Data 1. wyd. pol.").text()),
      text($('dt[title*="Data pierwszego wydania"]').first().next("dd").text()) || text(dd("Data 1. wydania").text()),
      text(dd("Data wydania").text()),
      typeof book.datePublished === "string" ? book.datePublished : "",
    ];
    for (const value of values) {
      const iso = value.match(/\d{4}(?:-\d{2}(?:-\d{2})?)?/);
      if (iso) return iso[0];
    }
    return null;
  }

  extractPages($, ld) {
    for (const node of ld) {
      const pages = parseInt(node.numberOfPages, 10);
      if (pages > 0) return pages;
    }
    const found = text(dd$($, "Liczba stron")).match(/\d+/);
    return found ? parseInt(found[0], 10) : null;
  }

  extractGenres($, dd) {
    const genreText = text($(".book__category.d-sm-block.d-none").first().text()) || text(dd("Kategoria").text());
    return genreText ? genreText.split(",").map((genre) => genre.trim()).filter(Boolean) : [];
  }

  extractTags($) {
    return [...new Set($('a[href*="/ksiazki/t/"]').map((i, el) => text($(el).text())).get().filter(Boolean))];
  }

  stripHtmlTags(html) {
    // Paragraph and line breaks become line breaks, the remaining tags go.
    let out = html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    // Fix missing spaces after periods followed by capital letters
    out = out.replace(/\.([A-ZĄĆĘŁŃÓŚŹŻ])/g, ". $1");
    return out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  enrichDescription(description, pages, publishedDate, translator) {
    let enrichedDescription = this.stripHtmlTags(description);

    if (!enrichedDescription || enrichedDescription === "Ta książka nie posiada jeszcze opisu.") {
      return "Brak opisu.";
    }
    if (pages) enrichedDescription += `\n\nKsiążka ma ${pages} stron.`;
    if (publishedDate) enrichedDescription += `\n\nData pierwszego wydania: ${publishedDate}`;
    if (translator) enrichedDescription += `\n\nTłumacz: ${translator}`;
    return enrichedDescription;
  }

  getLanguageName(language) {
    const languageMap = {
      polski: "pol",
      angielski: "eng",
    };
    return languageMap[language.toLowerCase()] || language;
  }

  decodeUnicode(str) {
    return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

/** Text of the <dd> after the <dt> starting with `label`. */
function dd$($, label) {
  const dt = $("dt").filter((i, el) => text($(el).text()).startsWith(label)).first();
  return dt.length ? dt.next("dd").text() : "";
}

module.exports = LubimyCzytacProvider;
// supported languages for admin UI (ISO codes)
module.exports.supportedLanguages = ["pl"];
