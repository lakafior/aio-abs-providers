# Provider plugin template

This repository exposes a simple plugin interface for AudiobookShelf metadata providers. Each provider should export a class (constructor function) that implements a single async method:

- async searchBooks(query, author = '', requestId = 'req') => { matches: [ ... ] }

Provider implementation notes:

- Export the provider class as module.exports = MyProvider;
- The provider constructor may accept options (optional) but default-constructible is recommended for the local server wrappers.
- searchBooks should return an object { matches: [ { id, title, authors, url, cover, source, identifiers?, narrator?, duration?, publisher?, description?, genres?, tags?, series?, rating?, languages? } ] }
- Each match object may contain additional metadata. Keep fields consistent across providers for easier normalization in the backbone.

Server wrapper pattern (for backward compatibility):

- Each provider folder contains a small Express server (`server.js`) that instantiates the provider and exposes a `/search` route which maps query/author params to provider.searchBooks and formats results into the expected JSON.

Example minimal provider export:

```js
class ExampleProvider {
  constructor(options) { this.id = 'example'; }
  async searchBooks(query, author = '') {
    // perform web requests / scraping
    return { matches: [ /* ... */ ] };
  }
}
module.exports = ExampleProvider;
```

Backbone note:

The backbone aggregator will `require()` provider modules by path (or load remote providers via HTTP). Keep provider modules free of side-effects (don't start servers on require). Server wrappers (`server.js`) may require the provider and start an Express server.
