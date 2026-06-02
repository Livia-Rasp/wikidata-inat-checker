# wikidata-inat-checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

## How it works

1. Queries Wikidata via SPARQL for taxon items that have an iNaturalist taxon ID (P3151) but no image (P18).
2. For each of those taxa, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
3. For each taxon with a hit, queries Wikidata for taxon name, NCBI/EOL/MycoBank/Index Fungorum identifiers, Wikispecies page, and taxonomy (genus, family) and generates a draft Commons category Wikitext.
4. Exports all drafts to `drafts.html` — a table with five columns: a done checkbox, a Wikidata item link, a filtered iNaturalist observations link, a Commons category edit link, and the draft Wikitext. Clicking the draft text copies it to the clipboard.

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

A single run produces one output file:

| File | Description |
|---|---|
| `drafts.html` | Human-readable overview of all drafts. See below for column details. |

### drafts.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done. State persists in `localStorage` across page reloads. Use the **Hide done** button to collapse completed rows. |
| Wikidata item | Link to the Wikidata entity (e.g. `Q15438811`). |
| iNat taxon | Link to the filtered iNaturalist observations page for that taxon (research-grade, CC0/CC-BY/CC-BY-SA), so you can preview candidate photos without a separate lookup. |
| Commons category | Opens the Commons category page in edit mode — ready to paste if it doesn't exist yet, or to edit if it does. |
| Draft Wikitext | Click to copy to clipboard. Includes `{{Wikidata Infobox}}`, `{{Taxonavigation}}`, `{{VN}}`, NCBI/EOL/MycoBank/Index Fungorum identifiers (whichever are present on the Wikidata item), and the parent category link. Fill in `authority=` manually if needed. |

## Typical workflow

1. Run `npm start` to scan Wikidata and iNat.
2. Open `drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy), fill in `authority=` if known, and save.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.
5. Check the row's checkbox to mark it done. Use **Hide done** to keep the list tidy.

## License

ISC — see [LICENSE](LICENSE).
