const express = require('express');
const cors = require('cors');
const AudiotekaProvider = require('./provider');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

// No authorization required for local provider servers

const provider = new AudiotekaProvider();

app.get('/search', async (req, res) => {
  try {
    const query = req.query.query;
    const author = req.query.author;
    if (!query) return res.status(400).json({ error: 'Query parameter is required' });

    const results = await provider.searchBooks(query, author);

    const formattedResults = {
      matches: (results.matches || []).map(book => ({
        title: book.title,
        subtitle: book.subtitle || undefined,
        author: (book.authors || []).join(', '),
        narrator: book.narrator || undefined,
        publisher: book.publisher || undefined,
        publishedYear: book.publishedDate ? new Date(book.publishedDate).getFullYear().toString() : undefined,
        description: book.description || undefined,
        cover: book.cover || undefined,
        isbn: book.identifiers?.isbn || undefined,
        asin: book.identifiers?.asin || undefined,
        genres: book.genres || undefined,
        tags: book.tags || undefined,
        series: book.series ? book.series.map(seriesName => ({ series: seriesName, sequence: undefined })) : undefined,
        language: book.languages && book.languages.length > 0 ? book.languages[0] : undefined,
        duration: book.duration || undefined
      }))
    };

    res.json(formattedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => console.log(`Audioteka provider listening on port ${port}`));


