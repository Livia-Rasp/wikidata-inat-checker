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

node checkArea.js 48.147 11.589 10   # area checker — lat lng radius_km
npm run area -- 48.147 11.589 10     # same via npm
```

No build step, no tests. Outputs are `drafts.html`, `names.html`, `links.html`, `area.html`, and `inat-links-conflicts.json` (all gitignored).

The image/names/links checkers each maintain a local cache file (`cache-images.json`, `cache-names.json`, `cache-links.json`, all gitignored) that records previously checked entries so re-runs skip the iNat API for already-scanned taxa. Delete a cache file to force a full re-scan. The area checker has no cache — results depend on the chosen location and live Wikidata state.

## Architecture

Four independent tools sharing some modules. All data flows in memory — no intermediate files.

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
  └─ getInatTaxaDb.js {getAncestors(inatId)}: ancestor chain from SQLite (no API call)
       → Map<inatId, [{name, rank}]>           (iNat taxonomy tree, kingdom-first)
  └─ SPARQL wdt:P171+ → Wikidata: full ancestor chain per matched item (batches of 50)
       → Map<qid, [{name, rankQid}]>           (Wikidata taxonomy tree, kingdom-first)
  └─ generateLinksHTML.js: writes links.html + inat-links-conflicts.json
```

### Area checker (`checkArea.js`)
```
checkArea.js (args: lat lng radius_km)
  └─ iNat /v1/observations/species_counts (paginated, location-filtered, research-grade)
       → [{taxonId, taxonName, commonName, count}]   (all species observed in area)
  └─ SPARQL VALUES → Wikidata: P3151 lookup + FILTER NOT EXISTS P18
       → Map<inatId, {wdUri, wdName}>                (items with no image)
  └─ iNat /v1/observations (batched 20 taxa/call, location-filtered, ordered by votes)
       → Map<taxonId, [{obsId, photoUrl}]>            (up to 3 sample photos each)
  └─ generateAreaHTML.js: writes area.html
```

