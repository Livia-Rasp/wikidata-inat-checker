# wikidata-inat-checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

## How it works

1. Queries Wikidata via SPARQL for taxon items that have an iNaturalist taxon ID (P3151) but no image (P18). Writes the result to `inatIDsToDo.json`.
2. For each of those taxa, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. Taxa with a hit are recorded under `available` in `inattWDPhotoCache.json`; every checked taxon is recorded under `done` so re-runs skip work that's already been done.
3. For each available taxon, queries Wikidata for taxon name, NCBI/EOL identifiers, Wikispecies page, and taxonomy (genus, family) and generates a draft Commons category Wikitext, stored under `drafts` in `inattWDPhotoCache.json`.
4. Exports all drafts to `drafts.html` — a table with a link to the Wikidata item, a link to the (possibly not yet existing) Commons category, and the draft Wikitext. Clicking the draft text copies it to the clipboard.

iNat queries are batched via the `/v1/observations/species_counts` endpoint (up to 50 taxa per request), so a 5000-taxon scan takes about a minute while staying within iNat's recommended ~1 request/second rate. The number of taxa per run is configurable — see [Usage](#usage).

## Installation

Requires Node.js 18+ (for the global `fetch`).

```sh
git clone https://github.com/Livia-Rasp/wikidata-inat-checker.git
cd wikidata-inat-checker
npm install
```

## Usage

```sh
npm start            # default: 5000 taxa
npm start -- 500     # custom limit
```

The positional argument is passed to the SPARQL `LIMIT` clause, controlling how many image-less taxa are fetched from Wikidata. Note the `--` separator — it's required so npm forwards the value to the script rather than interpreting it itself.

A single run produces three output files:

| File | Description |
|---|---|
| `inatIDsToDo.json` | Wikidata → iNat ID map from the SPARQL query. |
| `inattWDPhotoCache.json` | Persistent cache of processed taxa (`done`), taxa with a matching iNat photo (`available`), and generated Wikitext drafts (`drafts`). Deleting it triggers a full rescan; partial runs resume from where they left off. |
| `drafts.html` | Human-readable overview of all drafts. Click any draft text to copy it to the clipboard. |

## Typical workflow

1. Run `npm start` to scan Wikidata and iNat.
2. Open `drafts.html` in a browser.
3. For each row: follow the Commons category link to check whether the category already exists. If not, click the draft text to copy it, create the category on Commons, and paste the draft as the page content. Fill in the `authority=` field if known.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.

## License

ISC — see [LICENSE](LICENSE).
