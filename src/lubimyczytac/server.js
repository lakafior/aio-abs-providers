const express = require('express');
const axios = require('axios');
const cors = require('cors');
const LubimyCzytacProvider = require('./provider');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// No authorization required for local provider servers
// (was rejecting requests with missing Authorization header)

// Axios 429 retry interceptor (kept from original)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;
    if (response?.status === 429) {
      config._retryCount = (config._retryCount || 0) + 1;
      if (config._retryCount <= 5) {
        const delayMs = 10000 + Math.floor(Math.random() * 10000);
        console.log(`[429] Retry ${config._retryCount}/5 after ${Math.round(delayMs/1000)}s`);
        await sleep(delayMs);
        return axios.request(config);
      }
      console.error(`[429] Max retries exceeded for ${config.url}`);
    }
    throw error;
  }
);

const provider = new LubimyCzytacProvider();

app.get('/search', async (req, res) => {
  try {
    console.log('Received search request:', req.query);
    const query = req.query.query;
    const author = req.query.author;
    if (!query) return res.status(400).json({ error: 'Query parameter is required' });

    const results = await provider.searchBooks(query, author);

    const formattedResults = {
      matches: (results.matches || []).map(book => {
        const year = book.publishedDate ? new Date(book.publishedDate).getFullYear() : null;
        const publishedYear = year ? year.toString() : undefined;

        return {
          title: book.title,
          subtitle: book.subtitle || undefined,
          author: (book.authors || []).join(', '),
          narrator: book.narrator || undefined,
          publisher: book.publisher || undefined,
          publishedYear: publishedYear,
          description: book.description || undefined,
          cover: book.cover || undefined,
          isbn: book.identifiers?.isbn || (book.similarity >= 0.95 ? '0' : undefined),
          asin: book.identifiers?.asin || undefined,
          genres: book.genres || undefined,
          tags: book.tags || undefined,
          series: book.series ? [{ series: book.series, sequence: book.seriesIndex ? book.seriesIndex.toString() : undefined }] : undefined,
          language: book.languages && book.languages.length > 0 ? book.languages[0] : undefined,
          duration: book.duration || undefined,
          type: book.type,
          similarity: book.similarity
        };
      })
    };

    console.log('Sending response:', JSON.stringify(formattedResults, null, 2));
    res.json(formattedResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`LubimyCzytac provider listening on port ${port}`);
});
