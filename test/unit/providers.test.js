const test = require('node:test');
const assert = require('node:assert/strict');

const { fixture, jsonFixture, fakeHttp } = require('../helpers/fixtures');
const LubimyCzytac = require('../../src/lubimyczytac/provider');
const Audioteka = require('../../src/audioteka/provider');
const Storytel = require('../../src/storytel/provider');
const Audible = require('../../src/audible/provider');
const meta = require('../../src/contract/providers.meta.json');
const { validIsbn } = require('../../src/lib/isbn');
const { toAbsMatch } = require('../../src/backbone/pipeline');

test('lubimyczytac: a plain title is searched as it is', () => {
  const clean = LubimyCzytac.cleanTitle;
  assert.equal(clean('Fahrenheit 451'), 'Fahrenheit 451');
  assert.equal(clean('Spider-Man'), 'Spider Man');
  assert.equal(clean('Poczytaj mi mamo'), 'Poczytaj mi mamo');
  assert.equal(clean('Apartament 16'), 'Apartament 16');
  assert.equal(clean('Ostatnie życzenie'), 'Ostatnie życzenie');
  assert.equal(clean('Rok 1984'), 'Rok 1984');
  assert.equal(clean('"Tom 1 - dosłownie"'), 'Tom 1 - dosłownie');
});

test('lubimyczytac: folder and file names are reduced to the title', () => {
  const clean = LubimyCzytac.cleanTitle;
  assert.equal(clean('Andrzej Sapkowski - Wiedźmin Tom 1 - Ostatnie życzenie'), 'Ostatnie życzenie');
  assert.equal(clean('Wiedźmin Tom 2 Miecz przeznaczenia (2014) [64kbps]'), 'Miecz przeznaczenia');
  assert.equal(clean('Krew elfów. Tom 1'), 'Krew elfów');
  assert.equal(clean('Zrost czyta Filip Kosior'), 'Zrost');
  assert.equal(clean('Lód superprodukcja'), 'Lód');
});

test('lubimyczytac: author from the parameter or from "Autor - Tytuł"', () => {
  const author = LubimyCzytac.cleanAuthor;
  assert.equal(author('Zrost', 'Robert Małecki'), 'Robert Małecki');
  assert.equal(author('Mdłości', 'Jean-Paul Sartre'), 'Jean-Paul Sartre');
  assert.equal(author('Spider-Man', ''), '');
  assert.equal(author('Andrzej Sapkowski - Ostatnie życzenie', ''), 'Andrzej Sapkowski');
  assert.equal(author('Solaris', 'S. Lem'), 'S Lem');
});

test('lubimyczytac: search asks for books and audiobooks and returns snippets', async () => {
  const http = fakeHttp([
    ['/szukaj/ksiazki', fixture('lubimyczytac-search-books.html')],
    ['/szukaj/audiobooki', fixture('lubimyczytac-search-audiobooks.html')],
  ]);
  const provider = new LubimyCzytac({ http });
  const { matches } = await provider.searchBooks('Ostatnie życzenie', 'Andrzej Sapkowski');

  assert.equal(http.calls.length, 2);
  assert.match(http.calls[0].url, /phrase=Ostatnie%20%C5%BCyczenie&author=Andrzej%20Sapkowski/);
  assert.equal(matches.length, 8);
  const [first] = matches;
  assert.deepEqual(
    { id: first.id, title: first.title, authors: first.authors, url: first.url, type: first.type },
    { id: '240310', title: 'Ostatnie życzenie', authors: ['Andrzej Sapkowski'], url: 'https://lubimyczytac.pl/ksiazka/240310/ostatnie-zyczenie', type: 'book' },
  );
  assert.ok(matches.some((m) => m.type === 'audiobook'));

  // The second identical search is answered from the cache.
  await provider.searchBooks('Ostatnie życzenie', 'Andrzej Sapkowski');
  assert.equal(http.calls.length, 2);
});

