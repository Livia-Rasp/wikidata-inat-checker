# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
node checkImages.js 500       # image checker — custom limit
node checkImages.js 500 VU    # optional second arg: filter by IUCN status (VU, CR, EN, NT, DD, EX, EW, LC, NE)
npm run images -- 500         # same via npm (-- required to forward args)
npm run images -- 500 VU      # same with IUCN filter

node checkNames.js 500        # vernacular names checker — custom limit
node checkNames.js 500 CR     # with IUCN filter
npm run names -- 500          # same via npm
npm run names -- 500 CR       # same with IUCN filter

node checkLinks.js 200        # iNat links checker — custom limit
node checkLinks.js 200 EN     # with IUCN filter
npm run links -- 200          # same via npm
npm run links -- 200 EN       # same with IUCN filter
```

No build step, no tests. Outputs are `drafts.html`, `names.html`, `links.html`, and `inat-links-conflicts.json` (all gitignored).

Each workflow maintains a local cache file (`cache-images.json`, `cache-names.json`, `cache-links.json`, all gitignored) that records previously checked entries so re-runs skip the iNat API for already-scanned taxa. Delete a cache file to force a full re-scan.

## Architecture

Three independent tools sharing some modules. All data flows in memory — no intermediate files.

### Image checker (`checkImages.js`)
```
checkImages.js
  └─ SPARQL → Wikidata: taxa with P3151 (iNat ID) but no P18 (image)
       └─ getFromInat.js: iNat /v1/observations/species_counts
            → { available, inatTaxonIds }
       └─ generateWikitext.js: Wikidata wbgetentities ancestor traversal
            → { [wdUri]: wikitextString }
       └─ generateHTML.js: writes drafts.html
```

### Vernacular names checker (`checkNames.js`)
```
checkNames.js
  └─ SPARQL → Wikidata: all taxa with P3151
       └─ generateWikitext.js (fetchEntities): Wikidata P225 + P1843 per item
       └─ getInatNames.js: iNat /v1/taxa?all_names=true → names per taxon
       └─ diff: iNat names absent from Wikidata P1843 (case-insensitive, scientific name excluded)
       └─ generateNamesHTML.js: writes names.html with QuickStatements snippets + aggregate field
```

### iNat links checker (`checkLinks.js`)
```
checkLinks.js
  └─ SPARQL → Wikidata: taxa with P225 but no P3151 (limited)
  └─ getInatTaxaDb.js: SQLite-backed taxa index (~124 MB, built from iNat open-data S3 dump)
       → {get(name)} returning {inatId, rank} | undefined (undefined = not found or homonym)
  └─ SPARQL → Wikidata: check found iNat IDs for existing P3151 on other items
  └─ SPARQL → Wikidata: P13177 (homonymous taxon) check to filter false conflicts
  └─ generateLinksHTML.js: writes links.html + inat-links-conflicts.json
