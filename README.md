# wikidata-inat-checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

## How it works

1. Queries Wikidata via SPARQL for taxon items that have an iNaturalist taxon ID (P3151) but no image (P18).
2. For each of those taxa, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
3. For each taxon with a hit, queries Wikidata for taxon name, NCBI/EOL/MycoBank/Index Fungorum identifiers, Wikispecies page, and taxonomy (class through genus) and generates a draft Commons category Wikitext.
4. Exports all drafts to `drafts.html` — a table with five columns: a done checkbox, a Wikidata item link, a filtered iNaturalist observations link, a Commons category edit link, and the draft Wikitext. Clicking the draft text copies it to the clipboard.

iNat queries are batched via the `/v1/observations/species_counts` endpoint (up to 50 taxa per request), so a 5000-taxon scan takes about a minute while staying within iNat's recommended ~1 request/second rate. The number of taxa per run is configurable — see [Usage](#usage).

Results are cached locally in `cache-images.json` so re-runs skip taxa already checked in a prior session. Delete the file to force a full re-scan.

## Installation

Requires Node.js 18+ (for the global `fetch`).

```sh
git clone https://github.com/Livia-Rasp/wikidata-inat-checker.git
cd wikidata-inat-checker
npm install
```

## Usage

```sh
npm run images            # default: 5000 taxa
npm run images -- 500     # custom limit
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
| Draft Wikitext | Click to copy to clipboard. Includes `{{Wikidata Infobox}}`, `{{Taxonavigation}}` (with `include=` set to the most specific available ancestor template — order-level for insects, e.g. `include=Hemiptera`; class-level for fungi, e.g. `include=Agaricomycetes` — chosen dynamically from the live Commons template list; intermediate ranks Subclassis/Ordo/Familia are listed only for ranks below the include= level), `{{VN}}` (only when the Wikidata item has at least one vernacular name, P1843), NCBI/EOL/MycoBank/Index Fungorum identifiers (whichever are present on the Wikidata item), and the parent category link. Fill in `authority=` manually if needed. |

## Typical workflow

1. Run `npm run images` to scan Wikidata and iNat.
2. Open `drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy), fill in `authority=` if known, and save.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.
5. Check the row's checkbox to mark it done. Use **Hide done** to keep the list tidy.

---

## Vernacular names checker

A separate tool that finds iNaturalist vernacular names (common names in any language) that are missing from Wikidata taxon items (P1843).

### How it works

1. Queries Wikidata for taxon items that have an iNaturalist taxon ID (P3151).
2. Fetches their existing P1843 claims from Wikidata.
3. Fetches all vernacular names from iNaturalist (`all_names=true`), filtering out invalid entries, scientific-name-locale entries, and names that duplicate the taxon's scientific name.
4. Compares the two sets (case-insensitive). Names present in iNat but absent from Wikidata are reported.
5. Exports `names.html` — a table with QuickStatements snippets for batch-importing missing names.

Results are cached locally in `cache-names.json` so re-runs skip taxa already checked. Delete the file to force a full re-scan.

### Usage

```sh
npm run names            # default: 5000 taxa
npm run names -- 500     # custom limit
```

### names.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done (localStorage-persisted). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| iNat taxon | Link to the iNaturalist taxon page. |
| Missing names | Language code + name for each name iNat has but Wikidata doesn't. |
| QuickStatements | Click to copy a tab-separated block ready to paste into [QuickStatements](https://quickstatements.toolforge.org/). Each statement includes a source reference: stated in iNaturalist (P248), the taxon URL (P854), and today's date as retrieved (P813). |

### Typical workflow

1. Run `npm run names -- 500` to generate `names.html`.
2. Open `names.html` in a browser.
3. Review rows and check off items you want to import. An aggregate QuickStatements field appears above the table and accumulates all checked rows — click it to copy everything in one go.
4. Paste into [QuickStatements](https://quickstatements.toolforge.org/) and run.
5. Use **Hide done** to keep the list tidy.

---

## iNaturalist links checker

A separate tool that finds Wikidata taxon items with no iNaturalist taxon ID (P3151) at all, searches iNaturalist by scientific name to find the matching taxon, and produces QuickStatements to add the missing link.

### How it works

1. Queries Wikidata for taxon items that have a scientific name (P225) but no P3151.
2. Searches iNaturalist by scientific name for each taxon (exact match only; ambiguous or zero results are skipped).
3. Checks whether any found iNat ID is already linked to a *different* Wikidata item — potential mismatch.
4. Filters out apparent conflicts where the two Wikidata items are known homonyms (linked by P13177).
5. Exports `links.html` — QuickStatements to add P3151 for clean matches, plus a conflict table for cases needing manual investigation.
6. Writes `inat-links-conflicts.json` — machine-readable bookkeeping of all conflicts found, for raising with the Wikidata community if needed.

The default limit is 200 taxa (each taxon = one iNat search request at 1 req/s; 200 taxa takes roughly 3–4 minutes). Results are cached locally in `cache-links.json` so re-runs skip taxa already searched. Delete the file to force a full re-scan.

### Usage

```sh
npm run links            # default: 200 taxa
npm run links -- 500     # custom limit
```

### links.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done (localStorage-persisted). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| iNat taxon | Link to the iNaturalist taxon page. |
| QuickStatements | Click to copy. Adds P3151 with the iNat taxon ID. |

An aggregate field above the table accumulates QuickStatements from all checked rows for batch copying.

The conflict table below (shown only when conflicts exist) lists iNat IDs found by name-search that are already linked to a different Wikidata item. These need manual investigation before importing.

### Typical workflow

1. Run `npm run links -- 200` to generate `links.html`.
2. Open `links.html` in a browser.
3. Review the matches — spot-check a few taxon names against the iNat page to confirm correctness.
4. Check rows you want to import. Copy the aggregate field and paste into [QuickStatements](https://quickstatements.toolforge.org/).
5. If a conflict table is present, review `inat-links-conflicts.json` and investigate each case before acting.

## License

ISC — see [LICENSE](LICENSE).
