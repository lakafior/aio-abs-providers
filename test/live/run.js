#!/usr/bin/env node
// Live check against the real sources. Not part of `npm test`: it needs the network and the sites' goodwill.
//
//   npm run test:live                      all sources, then the whole backbone
//   npm run test:live -- audioteka         one source (lubimyczytac, audioteka, storytel, audible, backbone)
//   npm run test:live -- --json out.json   also write every result to a file
//
// For each query the best-scoring snippet is taken, its details fetched, and the fields Audiobookshelf reads
// are listed. Requests are spaced out (DELAY_MS, default 1500): these are other people's servers.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { scoreMatch, toAbsMatch } = require('../../src/backbone/pipeline');
const { createApp } = require('../../src/backbone/app');
const { createConfigStore, BUNDLED_CONFIG_PATH } = require('../../src/lib/config');
const { absMap } = require('../helpers/abs-adapter');

const DELAY_MS = Number(process.env.DELAY_MS || 1500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json');
const wanted = (name) => !only.length || only.includes(name);

const POLISH = [
  ['Ostatnie życzenie', 'Andrzej Sapkowski', 'popular, series vol. 1'],
  ['Krew elfów', '', 'no author, series'],
  ['wiedzmin miecz przeznaczenia', '', 'typed without diacritics'],
  ['Zrost', 'Robert Małecki', 'series with volume'],
  ['Lalka', 'Bolesław Prus', 'classic'],
  ['Pan Tadeusz', '', 'classic, no author'],
  ['Harry Potter i Kamień Filozoficzny', 'J.K. Rowling', 'series vol. 1, translated'],
  ['Gra o tron', 'George R.R. Martin', 'series, translated'],
  ['Chłopki. Opowieść o naszych babkach', 'Joanna Kuciel-Frydryszak', 'subtitle, hyphenated author'],
  ['Święto ognia', 'Jakub Małecki', 'diacritics'],
  ['Fahrenheit 451', 'Ray Bradbury', 'number in the title'],
  ['Mistrz i Małgorzata', '', 'no author'],
  ['9788375780635', '', 'ISBN as the query'],
  ['Qwertzuiop Asdfghjkl 99887', '', 'does not exist'],
];
const ENGLISH = [
  ['Project Hail Mary', 'Andy Weir', 'popular'],
  ['The Last Wish', 'Andrzej Sapkowski', 'series'],
  ['Dune', '', 'no author'],
  ["Harry Potter and the Sorcerer's Stone", 'J.K. Rowling', 'series vol. 1'],
  ['A Game of Thrones', 'George R.R. Martin', 'series'],
  ['The Hobbit', '', 'no author'],
  ['1984', 'George Orwell', 'number as the title'],
  ['Fahrenheit 451', 'Ray Bradbury', 'number in the title'],
  ['Les Misérables', 'Victor Hugo', 'diacritics'],
  ['Solaris', 'Stanisław Lem', 'diacritics in the author'],
  ['The Fellowship of the Ring', 'J.R.R. Tolkien', 'series with volume'],
  ['Qwertzuiop Asdfghjkl 99887', '', 'does not exist'],
];
const SOURCES = { lubimyczytac: POLISH, audioteka: POLISH, storytel: POLISH, audible: ENGLISH };
const FIELDS = ['title', 'author', 'narrator', 'series', 'sequence', 'description', 'cover', 'genres', 'publisher', 'publishedYear', 'language', 'duration', 'isbn', 'asin'];

const short = (v, n = 34) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function runSource(name, records) {
  const config = JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8'));
  const opts = config.providers[name];
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const Provider = require(`../../src/${name}/provider`);
  const provider = new Provider(opts);
  const quiet = console.error; console.error = () => {};
  console.log(`\n## ${name} (language: ${opts.language})\n`);
  console.log(`| query | author | hits | sim | type | found | ${FIELDS.slice(2).join(' | ')} |`);
  console.log(`|---|---|---|---|---|---|${FIELDS.slice(2).map(() => '---').join('|')}|`);
  for (const [query, author, note] of SOURCES[name]) {
    const record = { source: name, query, author, note };
    try {
      const started = Date.now();
      const { matches } = await provider.searchBooks(query, author, opts.language);
      record.hits = matches.length;
      const best = matches.map((m) => ({ ...m, similarity: scoreMatch(m, query, author) })).sort((a, b) => b.similarity - a.similarity)[0];
      if (best) {
        await sleep(DELAY_MS / 2);
        const full = best._fullFetched ? best : await provider.getFullMetadata(best);
        const { _raw, ...rest } = full || best;
        record.result = toAbsMatch({ ...rest, similarity: best.similarity });
      }
      record.ms = Date.now() - started;
    } catch (err) {
      record.error = err.message;
    }
    records.push(record);
    const r = record.result;
    const cell = (f) => {
      if (!r) return '';
      if (f === 'series') return r.series ? short(r.series[0].series, 22) : '–';
      if (f === 'sequence') return r.series && r.series[0].sequence ? r.series[0].sequence : '–';
      if (f === 'description') return r.description ? `${r.description.length} ch` : '–';
      if (f === 'cover') return r.cover ? 'yes' : '–';
      if (f === 'genres') return r.genres && r.genres.length ? short(r.genres.join(', '), 22) : '–';
      return r[f] === undefined ? '–' : short(r[f], 22);
    };
    console.log(`| ${short(query, 30)} | ${short(author, 18)} | ${record.error ? `ERROR ${short(record.error, 40)}` : record.hits} | ${r ? r.similarity.toFixed(2) : ''} | ${r ? r.type : ''} | ${r ? `${short(r.title, 30)} / ${short(r.author, 20)}` : '(nothing)'} | ${FIELDS.slice(2).map(cell).join(' | ')} |`);
    await sleep(DELAY_MS);
  }
  console.error = quiet;
}

// The whole backbone, in process, the way Audiobookshelf calls it.
async function runBackbone(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-live-'));
  const file = path.join(dir, 'config.json');
  const base = JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8'));
  const quietLog = { log() {}, error() {} };
  const quiet = console.error; console.error = () => {};
  console.log('\n## backbone (/search as Audiobookshelf calls it)\n');
  console.log('| request | merge | HTTP | ms | providers (snippets) | matches | first match | accepted by ABS: series / isbn / year / language / duration |');
  console.log('|---|---|---|---|---|---|---|---|');
  const cases = [
    ['mediaType=book&query=Ostatnie życzenie&author=Andrzej Sapkowski', true],
    ['mediaType=book&query=Ostatnie życzenie&author=Andrzej Sapkowski', false],
    ['mediaType=book&query=Zrost&author=Robert Małecki', true],
    ['mediaType=book&query=Zrost&author=Robert Małecki', false],
    ['mediaType=book&query=Zrost&author=Robert Małecki&format=audiobook', false],
    ['mediaType=book&query=Zrost&author=Robert Małecki&format=ebook', false],
    ['mediaType=book&query=Lalka&author=Bolesław Prus&isbn=9788304040991', false],
    ['mediaType=podcast&query=Zrost', false],
    ['mediaType=book&query=Qwertzuiop Asdfghjkl 99887', true],
  ];
  for (const [request, merge] of cases) {
    fs.writeFileSync(file, JSON.stringify({ ...base, global: { ...base.global, mergeBestResults: merge } }));
    const store = createConfigStore({ file, checkIntervalMs: 0, log: quietLog });
    const { app } = createApp({ store, env: {}, log: quietLog });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/search?${new URLSearchParams(request)}`);
    const body = await res.json();
    const ms = Date.now() - started;
    server.close();
    const abs = absMap(body) || [];
    const first = (body.matches || [])[0];
    const a = abs[0] || {};
    records.push({ source: 'backbone', request, merge, status: res.status, ms, providers: body.providers, matches: body.matches });
    console.log(`| ${request} | ${merge ? 'on' : 'off'} | ${res.status} | ${ms} | ${(body.providers || []).map((p) => `${p.provider}: ${p.error || p.count}`).join(', ')} | ${(body.matches || []).map((m) => `${m._provider}/${m.type}`).join(', ') || '–'} | ${first ? `${short(first.title, 28)} / ${short(first.author, 18)}` : '–'} | ${first ? [a.series ? `${a.series[0].series} #${a.series[0].sequence || '?'}` : '–', a.isbn || '–', a.publishedYear || '–', a.language || '–', a.duration || '–'].join(' / ') : ''} |`);
    await sleep(DELAY_MS * 2);
  }
  console.error = quiet;
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  const records = [];
  const log = console.log; // providers must not write into the table
  for (const name of Object.keys(SOURCES)) if (wanted(name)) await runSource(name, records);
  if (wanted('backbone')) await runBackbone(records);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(records, null, 1));
  const failed = records.filter((r) => r.error).length;
  log(`\n${records.length} checks, ${failed} request errors.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
