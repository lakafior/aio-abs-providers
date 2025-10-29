const express = require('express');
const cors = require('cors');

// Simple backbone that loads provider modules by relative path and proxies /search
// Expected usage: set PROVIDERS env var as a comma-separated list of provider folder paths,
// e.g. PROVIDERS="./audioteka,./lubimyczytac"

const providerPaths = (process.env.PROVIDERS || './audioteka,./lubimyczytac,./storytel').split(',').map(p => p.trim()).filter(Boolean);
const providers = [];

for (const p of providerPaths) {
  try {
    // providers should export a class with searchBooks(query, author)
    // require the module's provider (e.g. ./audioteka/provider.js)
    // prefer explicit provider.js if available
    let modPath = p;
    try {
      // if path points to a folder, append /provider
      const candidate = require('path').join(p, 'provider');
      // eslint-disable-next-line import/no-dynamic-require
      const ProviderClass = require(candidate);
      providers.push({ name: p, instance: new ProviderClass() });
      continue;
    } catch (err) {
      // fall through to try requiring the path directly
    }

    const ProviderClass = require(p);
    providers.push({ name: p, instance: new ProviderClass() });
  } catch (err) {
    console.warn(`Could not load provider at ${p}:`, err.message);
  }
}

const app = express();
const port = process.env.PORT || 4000;
app.use(cors());

app.get('/search', async (req, res) => {
  const q = req.query.query;
  const author = req.query.author;
  if (!q) return res.status(400).json({ error: 'query required' });

  const tasks = providers.map(async (p) => {
    try {
      const results = await p.instance.searchBooks(q, author);
      return { provider: p.name, matches: results.matches || [] };
    } catch (err) {
      return { provider: p.name, error: String(err) };
    }
  });

  const all = await Promise.all(tasks);
  // Flatten matches and tag with provider
  const combined = all.reduce((acc, cur) => {
    if (cur.matches) {
      const tagged = cur.matches.map(m => ({ ...m, _provider: cur.provider }));
      return acc.concat(tagged);
    }
    return acc;
  }, []);

  res.json({ providers: all, matches: combined });
});

app.listen(port, () => console.log(`Backbone listening on ${port}; providers: ${providers.map(p=>p.name).join(',')}`));