test('lubimyczytac: a failed search is an error, not "no results"', async () => {
  const provider = new LubimyCzytac({ http: fakeHttp([['/szukaj/', new Error('HTTP 429')]]) });
  await assert.rejects(() => provider.searchBooks('Solaris'), /429/);
});

test('lubimyczytac: detail page', async () => {
  const http = fakeHttp([['/audiobook/5046281/', fixture('lubimyczytac-detail-audiobook.html')]]);
  const provider = new LubimyCzytac({ http });
  const snippet = { id: '5046281', title: 'Wiedźmin. Ostatnie życzenie', authors: ['Andrzej Sapkowski'], url: 'https://lubimyczytac.pl/audiobook/5046281/wiedzmin-ostatnie-zyczenie', type: 'audiobook' };
  const full = await provider.getFullMetadata(snippet);

  assert.equal(full.cover, 'https://s.lubimyczytac.pl/upload/books/5046000/5046281/1030411-352x500.jpg');
  assert.equal(full.publisher, 'superNOWA');
  assert.equal(full.series, 'Wiedźmin Geralt z Rivii');
  assert.equal(full.seriesIndex, 1);
  assert.deepEqual(full.genres, ['fantasy', 'science fiction']);
  assert.deepEqual(full.languages, ['pol']);
  assert.equal(full.publishedDate, '2020-01-01');
  assert.equal(full.identifiers.isbn, '9788375781908');
  assert.equal(full.identifiers.lubimyczytac, '5046281');
  assert.equal(full.rating, 4.2);
  assert.ok(full.tags.includes('wiedźmin'));
  assert.match(full.description, /^Tom 1\. kultowych opowiadań/);
  assert.match(full.description, /Data pierwszego wydania: 2020-01-01$/);
  assert.doesNotMatch(full.description, /</);
});

test('lubimyczytac: series volume forms', () => {
  const provider = new LubimyCzytac({ http: fakeHttp([]) });
  assert.equal(provider.extractSeriesName('Wiedźmin Geralt z Rivii (tom 1)'), 'Wiedźmin Geralt z Rivii');
  assert.equal(provider.extractSeriesIndex('Wiedźmin Geralt z Rivii (tom 1)'), 1);
  assert.equal(provider.extractSeriesIndex('Cykl (tom 2,5)'), '2.5');
  assert.equal(provider.extractSeriesIndex('Cykl (tom 1-3)'), '1-3');
  assert.equal(provider.extractSeriesIndex('Cykl'), null);
  assert.equal(provider.extractSeriesName('Cykl'), 'Cykl');
});

test('lubimyczytac: only its own pages are fetched, and a failed page keeps the snippet', async () => {
  const http = fakeHttp([]);
  const provider = new LubimyCzytac({ http });
  const foreign = { title: 'x', url: 'https://example.com/ksiazka/1/x' };
  assert.equal(await provider.getFullMetadata(foreign), foreign);
  assert.equal(http.calls.length, 0);
  const own = { title: 'x', url: 'https://lubimyczytac.pl/ksiazka/1/x' };
  assert.equal(await provider.getFullMetadata(own), own); // no fixture -> request fails
});

test('audioteka: search snippets', async () => {
  const http = fakeHttp([['/pl/szukaj/', fixture('audioteka-search.html')]]);
  const { matches } = await new Audioteka({ http, language: 'pl' }).searchBooks('Ostatnie życzenie');
  assert.equal(matches.length, 4);
  const [first] = matches;
  assert.equal(first.title, 'Ostatnie życzenie Anny Teresy');
  assert.deepEqual(first.authors, ['Jerzy Edigey']);
  assert.equal(first.url, 'https://audioteka.com/pl/audiobook/ostatnie-zyczenie-anny-teresy/');
  assert.equal(first.id, 'ostatnie-zyczenie-anny-teresy');
  assert.equal(first.type, 'audiobook');
  assert.equal(first.rating, 4.4);
  assert.equal(first.cover, 'https://atkcdn.audioteka.com/cc/ce/ostatnie-zyczenie-anny-teresy/16.jpg');
});