```

**`generateWikitext.js`** — exports `fetchEntities(qids)` and `chunk(arr, n)` used by multiple tools. Also fetches Wikidata entities in rounds (max 7), walking P171 (parent taxon) links for the image checker. Builds Commons category Wikitext including `{{Wikidata Infobox}}`, `{{Taxonavigation}}`, and identifier templates (NCBI, EOL, MycoBank, Index Fungorum). At startup, `fetchTaxonavTemplates()` fetches the full list of ~900 templates from [Category:Templates to include in Taxonavigation](https://commons.wikimedia.org/wiki/Category:Templates_to_include_in_Taxonavigation) (including subcategories) on Commons. The `{{Taxonavigation}}` `include=` parameter is set to the **most specific ancestor** whose name matches a template in that list — order-level for insects (e.g. `Hemiptera`, `Coleoptera`) or class-level for fungi (e.g. `Agaricomycetes`). Only ranks below the include= level are listed manually (Subclassis, Ordo, Familia as applicable). `fetchNcbiAuthorities()` calls the NCBI efetch API (`eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=taxonomy`) to populate `authority=` from the `OtherNames` authority entry; strips the taxon-name prefix using NCBI's own `ScientificName` word count (handles reclassified species where the original genus differs). `buildWikitext` is rank-aware: species get `Genus|…|` + `Species|…|`; genus-rank items get `Genus|…|` only; family/order/class items get the appropriate `RANK_LABELS` label (`Familia|…|`, `Ordo|…|`, etc.) with no Genus or Species lines. The `[[Category:…]]` line uses the immediate Wikidata parent (P171) as the parent category for non-species ranks. `{{VN}}` is included only when the item has at least one P1843 vernacular name. Fungorum template is rank-sensitive: `{{Fungorum genus}}` for Q34740, `{{Fungorum species}}` otherwise.

**`getFromInat.js`** — batches 200 iNat taxon IDs per request to `/v1/observations/species_counts`, token-bucket rate-limited to ~1 req/s. Returns taxa that have at least one research-grade photo with CC0/CC-BY/CC-BY-SA license.

**`getInatNames.js`** — batches 30 iNat taxon IDs per request to `/v1/taxa?all_names=true`, rate-limited to ~1 req/s. Normalizes `zh-CN`→`zh-hans`, `zh-TW`→`zh-hant` (Wikidata uses lowercase script subtags). Filters invalid and scientific-name entries.

**`getInatTaxaDb.js`** — maintains a SQLite taxa index at `~/.cache/wikidata-inat-checker/taxa.db` (~124 MB). On first use (or when the TSV is newer than the DB), downloads `taxa.csv.gz` from the iNat open-data S3 bucket (~180 MB uncompressed, ~1.4 M active taxa, monthly cadence) to `taxa.csv.gz` in the same directory, then builds the SQLite DB in a single transaction. The DB is re-downloaded if the TSV is older than 30 days and rebuilt whenever the TSV is newer than the DB. Schema: `taxa(taxon_id PK, name, rank)` with an index on `name` (for name lookups) and the implicit primary-key index on `taxon_id` (for future use). Returns `{get(name)}` — a `LIMIT 2` query: if exactly 1 row matches, returns `{inatId, rank}`; otherwise `undefined` (covers both not-found and homonym ambiguity).

**`getInatLinks.js`** — searches iNat `/v1/taxa?q={name}` per scientific name. Exact match only; returns null for zero or multiple matches (ambiguous). `pLimit(1)` + 1000 ms token bucket = 1 req/s sustained. Retries up to 3× on HTTP 429, honouring the `Retry-After` header. No longer used by `checkLinks.js` (superseded by `getInatTaxaDb.js`) but kept for potential one-off use.

**`generateHTML.js`** — generates `drafts.html` with a table: done-checkbox (localStorage-persisted), Wikidata link, filtered iNat observations link, Commons category edit link, and click-to-copy draft Wikitext.

**`generateNamesHTML.js`** — generates `names.html` with a table: done-checkbox, Wikidata link, taxon name, iNat taxon link, missing name list, and click-to-copy QuickStatements block. Each QS statement includes S248 (iNaturalist, Q16958215), S854 (taxon URL), and S813 (run date). An aggregate field above the table collects QS from all checked rows.

**`generateLinksHTML.js`** — generates `links.html` with a QuickStatements table for clean P3151 matches (no references — the ID is self-sourcing) and a conflict table for iNat IDs already held by different Wikidata items. Also writes `inat-links-conflicts.json` for bookkeeping. Same aggregate field pattern as names.

## Key Wikidata properties used

| Property | Meaning |
|---|---|
| P3151 | iNaturalist taxon ID |
| P18 | image (absence is the filter) |
| P171 | parent taxon (ancestor traversal) |
| P105 | taxon rank |
| P225 | taxon name |
| P685 | NCBI taxonomy ID |
| P830 | Encyclopedia of Life ID |
| P962 | MycoBank taxon name ID |
| P1391 | Index Fungorum taxon ID |
| P141 | IUCN conservation status (adds Commons IUCN category; Least Concern Q211005 is omitted) |
| P1843 | vernacular name (monolingualtext) |
| P13177 | homonymous taxon (used to filter false P3151 conflicts) |

Rank QIDs used for `RANK_LABELS` mapping (Taxonavigation intermediate ranks): `Q34740` = genus, `Q35409` = family, `Q2136103` = superfamily, `Q164280` = subfamily, `Q227936` = tribe, `Q3965313` = subtribe, `Q36602` = order, `Q5867051` = subclass, `Q37517` = class.

iNaturalist Wikidata item: Q16958215 (used as S248 source in P1843 references).
