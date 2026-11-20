const test = require('node:test');
const assert = require('node:assert/strict');

const { norm, scoreMatch, toAbsMatch, sortResults, mergeBestResults } = require('../../src/backbone/pipeline');
const { absMap } = require('../helpers/abs-adapter');

test('norm ignores case, diacritics and punctuation', () => {
  assert.equal(norm('Wiedźmin. Ostatnie ŻYCZENIE!'), 'wiedzmin ostatnie zyczenie');
  assert.equal(norm('Łódź'), 'lodz');
  assert.equal(norm(null), '');
});

test('scoreMatch: title only, title with author, author inside the query', () => {
  const m = { title: 'Wiedźmin. Ostatnie życzenie', authors: ['Andrzej Sapkowski'] };
  assert.equal(scoreMatch(m, 'wiedzmin ostatnie zyczenie', ''), 1);
  assert.equal(scoreMatch(m, 'Wiedźmin. Ostatnie życzenie', 'Andrzej Sapkowski'), 1);
  assert.equal(scoreMatch(m, 'andrzej sapkowski wiedzmin ostatnie zyczenie', ''), 1);
  const wrongAuthor = scoreMatch(m, 'Wiedźmin. Ostatnie życzenie', 'Stanisław Lem', 0.6);
  assert.ok(wrongAuthor > 0.6 && wrongAuthor < 0.75, String(wrongAuthor));
  // titleWeight 1 = the author does not count
  assert.equal(scoreMatch(m, 'Wiedźmin. Ostatnie życzenie', 'Stanisław Lem', 1), 1);
  assert.equal(scoreMatch({ title: 'Solaris', author: 'Stanisław Lem' }, 'Solaris', 'Stanisław Lem'), 1);
});

test('toAbsMatch: a LubimyCzytać result keeps series, ISBN, year and language through Audiobookshelf', () => {
  // The shape the provider returns: Audiobookshelf used to drop all four (GitHub issue #1).
  const lubimyczytac = {
    id: '240310', title: 'Ostatnie życzenie', authors: ['Andrzej Sapkowski'], type: 'book',
    url: 'https://lubimyczytac.pl/ksiazka/240310/ostatnie-zyczenie', cover: 'https://s.lubimyczytac.pl/c.jpg',
    description: 'Opis.', languages: ['pol'], publisher: 'superNOWA', publishedDate: '1993-01-01', rating: 4.2,
    series: 'Wiedźmin Geralt z Rivii', seriesIndex: 1, genres: ['fantasy', 'science fiction'], tags: ['wiedźmin'],
    identifiers: { isbn: '9788375780635', lubimyczytac: '240310' }, similarity: 1, _provider: 'lubimyczytac', _providerPriority: 10,
  };
  const [abs] = absMap({ matches: [toAbsMatch(lubimyczytac)] });
  assert.deepEqual(abs, {
    title: 'Ostatnie życzenie',
    author: 'Andrzej Sapkowski',
    publisher: 'superNOWA',
    publishedYear: '1993',
    description: 'Opis.',
    cover: 'https://s.lubimyczytac.pl/c.jpg',
    isbn: '9788375780635',
    genres: ['fantasy', 'science fiction'],
    tags: ['wiedźmin'],
    series: [{ series: 'Wiedźmin Geralt z Rivii', sequence: '1' }],
    language: 'pol',
  });
});

test('toAbsMatch: provider shapes', () => {
  const audioteka = toAbsMatch({ title: 'Krew elfów. Tom 1', authors: ['Andrzej Sapkowski'], narrator: 'A, B, A', duration: 388,
    series: ['Wiedźmin'], tags: [], genres: ['Fantasy', 'fantasy'], languages: ['polish'], type: 'audiobook', identifiers: { audioteka: 'krew' } });
  assert.equal(audioteka.narrator, 'A, B');
  assert.deepEqual(audioteka.series, [{ series: 'Wiedźmin' }]);
  assert.deepEqual(audioteka.genres, ['Fantasy']);
  assert.equal(audioteka.language, 'polish');
  assert.equal(audioteka.duration, 388);
  assert.equal(audioteka.isbn, undefined);

  const storytel = toAbsMatch({ title: 'T', author: 'A B, C D', language: 'pl', isbn: '978', publishedYear: '2017',
    series: [{ series: 'S', sequence: '6' }], type: 'book', description: '' });
  assert.deepEqual(storytel.authors, ['A B', 'C D']);
  assert.equal(storytel.author, 'A B, C D');
  assert.deepEqual(storytel.languages, ['pl']);
  assert.equal(storytel.identifiers.isbn, '978');
  assert.equal(storytel.seriesIndex, '6');
  assert.equal('description' in storytel, false);

  const audible = toAbsMatch({ title: 'T', authors: ['A'], asin: 'B08', publishedDate: '2021-05-04', duration: 970, type: 'audiobook' });
  assert.equal(audible.publishedYear, '2021');
  assert.equal(audible.published, '2021');
  assert.equal(audible.published_date, '2021-05-04');
  assert.equal(audible.identifiers.asin, 'B08');
});

test('toAbsMatch: the year does not depend on the time zone', () => {
  // A Date at UTC midnight on 1 January is still that year, wherever the server runs.
  assert.equal(toAbsMatch({ title: 'T', publishedDate: new Date('2020-01-01T00:00:00Z') }).publishedYear, '2020');
  assert.equal(toAbsMatch({ title: 'T', publishedDate: 'nie wiadomo' }).publishedYear, undefined);
});