test('audioteka: detail page', async () => {
  const http = fakeHttp([['/pl/audiobook/krew-elfow-tom-1/', fixture('audioteka-detail.html')]]);
  const provider = new Audioteka({ http, language: 'pl', extra: { addLinkToDescription: false } });
  const snippet = { id: 'krew-elfow-tom-1', title: 'Krew elfów. Tom 1', authors: ['Andrzej Sapkowski'], url: 'https://audioteka.com/pl/audiobook/krew-elfow-tom-1/', type: 'audiobook', cover: null };
  const full = await provider.getFullMetadata(snippet);

  assert.equal(full.narrator, 'zespół lektorów'); // listed twice on the page (mobile and desktop)
  assert.equal(full.duration, 388);
  assert.equal(full.publisher, 'SuperNOWA');
  assert.deepEqual(full.genres, ['Fantasy', 'Fantastyka']);
  assert.deepEqual(full.series, []); // collections are not reliably series
  assert.deepEqual(full.tags, ['Wiedźmin']);
  assert.equal(full.productType, 'Słuchowisko');
  assert.equal(full.rating, 4.9);
  assert.equal(full.cover, 'https://atkcdn.audioteka.com/cc/c8/krew-elfow-tom-1/947.jpg');
  assert.deepEqual(full.languages, ['polish']);
  assert.equal(full.identifiers.audioteka, 'krew-elfow-tom-1');
  assert.match(full.description, /^<p>/);
  assert.doesNotMatch(full.description, /Audioteka link/);

  const linked = await new Audioteka({ http, language: 'pl', extra: { addLinkToDescription: true } }).getFullMetadata(snippet);
  assert.match(linked.description, /^<a href="https:\/\/audioteka\.com\/pl\/audiobook\/krew-elfow-tom-1\/">Audioteka link<\/a>/);
});

test('audioteka: durations', () => {
  assert.equal(Audioteka.parseDuration('6 godzin 28 minut'), 388);
  assert.equal(Audioteka.parseDuration('45 minut'), 45);
  assert.equal(Audioteka.parseDuration('6 godzin'), 360);
  assert.equal(Audioteka.parseDuration(''), undefined);
  assert.equal(Audioteka.parseIsoDuration('PT6H28M'), 388);
  assert.equal(Audioteka.parseIsoDuration('PT45M'), 45);
  assert.equal(Audioteka.parseIsoDuration('bogus'), undefined);
});

test('storytel: one snippet per edition, formatted without another request', async () => {
  const http = fakeHttp([['search.action', jsonFixture('storytel-search.json')]]);
  const provider = new Storytel({ http, language: 'pl' });
  const { matches } = await provider.searchBooks('Ostatnie życzenie unit', '', 'pl');

  assert.deepEqual(http.calls[0].params, { request_locale: 'pl', q: 'Ostatnie życzenie unit' });
  const [audio, ebook] = matches;
  assert.equal(audio.type, 'audiobook');
  assert.equal(ebook.type, 'book');
  assert.equal(audio.title, 'Ostatnie życzenie');
  assert.deepEqual(audio.authors, ['Andrzej Sapkowski']);

  const full = await provider.getFullMetadata(audio);
  assert.equal(http.calls.length, 1);
  assert.equal(full.title, 'Ostatnie życzenie');
  assert.equal(full.author, 'Andrzej Sapkowski');
  assert.equal(full.narrator, 'Zespół lektorów');
  assert.equal(full.duration, 152);
  assert.equal(full.publisher, 'superNOWA');
  assert.equal(full.publishedYear, '2017');
  assert.equal(full.language, 'pl');
  assert.deepEqual(full.series, [{ series: 'Wiedźmin. Opowiadania', sequence: '6' }]);
  assert.equal(full.cover, 'https://storytel.com/images/640x640/0000064043.jpg');
  assert.equal(full.type, 'audiobook');

  const book = await provider.getFullMetadata(ebook);
  assert.equal(book.type, 'book');
  assert.equal(book.duration, undefined);
  assert.equal(book.narrator, undefined);
});