**`generateWikitext.js`** — exports `fetchEntities(qids)` and `chunk(arr, n)` used by multiple tools. Also fetches Wikidata entities in rounds (max 20), walking P171 (parent taxon) links for the image checker. The higher limit (vs. the original 7) is needed because Lepidoptera sits ~15 levels above species due to many unranked intermediate clades. Builds Commons category Wikitext including `{{Wikidata Infobox}}`, a taxonavigation block, and identifier templates (NCBI, EOL, MycoBank, Index Fungorum). When the item has P627 (IUCN Red List taxon ID) and P141 (IUCN status), generates `{{IUCN|statusCode|iucnId|name|authority}}` placed after NCBI — this template auto-categorizes into the correct `IUCN X species` Commons maintenance category, so no manual category line is emitted. If P627 is absent but P141 is set to a non-LC status, a manual `[[Category:IUCN X species]]` line is emitted instead. At startup, `fetchTaxonavTemplates()` fetches the full list of ~900 templates from [Category:Templates to include in Taxonavigation](https://commons.wikimedia.org/wiki/Category:Templates_to_include_in_Taxonavigation) (including subcategories) on Commons. **Coleoptera get `{{Coleoptera|…}}`** and **Lepidoptera get `{{Lepidoptera|…}}`** (each detected when any ancestor has rank=order and the matching name); both templates accept named parameters (`familia=`, `subfamilia=`, `tribus=`, `genus=`, `species=` epithet-only, `auth=`; `subtribus=` is Coleoptera-only) and resolve the superfamily automatically — `include=` is never set manually. All other taxa use `{{Taxonavigation}}`: `fetchTaxonavTemplates()` builds a `Map<baseName, fullName>` so that suffixed family templates — `(APG)` for angiosperms (~418 families), `(IOC)` for birds (~258 families), `(Smith)` for ferns (~33 families) — are found by plain ancestor name and the full suffixed name is used as `include=` (e.g. `include=Asparagaceae (APG)`). Conifer families (plain names, e.g. `Cupressaceae`) and higher-level templates (`Angiosperms`, `Mammalia`) work the same as before. Only ranks below include= are listed manually. `fetchNcbiAuthorities()` calls the NCBI efetch API (`eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=taxonomy`) to populate `authority=` / `auth=` from the `OtherNames` authority entry; strips the taxon-name prefix using NCBI's own `ScientificName` word count (handles reclassified species where the original genus differs). `buildWikitext` is rank-aware: species get genus + species params; genus-rank items get genus only; family/order/class items get the appropriate `RANK_LABELS` label with no genus/species lines. The `[[Category:…]]` line uses the immediate Wikidata parent (P171) as the parent category for non-species ranks. `{{VN}}` is included only when the item has at least one P1843 vernacular name. Fungorum template is rank-sensitive: `{{Fungorum genus}}` for Q34740, `{{Fungorum species}}` otherwise.

**`getFromInat.js`** — batches 200 iNat taxon IDs per request to `/v1/observations/species_counts`, token-bucket rate-limited to ~1 req/s. Returns taxa that have at least one research-grade photo with CC0/CC-BY/CC-BY-SA license.

**`getInatNames.js`** — batches 30 iNat taxon IDs per request to `/v1/taxa?all_names=true`, rate-limited to ~1 req/s. Normalizes `zh-CN`→`zh-hans`, `zh-TW`→`zh-hant` (Wikidata uses lowercase script subtags). Filters invalid and scientific-name entries.

**`getInatTaxaDb.js`** — maintains a SQLite taxa index at `~/.cache/wikidata-inat-checker/taxa.db` (~124 MB). On first use (or when the TSV is newer than the DB), downloads `taxa.csv.gz` from the iNat open-data S3 bucket (~180 MB uncompressed, ~1.4 M active taxa, monthly cadence) to `taxa.csv.gz` in the same directory, then builds the SQLite DB in a single transaction. The DB is re-downloaded if the TSV is older than 30 days and rebuilt whenever the TSV is newer than the DB. `dbIsStale()` also triggers a rebuild if the `ancestry` column is missing (one-time schema migration for existing installs). Schema: `taxa(taxon_id PK, name, rank, ancestry)` with an index on `name`. Returns `{get(name), getAncestors(taxonId)}`. `get(name)` does a `LIMIT 2` query: if exactly 1 row matches, returns `{inatId, rank}`; otherwise `undefined` (covers not-found and homonym ambiguity). `getAncestors(taxonId)` parses the slash-separated `ancestry` field (ancestor taxon IDs, root-to-parent), looks each up by primary key, and returns `[{name, rank}, …]` kingdom-first, filtering out the `stateofmatter` root concept — no API call needed.

**`getInatLinks.js`** — searches iNat `/v1/taxa?q={name}` per scientific name. Exact match only; returns null for zero or multiple matches (ambiguous). `pLimit(1)` + 1000 ms token bucket = 1 req/s sustained. Retries up to 3× on HTTP 429, honouring the `Retry-After` header. No longer used by `checkLinks.js` (superseded by `getInatTaxaDb.js`) but kept for potential one-off use.

**`generateHTML.js`** — generates `drafts.html` with a table: done-checkbox (localStorage-persisted), Wikidata link, filtered iNat observations link, Commons category edit link, and click-to-copy draft Wikitext.

**`generateNamesHTML.js`** — generates `names.html` with a table: done-checkbox, Wikidata link, taxon name, iNat taxon link, missing name list, and click-to-copy QuickStatements block. Each QS statement includes S248 (iNaturalist, Q16958215), S854 (taxon URL), and S813 (run date). An aggregate field above the table collects QS from all checked rows.

**`generateLinksHTML.js`** — generates `links.html` with a QuickStatements table for clean P3151 matches (no references — the ID is self-sourcing) and a conflict table for iNat IDs already held by different Wikidata items. The matches table includes two taxonomy tree columns (WD tree / iNat tree) showing the full ancestor chain (kingdom→genus) side-by-side for quick verification that a matched pair actually refers to the same organism. WD rank QIDs are mapped to English labels for the known ranks; iNat rank strings are used directly. Also writes `inat-links-conflicts.json` for bookkeeping. Same aggregate field pattern as names.

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
| P141 | IUCN conservation status (QID); used with P627 to generate `{{IUCN}}` template, or as fallback category when P627 absent |
| P627 | IUCN Red List taxon ID (numeric); when present, generates `{{IUCN}}` template instead of manual IUCN category |
| P1843 | vernacular name (monolingualtext) |
| P13177 | homonymous taxon (used to filter false P3151 conflicts) |

Rank QIDs used for `RANK_LABELS` mapping (Taxonavigation intermediate ranks): `Q34740` = genus, `Q35409` = family, `Q2136103` = superfamily, `Q164280` = subfamily, `Q227936` = tribe, `Q3965313` = subtribe, `Q36602` = order, `Q5867051` = subclass, `Q37517` = class.

iNaturalist Wikidata item: Q16958215 (used as S248 source in P1843 references).