test('sortResults: similarity, then audiobooks, then provider priority', () => {
  const sorted = sortResults([
    { title: 'a', similarity: 0.9, type: 'audiobook', _providerPriority: 99 },
    { title: 'b', similarity: 1, type: 'book', _providerPriority: 99 },
    { title: 'c', similarity: 1, type: 'audiobook', _providerPriority: 10 },
    { title: 'd', similarity: 1, type: 'audiobook', _providerPriority: 20 },
  ]);
  assert.deepEqual(sorted.map((r) => r.title), ['d', 'c', 'b', 'a']);
});

const lc = toAbsMatch({
  id: '1', title: 'Zrost', authors: ['Robert Małecki'], type: 'audiobook', description: 'Opis z LC', cover: 'https://lc/c.jpg',
  series: 'Bernard Gross', seriesIndex: 3, genres: ['kryminał'], languages: ['pol'], publishedDate: '2020-05-01',
  identifiers: { isbn: '9788300000000', lubimyczytac: '1' }, similarity: 1, _provider: 'lubimyczytac', _providerPriority: 10,
});
const at = toAbsMatch({
  id: 'zrost', title: 'Zrost', authors: ['Robert Małecki'], type: 'audiobook', description: '<p>Opis z Audioteki</p>', cover: 'https://at/c.jpg',
  narrator: 'Filip Kosior', duration: 600, publisher: 'Czwarta Strona', series: ['Bernard Gross'], genres: ['Kryminał', 'Sensacja'],
  languages: ['polish'], identifiers: { audioteka: 'zrost' }, similarity: 1, _provider: 'audioteka', _providerPriority: 20,
});

test('mergeBestResults: preferred provider per field, the rest from the highest priority', () => {
  const prefs = { description: 'lubimyczytac', cover: 'audioteka', narrator: 'audioteka', series: 'lubimyczytac', genres: 'lubimyczytac', language: 'lubimyczytac', isbn: 'lubimyczytac' };
  const merged = mergeBestResults([at, lc], prefs);

  assert.equal(merged._provider, 'merged');
  assert.equal(merged.description, 'Opis z LC');
  assert.equal(merged.cover, 'https://at/c.jpg');
  assert.equal(merged.narrator, 'Filip Kosior');
  assert.equal(merged.duration, 600);
  assert.equal(merged.publisher, 'Czwarta Strona');
  assert.equal(merged.isbn, '9788300000000');
  assert.equal(merged.publishedYear, '2020');
  assert.equal(merged.language, 'pol');
  assert.deepEqual(merged.languages, ['pol', 'polish']);
  assert.deepEqual(merged.genres, ['kryminał']);
  assert.deepEqual(merged.series, [{ series: 'Bernard Gross', sequence: '3' }]);
  assert.deepEqual(merged.identifiers, { audioteka: 'zrost', isbn: '9788300000000', lubimyczytac: '1' });
  assert.deepEqual(merged._mergedFrom, [{ provider: 'audioteka', id: 'zrost' }, { provider: 'lubimyczytac', id: '1' }]);
  assert.equal(merged._mergedFieldSources.description, 'lubimyczytac');
  assert.equal(merged._mergedFieldSources.duration, 'audioteka');
  assert.equal(merged._providerPriority, 21);

  // and Audiobookshelf accepts all of it
  const [abs] = absMap({ matches: [merged] });
  assert.deepEqual(abs.series, [{ series: 'Bernard Gross', sequence: '3' }]);
  assert.equal(abs.isbn, '9788300000000');
  assert.equal(abs.duration, 600);
});

test('mergeBestResults: without preferences lists are joined and a series gets its number from another source', () => {
  const merged = mergeBestResults([at, lc], {});
  assert.deepEqual(merged.genres, ['Kryminał', 'Sensacja']); // "kryminał" is the same genre
  assert.deepEqual(merged.series, [{ series: 'Bernard Gross', sequence: '3' }]); // Audioteka names it, LubimyCzytać numbers it
  assert.equal(merged.description, '<p>Opis z Audioteki</p>');
});

test('mergeBestResults: only the same work in the same form is merged', () => {
  const book = { ...lc, id: '9', type: 'book', isbn: '9788300000009', identifiers: { isbn: '9788300000009' } };
  const comic = { ...lc, id: '8', authors: ['Ktoś Inny'], author: 'Ktoś Inny', description: 'Komiks' };
  const other = { ...lc, id: '7', title: 'Zrost. Wydanie drugie' };
  const merged = mergeBestResults([at, lc, book, comic, other], { description: 'lubimyczytac' });
  assert.deepEqual(merged._mergedFrom, [{ provider: 'audioteka', id: 'zrost' }, { provider: 'lubimyczytac', id: '1' }]);
  assert.equal(merged.isbn, '9788300000000'); // not the printed book's
  assert.equal(merged.description, 'Opis z LC'); // not the comic's
  // the top result alone in its kind: nothing to merge, whatever else scored the same
  assert.equal(mergeBestResults([at, book, comic], {}), null);
});

test('mergeBestResults: nothing to merge', () => {
  assert.equal(mergeBestResults([], {}), null);
  assert.equal(mergeBestResults([at], {}), null);
  assert.equal(mergeBestResults([at, { ...lc, similarity: 0.9 }], {}), null);
  // two identical results add nothing to the first
  assert.equal(mergeBestResults([at, { ...at, _provider: 'storytel', _providerPriority: 1 }], {}), null);
});