test('storytel: a hyphen inside a word stays in the title', () => {
  const provider = new Storytel({ http: fakeHttp([]) });
  const item = (name) => ({ book: { name, authorsAsString: 'A', series: [] }, abook: { length: 60000 } });
  assert.equal(provider.formatBookMetadata(item('Spider-Man'), 'audiobook').title, 'Spider-Man');
  const split = provider.formatBookMetadata(item('Diuna: Mesjasz Diuny'), 'audiobook');
  assert.deepEqual([split.title, split.subtitle], ['Diuna', 'Mesjasz Diuny']);
  assert.equal(provider.formatBookMetadata(item('Fahrenheit 451: A Novel'), 'audiobook').title, 'Fahrenheit 451');
});

test('storytel: the series name is cut from the title only when it stands apart', () => {
  const provider = new Storytel({ http: fakeHttp([]) });
  const item = (name, series, order) => ({ book: { name, authorsAsString: 'A', series: [{ name: series }], seriesOrder: order }, abook: { length: 60000 } });
  const hp = provider.formatBookMetadata(item('Harry Potter i Kamień Filozoficzny', 'Harry Potter', 1), 'audiobook');
  assert.equal(hp.title, 'Harry Potter i Kamień Filozoficzny');
  assert.deepEqual(hp.series, [{ series: 'Harry Potter', sequence: '1' }]);
  assert.equal(provider.formatBookMetadata(item('Wiedźmin: Krew elfów', 'Wiedźmin', 3), 'audiobook').title, 'Krew elfów');
  assert.equal(provider.formatBookMetadata(item('Krew elfów - Wiedźmin', 'Wiedźmin', 3), 'audiobook').title, 'Krew elfów');
  assert.equal(provider.formatBookMetadata(item('Wiedźmin', 'Wiedźmin', 1), 'audiobook').title, 'Wiedźmin');
});

test('storytel: a block page is an error', async () => {
  const provider = new Storytel({ http: fakeHttp([['search.action', '<html>Access denied</html>']]) });
  await assert.rejects(() => provider.searchBooks('cokolwiek blokada', '', 'pl'), /unexpected response/);
});

