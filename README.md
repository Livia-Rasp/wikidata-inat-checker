# wikidata-inat-checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

## How it works

1. Queries Wikidata via SPARQL for taxon items that have an iNaturalist taxon ID (P3151) but no image (P18). Writes the result to `inatIDsToDo.json`.
2. For each of those taxa, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. Taxa with a hit are recorded under `available` in `inattWDPhotoCache.json`; every checked taxon is recorded under `done` so re-runs skip work that's already been done.

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

The command runs the SPARQL query and the iNat check in a single pass. Outputs:

- `inatIDsToDo.json` — the Wikidata → iNat ID map produced by the SPARQL query.
- `inattWDPhotoCache.json` — the cache of `done` taxa and `available` Wikidata entities. Persists between runs; deleting it triggers a full rescan, otherwise only new/incomplete entries are queried.

The `available` keys are Wikidata entity URIs (e.g. `http://www.wikidata.org/entity/Q10732443`) — these are the items for which a Commons-compatible iNat photo exists and which currently lack a P18 image on Wikidata.

## License

ISC — see [LICENSE](LICENSE).
