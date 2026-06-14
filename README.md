# wikidata-inat-checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

## How it works

1. Queries Wikidata via SPARQL for taxon items that have an iNaturalist taxon ID (P3151) but no image (P18).
2. For each of those taxa, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
3. For each taxon with a hit, queries Wikidata for taxon name, NCBI/EOL/MycoBank/Index Fungorum identifiers, Wikispecies page, and taxonomy (class through genus) and generates a draft Commons category Wikitext.
4. Exports all drafts to `drafts.html` — a table with five columns: a done checkbox, a Wikidata item link, a filtered iNaturalist observations link, a Commons category edit link, and the draft Wikitext. Clicking the draft text copies it to the clipboard.

iNat queries are batched via the `/v1/observations/species_counts` endpoint (up to 200 taxa per request), so a 5000-taxon scan takes about a minute while staying within iNat's recommended ~1 request/second rate. The number of taxa per run is configurable — see [Usage](#usage).

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
npm run images -- 500 VU  # limit + IUCN status filter (VU, EN, CR, NT, DD, EX, EW, LC, NE)
```

The first argument is passed to the SPARQL `LIMIT` clause, controlling how many image-less taxa are fetched from Wikidata. The optional second argument filters by IUCN conservation status (P141), which is useful for prioritising threatened species. Note the `--` separator — it's required so npm forwards the values to the script rather than interpreting them itself.

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
| Draft Wikitext | Click to copy to clipboard. Includes `{{Wikidata Infobox}}`, a taxonavigation block, `{{VN}}` (only when P1843 vernacular names are present), NCBI/EOL/MycoBank/Index Fungorum identifier templates, an optional `{{IUCN}}` conservation status link, and the parent category link. Details: **Taxonavigation** — Coleoptera taxa use `{{Coleoptera\|familia=…\|…}}` and Lepidoptera taxa use `{{Lepidoptera\|familia=…\|…}}` (dedicated wrapper templates with named params for family through species and authority; superfamily resolved automatically). All other taxa use `{{Taxonavigation\|include=…}}` with the most specific matching ancestor template from Commons: angiosperm families use the `(APG)` suffixed form (e.g. `include=Asparagaceae (APG)`), bird families the `(IOC)` form, fern families the `(Smith)` form; conifer families and higher-level groups (Mammalia, Reptilia, Agaricomycetes, …) use plain names. Only ranks below the include= level are listed manually. Rank-aware: species get `Genus|…|` + `Species|…|`, genus-rank items get `Genus|…|` only, family/order/class items use their rank label with no genus/species lines. `authority=` is populated automatically from NCBI (P685) where available. **IUCN** — when the Wikidata item has both P627 (IUCN Red List ID) and P141 (conservation status), a `{{IUCN\|code\|id\|name\|authority}}` line is added after NCBI; this template auto-categorizes the Commons page into the correct IUCN maintenance category. If only P141 is present (no P627), a manual `[[Category:IUCN X species]]` line is added instead. |

## Typical workflow

1. Run `npm run images` to scan Wikidata and iNat.
2. Open `drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy) and save.
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
npm run names -- 500 CR  # limit + IUCN status filter
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

A separate tool that finds Wikidata taxon items with no iNaturalist taxon ID (P3151) at all, matches them against iNaturalist's full taxonomy, and produces QuickStatements to add the missing link.

### How it works

1. Queries Wikidata for taxon items that have a scientific name (P225) but no P3151.
2. On first run, downloads the iNaturalist open-data taxa dump (~180 MB, 1.4 M active taxa) from the iNat S3 bucket and builds a local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~124 MB). The download is refreshed automatically every 30 days; the index is rebuilt whenever the download is newer.
3. Looks up each Wikidata scientific name in the SQLite index (no API calls). Names matching two or more active iNat taxa are treated as ambiguous and skipped.
4. Checks whether any found iNat ID is already linked to a *different* Wikidata item — potential mismatch.
5. Filters out apparent conflicts where the two Wikidata items are known homonyms (linked by P13177).
6. Exports `links.html` — QuickStatements to add P3151 for clean matches, plus a conflict table for cases needing manual investigation.
7. Writes `inat-links-conflicts.json` — machine-readable bookkeeping of all conflicts found, for raising with the Wikidata community if needed.

After the initial download and index build (~20 seconds), the tool runs in under a second regardless of how many taxa are checked. Results are cached locally in `cache-links.json` so re-runs skip taxa already processed. Delete the file to force a full re-scan.

### Usage

```sh
npm run links             # default: 200 taxa
npm run links -- 1000     # custom limit — fast even for large numbers
npm run links -- 1000 EN  # limit + IUCN status filter
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

1. Run `npm run links -- 1000` to generate `links.html` (first run downloads the taxa database; subsequent runs are instant).
2. Open `links.html` in a browser.
3. Review the matches — spot-check a few taxon names against the iNat page to confirm correctness.
4. Check rows you want to import. Copy the aggregate field and paste into [QuickStatements](https://quickstatements.toolforge.org/).
5. If a conflict table is present, review `inat-links-conflicts.json` and investigate each case before acting.

---

## Area checker

Finds Wikidata taxon items that lack an image (P18) among all species observed within a geographic radius. Useful for targeting a specific location — a nature reserve, a city, a field trip area — and identifying which local species still need photos on Wikidata.

### How it works

1. Queries iNaturalist for all species with research-grade, CC-licensed observations within the specified radius (`/v1/observations/species_counts` with `lat`, `lng`, `radius`). Paginates until all results are fetched.
2. For each iNat taxon ID found, queries Wikidata via a SPARQL VALUES lookup to find items where P3151 matches and P18 (image) is absent.
3. For each qualifying taxon, fetches up to 3 sample observations from the area (ordered by community votes), providing thumbnail photos to help assess upload candidates.
4. Exports `area.html` — a list of taxa with their Wikidata link, iNat taxon link, observation count in the area, and clickable photo thumbnails linking to the individual observations.

No cache — results reflect live Wikidata and iNat state at the time of the run.

### Usage

```sh
node checkArea.js <lat> <lng> <radius_km>
npm run area -- <lat> <lng> <radius_km>
```

Example (10 km around Munich city centre):

```sh
npm run area -- 48.147 11.589 10
```

### area.html layout

Each row shows:

| Element | Description |
|---|---|
| Taxon name | Scientific name (linked to iNat taxon page) and common name if available |
| Wikidata | QID link to the Wikidata item |
| Observation count | Number of research-grade CC-licensed observations in the area |
| Thumbnails | Up to 3 photos from the area; each links to the iNat observation page |

Rows are sorted by observation count descending (most-observed first).

### Typical workflow

1. Run `npm run area -- <lat> <lng> <radius>` to generate `area.html`.
2. Open `area.html` in a browser.
3. Browse the thumbnails to find a good candidate photo. Click the thumbnail to open the iNat observation, then upload the photo to Commons.
4. Add the uploaded file as P18 on the Wikidata item (linked from each row).

## License

ISC — see [LICENSE](LICENSE).
