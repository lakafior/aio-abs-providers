# Config file

Everything needed to build a settings form for the backbone without reading its code.

- The file is one JSON document, UTF-8. Its location is `CONFIG_PATH` (default: `src/config/config.json` next to the code).
- `src/contract/schema.json` (JSON Schema draft-07) is the authority: the backbone validates the file with it on every load and on every save through `PUT /admin/config`. Unknown keys are rejected, except inside a provider's `extra` and inside `mergePreferences`.
- `src/contract/providers.meta.json` lists the sources: label, what they return, the values `language` may take and their `extra` settings. It is a static file, readable while the backbone is not running. `GET /admin/providers/meta` serves the same list.
- `src/config/config.json` is the default config; the backbone copies it to `CONFIG_PATH` when no file exists there.

## Who may write it, and when

Any process may rewrite the file at any time, whether the backbone runs or not.

- Write the whole document to a temporary file in the same folder and rename it over the config, so the backbone never reads half a file.
- A running backbone checks the file's modification time and size at most once a second, on the next request, and switches to the new config for the searches that follow. No restart and no signal is needed.
- A file that is not JSON or does not match the schema is ignored: the backbone keeps the last good config and `GET /healthz` answers with `"configError": "invalid config on disk, previous one in use"` until the file is fixed.
- At start an invalid file is fatal: the process prints `Failed to load config, exiting: ...` and exits with code 1.
- Missing optional keys get the defaults below.

## Shape

```json
{
  "providers": {
    "<provider name>": { "enabled": true, "priority": 10, "language": "pl", "maxResults": 3, "concurrency": 3, "timeoutMs": 10000, "extra": {} }
  },
  "global": {
    "allowBooks": true,
    "allowAudiobooks": true,
    "titleWeight": 60,
    "similarityThreshold": 75,
    "searchTimeoutMs": 9000,
    "maxProvidersParallel": 3,
    "mergeBestResults": true,
    "mergeDebug": false,
    "mergePreferences": { "cover": "audioteka", "series": "lubimyczytac", "tags": null }
  }
}
```

`providers` is required; `global` may be left out.

## Global settings (`global`)

| Key | Type | Range | Schema default | Shipped config | Meaning |
|---|---|---|---|---|---|
| `allowBooks` | boolean | | `true` | `true` | Return printed books and ebooks. |
| `allowAudiobooks` | boolean | | `true` | `true` | Return audiobooks. |
| `titleWeight` | integer | 0–100 | `60` | `60` | When the caller names an author: share of the title in the similarity score, in percent; the author gets the rest. Without an author only the title counts. |
| `similarityThreshold` | integer | 0–100 | `30` | `75` | Results scoring below this percentage are dropped, and their detail pages are never fetched. Higher = fewer, surer results and less load on the sources. |
| `searchTimeoutMs` | integer | 1000–60000 | `9000` | `9000` | Time limit of one whole search in milliseconds. Sources that have not answered are left out. Audiobookshelf gives up after 10000. |
| `maxProvidersParallel` | integer | ≥ 1 | `5` | `3` | How many sources are asked at the same time. |
| `mergeBestResults` | boolean | | `false` | `true` | Put one combined result first, built from the best result and the others that describe the same thing: same score, same title, same kind (audiobook or book) and an author in common. |
| `mergeDebug` | boolean | | `false` | – | Log which source each field of the combined result came from. |
| `mergePreferences` | object | | – | see file | For the combined result: field name → name of the source to take that field from, or `null` for "whichever has it" (the source with the highest `priority` first). |

### `mergePreferences` keys

Each value is a provider name or `null`.

| Key | Field of the combined result |
|---|---|
| `title`, `subtitle`, `authors`, `narrator`, `description`, `cover`, `publisher`, `duration`, `rating`, `url`, `source` | that field |
| `publishedYear` | year of publication |
| `language` | main language |
| `series` | series name together with the volume number |
| `isbn`, `asin` | that identifier; when unset, `identifiers` decides |
| `identifiers` | fallback for `isbn` and `asin` |
| `genres`, `tags` | the whole list from that source; with `null` the lists of all sources are joined |
| `seriesIndex` | accepted for old files, has no effect (the number travels with `series`) |

## Per-source settings (`providers.<name>`)

Provider names are fixed: `lubimyczytac`, `audioteka`, `storytel`, `audible`. A name that is not a folder under `src/` is logged and skipped.

| Key | Type | Range | Default | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | | required | Ask this source. |
| `priority` | integer | ≥ 0 | `0` | Among results with the same score the higher priority goes first, and wins fields in the combined result. |
| `language` | string | see below | source-specific | Which store or market of the source to search. |
| `maxResults` | integer | ≥ 0 | `0` | Keep only this many best-scoring results of the source; `0` = no limit. |
| `concurrency` | integer | ≥ 1 | `3` | Detail pages of this source fetched at the same time. |
| `timeoutMs` | integer | ≥ 100 | `10000` | Time limit of each request to the source, in milliseconds. |
| `extra` | object | | `{}` | Source-specific settings, below. |

### Sources

| Name | Label | Returns | `language` values | What `language` means | `extra` |
|---|---|---|---|---|---|
| `lubimyczytac` | Lubimy Czytać | books, audiobooks | `pl` | only Polish exists | – |
| `audioteka` | Audioteka | audiobooks | `pl`, `cz`, `de` | the Audioteka store | `addLinkToDescription` (boolean, default `true`; the shipped config sets `false`): start the description with a link to the Audioteka page |
| `storytel` | Storytel | books, audiobooks | `en`, `pl`, `de`, `sv`, `da`, `fi`, `fr`, `nl`, `es`, `pt`, `it`, `is`, `bg`, `ar`, `he`, `hi` | the Storytel market | – |
| `audible` | Audible | audiobooks | `us`, `uk`, `de`, `fr`, `it`, `es`, `ca`, `au`, `in`, `jp` | the Audible store (a region, not a language; there is no Polish store) | – |

What each source can supply:

| Field | lubimyczytac | audioteka | storytel | audible |
|---|---|---|---|---|
| title, author, description, cover | yes | yes | yes | yes |
| narrator, duration (minutes) | no | yes | yes (audiobooks) | yes |
| series with volume number | yes | no (collections become tags) | yes | yes |
| genres | yes | yes | yes | yes |
| tags | yes | collections | no | sub-genres |
| publisher | yes | yes | yes | yes |
| year | first Polish edition | no | this edition | this edition |
| language | `pol`, `eng` | `polish`, `czech`, `german` | `pl`, `en`, … | `english`, … |
| ISBN | yes | German store | yes (real ISBNs only) | no |
| original title (`originalTitle`) | yes | no | no | no |
| ASIN | no | no | no | yes |

## A form that covers it

Per source: a switch (`enabled`), a language picker fed from `providers.meta.json`, `priority`, `maxResults`; `concurrency` and `timeoutMs` belong under "advanced". For Audioteka one more switch (`extra.addLinkToDescription`).

Global: two switches (books, audiobooks), two sliders 0–100 (`titleWeight`, `similarityThreshold`), a switch for `mergeBestResults` and, when it is on, one source picker per `mergePreferences` key with an "automatic" entry that writes `null`. `searchTimeoutMs`, `maxProvidersParallel` and `mergeDebug` are advanced.

Keep keys the form does not show when rewriting the file.