test('audible: search by title and author, everything in one request', async () => {
  const http = fakeHttp([['api.audible.com', jsonFixture('audible-search.json')]]);
  const provider = new Audible({ http, language: 'us' });
  const { matches } = await provider.searchBooks('Project Hail Mary unit', 'Andy Weir');

  assert.equal(http.calls[0].params.title, 'Project Hail Mary unit');
  assert.equal(http.calls[0].params.author, 'Andy Weir');
  const [first] = matches;
  assert.equal(first.title, 'Project Hail Mary');
  assert.deepEqual(first.authors, ['Andy Weir']);
  assert.equal(first.narrator, 'Ray Porter');
  assert.equal(first.asin, 'B08G9PRS1K');
  assert.equal(first.type, 'audiobook');
  assert.equal(first.language, 'english');
  assert.equal(first.duration, 970);
  assert.equal(first.publishedYear, '2021');
  assert.match(first.cover, /^https:\/\/m\.media-amazon\.com\//);
  assert.equal(first._fullFetched, true);
  assert.equal(await provider.getFullMetadata(first), first);
});

test('audible: series, translators and the unknown region', () => {
  const provider = new Audible({ http: fakeHttp([]), language: 'xx' });
  assert.equal(provider.region, 'us');
  const formatted = provider.format({
    asin: 'B000', title: 'The Last Wish (Unabridged)',
    authors: [{ name: 'Andrzej Sapkowski' }, { name: 'Danusia Stok - translator' }, { name: 'David French — Translator' }],
    series: [{ title: 'The Witcher', sequence: '0.5' }],
    category_ladders: [
      { ladder: [{ name: 'Science Fiction & Fantasy' }, { name: 'Fantasy' }, { name: 'Epic' }] },
      { ladder: [{ name: 'Science Fiction & Fantasy' }, { name: 'Fantasy' }, { name: 'Action & Adventure' }] },
    ],
  });
  assert.deepEqual(formatted.genres, ['Science Fiction & Fantasy']);
  assert.deepEqual(formatted.tags, ['Fantasy', 'Epic', 'Action & Adventure']);
  assert.equal(formatted.title, 'The Last Wish');
  assert.deepEqual(formatted.authors, ['Andrzej Sapkowski']);
  assert.deepEqual(formatted.series, [{ series: 'The Witcher', sequence: '0.5' }]);
});

test('lubimyczytac: cycle from the page record, original title, missing cover', () => {
  const provider = new LubimyCzytac({ http: fakeHttp([]) });
  const page = (ld, body = '') => `<html><head><meta property="og:image" content="http://s.lubimyczytac.pl/upload/books/1/1-352x500.jpg">
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Book', name: 'Szklana góra', ...ld })}</script></head><body>${body}</body></html>`;
  const snippet = { id: '1', title: 'Szklana góra', authors: ['Anna Testowa'], url: 'https://lubimyczytac.pl/ksiazka/1/szklana-gora', type: 'book' };

  const cycle = provider.parseDetail(page(
    { datePublished: '2014-09-25', isPartOfSeries: { name: 'Cykl Górski', position: '2', url: 'https://lubimyczytac.pl/cykl/5/cykl-gorski' } },
    '<dl><dt> Tytuł oryginału:</dt><dd> Glass Mountain </dd></dl>',
  ), snippet);
  assert.equal(cycle.series, 'Cykl Górski');
  assert.equal(cycle.seriesIndex, 2);
  assert.equal(cycle.originalTitle, 'Glass Mountain');
  assert.equal(cycle.publishedDate, '2014-09-25'); // no edition rows: the record's date
  assert.equal(cycle.cover, 'https://s.lubimyczytac.pl/upload/books/1/1-352x500.jpg'); // the preview picture, over https

  // A publisher's imprint is not a series; the same title is not an original title.
  const imprint = provider.parseDetail(page(
    { image: 'https://s.lubimyczytac.pl/upload/default-book-352x500.jpg', isPartOfSeries: { name: 'Seria z Kotem', url: 'https://lubimyczytac.pl/seria/9/seria-z-kotem' } },
    '<dl><dt> Tytuł oryginału:</dt><dd> Szklana góra </dd><dt title="Data pierwszego wydania"> Data 1. wydania:</dt><dd> 1986-01-01 </dd><dt title="Data pierwszego wydania polskiego"> Data 1. wyd. pol.:</dt><dd> 1993-01-01 </dd></dl>',
  ), snippet);
  assert.equal(imprint.series, null);
  assert.equal(imprint.originalTitle, undefined);
  assert.equal(imprint.cover, '');
  assert.equal(imprint.publishedDate, '1993-01-01'); // the first Polish edition leads
  assert.equal(toAbsMatch({ ...cycle, _provider: 'lubimyczytac' }).originalTitle, 'Glass Mountain');
});

test('audioteka: the German store', async () => {
  const detail = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': ['Product', 'Audiobook'], name: 'Glasberg', image: 'https://atkcdn.audioteka.com/cc/aa/glasberg/1.jpg?w=300', duration: 'PT8H42M', readBy: [{ name: 'Hans Probe' }] })}</script></head><body>
    <dl><dt>Sprecher</dt><dd><a>Hans Probe</a></dd><dt>Dauer</dt><dd>8 Stunden 42 Minuten</dd><dt>Verlag</dt><dd><a>Probeverlag</a></dd><dt>Typ</dt><dd>Hörbuch</dd>
    <dt>Sprache</dt><dd>Deutsch</dd><dt>Kategorie</dt><dd><a>Science-Fiction</a></dd><dt>ISBN</dt><dd>9783161484100</dd></dl>
    <div id="audiobook-description"><p>Ein Probetext.</p></div></body></html>`;
  const http = fakeHttp([['/de/search/', '<div class="teaser_teaser__x"><a class="teaser_link__x" href="/de/audiobook/glasberg/"><p class="teaser_title__x">Glasberg</p></a><p class="teaser_author__x">Anna Probe</p></div>'], ['/de/audiobook/glasberg/', detail]]);
  const provider = new Audioteka({ http, language: 'de', extra: { addLinkToDescription: false } });
  const { matches } = await provider.searchBooks('Glasberg');
  assert.match(http.calls[0].url, /^https:\/\/audioteka\.com\/de\/search\/\?phrase=Glasberg/);
  assert.equal(matches[0].url, 'https://audioteka.com/de/audiobook/glasberg/');

  const full = await provider.getFullMetadata(matches[0]);
  assert.equal(full.narrator, 'Hans Probe');
  assert.equal(full.duration, 522);
  assert.equal(full.publisher, 'Probeverlag');
  assert.deepEqual(full.genres, ['Science-Fiction']);
  assert.deepEqual(full.languages, ['german']);
  assert.equal(full.identifiers.isbn, '9783161484100');
  assert.equal(full.description, '<p>Ein Probetext.</p>'); // found by its id when the class is gone
  assert.equal(Audioteka.parseDuration('8 Stunden'), 480);
});

test('audioteka: reading lists are not genres; an unknown store is the Polish one', async () => {
  const html = '<dl><dt>Kategoria</dt><dd><a>Fantasy</a><a>Lektury szkoła średnia</a></dd><dt>ISBN</dt><dd>1234567890123</dd></dl>';
  const provider = new Audioteka({ http: fakeHttp([]), language: 'xx' });
  assert.equal(provider.searchUrl, 'https://audioteka.com/pl/szukaj/');
  const full = provider.parseDetail(html, { id: 'x', title: 'x', url: 'https://audioteka.com/pl/audiobook/x/' });
  assert.deepEqual(full.genres, ['Fantasy']);
  assert.deepEqual(full.languages, ['polish']);
  assert.equal(full.identifiers.isbn, undefined); // not an ISBN
});

test('isbn: only numbers whose check digit holds', () => {
  assert.equal(validIsbn('978-83-7578-063-5'), '9788375780635');
  assert.equal(validIsbn('0-306-40615-2'), '0306406152');
  assert.equal(validIsbn('0408311111451'), undefined); // Storytel's own number
  assert.equal(validIsbn('9788375780636'), undefined);
  assert.equal(validIsbn(''), undefined);
});

test('storytel: its own product number is not an ISBN', () => {
  const provider = new Storytel({ http: fakeHttp([]) });
  const item = (isbn) => ({ book: { name: 'Tytuł', authorsAsString: 'A', series: [] }, abook: { length: 60000, isbn } });
  assert.equal(provider.formatBookMetadata(item('0408311111451'), 'audiobook').isbn, undefined);
  assert.equal(provider.formatBookMetadata(item('9788375780635'), 'audiobook').isbn, '9788375780635');
});

test('audible: translators in the store\'s language, large covers asked for', async () => {
  const http = fakeHttp([['api.audible.de', { products: [{ asin: 'B001', title: 'Der letzte Wunsch', authors: [{ name: 'Andrzej Sapkowski' }, { name: 'Erik Simon - Übersetzer' }, { name: 'Jan Kowalski - tłumacz' }], product_images: { 500: 'https://m.media-amazon.com/a.jpg', 1024: 'https://m.media-amazon.com/b.jpg' } }] }]]);
  const { matches } = await new Audible({ http, language: 'de' }).searchBooks('Der letzte Wunsch covers');
  assert.equal(http.calls[0].params.image_sizes, '500,1024');
  assert.deepEqual(matches[0].authors, ['Andrzej Sapkowski']);
  assert.equal(matches[0].cover, 'https://m.media-amazon.com/b.jpg');
});

test('provider metadata file matches the provider modules', () => {
  const modules = { lubimyczytac: LubimyCzytac, audioteka: Audioteka, storytel: Storytel, audible: Audible };
  assert.deepEqual(Object.keys(meta.providers).sort(), Object.keys(modules).sort());
  for (const [name, mod] of Object.entries(modules)) {
    assert.deepEqual(meta.providers[name].supportedLanguages, mod.supportedLanguages, name);
  }
});
