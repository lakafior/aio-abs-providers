# aio-abs-providers

> Warning! It's in really early stages of development, test it but expect bugs!

Lightweight aggregator ("Backbone") for audiobook providers.  
Searches multiple providers (lubimyczytac, audioteka, storytel, ...) and returns ranked results, with optional merging of best matches and controlled detail-page fetches to minimize load on upstream sites.

---

## Quick overview

<img width="1451" height="805" alt="image" src="https://github.com/user-attachments/assets/bd8969bf-be22-4d42-81c0-ba438f03f5a8" />

- **Providers** (audioteka, lubimyczytac, storytel at the moment) return small search snippets (title, id, url, minimal fields).
- **Backbone** scores each snippet by title/author similarity (configurable weight).
- Backbone applies per-provider caps and a global similarity threshold.
- Backbone fetches full metadata (detail pages) only for the small candidate set.
- **Optional "merge best results" builds a single superior result from multiple top matches, with per-field provider preference rules.**

---

## Features

> You can set them on `http://<host>:4000/admin`

<img width="531" height="319" alt="image" src="https://github.com/user-attachments/assets/ea7c955f-d25e-45da-bbb9-15467d10dd19" />

- Global controls:
  - `titleWeight` (0–100) — weighting between title vs author similarity (sums to 100).
  - `similarityThreshold` (0–100) — minimal similarity (%) to request full metadata.
  - `mergeBestResults` (bool) — synthesize merged top result.
  - `mergePreferences` (map) — prefer a provider for specific fields (cover, narrator, series, genres, tags, subtitle, isbn, etc.).
  - `mergeDebug` (bool) — enable extra merge logs.

<img width="506" height="453" alt="image" src="https://github.com/user-attachments/assets/531cfc74-7151-493c-bde1-b84a9ee216a0" />

- Per-provider controls:
  - `enabled`, `priority`, `languages`, `maxResults` — limit noisy providers.
  - provider-specific `extra` settings (e.g., `audioteka.extra.addLinkToDescription`).
- Minimal, informative logging:
  - provider snippet counts, candidate counts, planned full-fetch count, merged provenance.

---

## Important endpoints

- Admin UI: `http://<host>:4000/admin`
- Search UI: `http://<host>:4000/search-ui`
- API:
  - GET `/admin/config` — read config
  - PUT `/admin/config` — save config (body: full config JSON)
  - GET `/admin/providers/meta` — provider metadata (supported languages, etc.)
  - GET `/search?query=...&author=...&lang=...` — perform search, returns `matches` array (merged items include `_provider: "merged"` and `_mergedFrom` / `_mergedFieldSources`)

Example search via CLI:
```bash
curl 'http://localhost:4000/search?query=Zrost&author=Robert%20Ma%C5%82ecki' -s | jq '.matches | .[0:5]'
```
---
## Running with Docker / docker-compose

Project includes a multi-stage `Dockerfile` and `docker-compose.yml`.

Build and run locally:
```bash
# build & start (detached)
docker compose up -d --build

# view logs
docker compose logs -f backbone

# stop
docker compose down
```

Persistence:
- `./config` is mounted into container -> keep `config/config.json` edits persistent.
- `./logs` optionally mounted

---

## Result shape & Audiobookshelf integration

Backbone returns results in a normalized ABS-friendly shape. To configure it in Audiobookshelf just add it as custom provider:
<img width="907" height="146" alt="image" src="https://github.com/user-attachments/assets/f2cc95eb-516f-48ec-85a7-bc30b36415d1" />

1. Navigate to your AudiobookShelf settings
2. Navigate to Item Metadata Utils
3. Navigate to Custom Metadata Providers
4. Click on Add
5. Name: whatever for example AudioTeka
6. URL: http://your-ip:4000
7. Save

---

## Troubleshooting

- Still seeing many detail fetches? Confirm providers are updated to return snippets (searchBooks must not call getFullMetadata). If you have custom provider, follow the snippet+getFullMetadata pattern.
- Missing fields in Audiobookshelf? Check `author` (string) and `series` array-of-objects format.
- Admin UI not saving? Check that `config` directory is writable and mounted if running in Docker.


---

## Contributing

- Follow existing code style.
- When adding a provider:
  - Implement `searchBooks(query, author, lang)` → return snippet objects
  - Implement `getFullMetadata(snippet)` → return full normalized metadata (ABS shape)
  - Avoid performing detail-page fetches inside `searchBooks`
