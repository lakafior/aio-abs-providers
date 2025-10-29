# aio-abs-providers

Lightweight aggregator ("Backbone") for audiobook providers.  
Searches multiple providers (lubimyczytac, audioteka, storytel, ...) and returns ranked results, with optional merging of best matches and controlled detail-page fetches to minimize load on upstream sites.

---

## Quick overview

- Providers return small search snippets (title, id, url, minimal fields).
- Backbone scores each snippet by title/author similarity (configurable weight).
- Backbone applies per-provider caps and a global similarity threshold.
- Backbone fetches full metadata (detail pages) only for the small candidate set.
- Optional "merge best results" builds a single superior result from multiple top matches, with per-field provider preference rules.

---

## Features

- Global controls:
  - `titleWeight` (0–100) — weighting between title vs author similarity (sums to 100).
  - `similarityThreshold` (0–100) — minimal similarity (%) to request full metadata.
  - `mergeBestResults` (bool) — synthesize merged top result.
  - `mergePreferences` (map) — prefer a provider for specific fields (cover, narrator, series, genres, tags, subtitle, isbn, etc.).
  - `mergeDebug` (bool) — enable extra merge logs.
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

Notes:
- If `ADMIN_TOKEN` is configured, include header `Authorization: Bearer <token>`.

Example search via CLI:
```bash
curl 'http://localhost:4000/search?query=Zrost&author=Robert%20Ma%C5%82ecki' -s | jq '.matches | .[0:5]'
```

---

## Config (location & important keys)

Config file: `config/config.json` (persisted volume in Docker compose). Example keys (global section):

- `global.titleWeight` (number, default ≈ 60)
- `global.similarityThreshold` (number, default ≈ 30)
- `global.mergeBestResults` (bool)
- `global.mergePreferences` (object) — keys: `title`, `authors`, `narrator`, `description`, `cover`, `series`, `genres`, `tags`, `subtitle`, `isbn`, `asin`, `duration`, `publishedYear`, `rating`, `url`, `source`, `identifiers`, `publisher`, `language`. Values: provider id or `"<auto>"`.
- `global.mergeDebug` (bool)

Per-provider example:
```json
"providers": {
  "audioteka": {
    "enabled": true,
    "priority": 20,
    "languages": ["pol"],
    "maxResults": 3,
    "extra": { "addLinkToDescription": false }
  }
}
```

Behavior notes:
- `maxResults` caps per-provider matches before thresholding.
- `similarityThreshold` uses percent (e.g., 75 means similarity >= 0.75).
- If `mergePreferences.field` points to a provider, Backbone tries that provider first; if missing, falls back to the first non-empty candidate.

---

## Result shape & Audiobookshelf integration

Backbone returns results in a normalized ABS-friendly shape. Key fields:

- `title`, `subtitle`, `authors` (array), `author` (joined string), `narrator`, `description`, `cover`, `type`, `url`, `source`, `languages` (array), `publisher`, `publishedYear`, `rating`, `series` (array of objects: `{ series, sequence }`), `genres`, `tags`, `identifiers` (map), `duration`, `similarity`
- Merged results:
  - `_provider: "merged"`
  - `_mergedFrom`: array of origin providers & ids
  - `_mergedFieldSources`: map of which provider supplied each merged field

Audiobookshelf notes:
- `series` is provided in the `{ series, sequence }` array format to be compatible with provider wrappers / importers.
- `author` (string) is present for downstream compatibility; `authors` (array) is the canonical array.

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
- `./logs` optionally mounted.

Environment variables:
- `ADMIN_TOKEN` — optional token to protect admin endpoints.
- `NODE_ENV` — set to `production` in Dockerfile.

CI / Image publishing:
- GitHub Actions workflow builds and can push `IMAGE_NAME` (configure secrets for registry).
- `docker-compose.yml` references the published image but still supports `build: .` for local use.

---

## How the new "full fix" works (detail fetch control)

- Providers return small snippets from `searchBooks()` (title, id, url, minimal meta).
- Backbone:
  1. collects snippets from all providers
  2. normalizes and scores them (title/author weights)
  3. applies per-provider caps (`maxResults`) and global similarity threshold
  4. calls `provider.getFullMetadata(snippet)` only for selected candidates
- No duplicate detail-page fetches: providers no longer fetch details during search; Backbone performs the single detail fetch per candidate.

---

## Logs & debugging

- Per-search concise logs:
  - `[search] provider snippets: {...}`
  - `[search] candidates: {...} plannedFullFetches=N`
  - `[merge] merged from providers: ... fieldSources=...` (if merge enabled)
- Toggle `global.mergeDebug` to get extra merge diagnostics.

---

## Troubleshooting

- Still seeing many detail fetches? Confirm providers are updated to return snippets (searchBooks must not call getFullMetadata). If you have custom provider, follow the snippet+getFullMetadata pattern.
- Missing fields in Audiobookshelf? Check `author` (string) and `series` array-of-objects format.
- Admin UI not saving? Check that `config` directory is writable and mounted if running in Docker.

---

## Development & testing

- For development, use a `docker-compose.override.yml` to mount source and run nodemon (recommended).
- Run tests locally:
```bash
npm ci
npm run test
```

---

## CI / Release tips

- Add repository secrets for the registry (Docker Hub / GHCR).
- The included GitHub Actions workflow builds multi-arch images and pushes tags; adjust `IMAGE_NAME` to your registry namespace.

---

## Contributing

- Follow existing code style.
- When adding a provider:
  - Implement `searchBooks(query, author, lang)` → return snippet objects
  - Implement `getFullMetadata(snippet)` → return full normalized metadata (ABS shape)
  - Avoid performing detail-page fetches inside `searchBooks`

---

If you want, I can:
- Add a short `docker-compose.dev.yml` for local development (source mounts + nodemon).
- Produce a minimal `example-config.json` with recommended default `mergePreferences`.
- Add README badges for build/CI status and Docker image.
