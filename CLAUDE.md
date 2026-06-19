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
node checkLinksStats.js       # stats mode: fetch ALL taxa without P3151, print IUCN breakdown (no HTML output)
npm run linkStats             # same via npm

node checkArea.js 48.147 11.589 10   # area checker — lat lng radius_km
npm run area -- 48.147 11.589 10     # same via npm
```

No build step, no tests. Outputs are `drafts.html`, `names.html`, `links.html`, `links-ambiguous.html`, `area.html`, and `inat-links-conflicts.json` (all gitignored).

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
       → {getAll(name)} returning [{inatId, rank}] for all active taxa sharing the name
  └─ Ambiguous collection: names where get() returns undefined but getAll() finds 2+ taxa
       → ambiguousCandidates [{wdUri, qid, taxonName, candidates}]
  └─ SPARQL → Wikidata: check found iNat IDs for existing P3151 on other items
  └─ SPARQL → Wikidata: P13177 (homonymous taxon) check to filter false conflicts
  └─ getInatTaxaDb.js {getAncestors(inatId)}: ancestor chain from SQLite (no API call)
       → Map<inatId, [{name, rank}]>           (iNat taxonomy tree, kingdom-first)
  └─ SPARQL wdt:P171+ → Wikidata: full ancestor chain per matched + ambiguous item (batches of 50)
       → Map<qid, [{name, rankQid}]>           (Wikidata taxonomy tree, kingdom-first)
  └─ generateLinksHTML.js: writes links.html + inat-links-conflicts.json
  └─ generateAmbiguousHTML.js: writes links-ambiguous.html (grouped table, one row per iNat candidate)
```

### iNat links stats (`checkLinksStats.js`)

Two-phase fetch — one dedicated query per IUCN status code (CR/EN/VU/…, small result sets, exact counts) then LIMIT/OFFSET pagination (25 000 rows/page, TSV, 2 s inter-page delay) for taxa with no P141 at all. Classifies each name against the SQLite DB (match / ambiguous / no match). Prints a console table grouped by IUCN code in conservation-priority order. Warns and shows partial results if the no-status phase hits 429/504 at high offsets. No HTML output, no cache interaction.

```
checkLinksStats.js
  └─ sparqlTSV() → Wikidata: one query per IUCN status + paginated no-status query
  └─ getInatTaxaDb.js {get(), getAll()}: classify each name (match / ambig / no match)
  └─ console table output
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

## Module notes

**`generateWikitext.js`** — ancestor traversal fetches up to 20 rounds of wbgetentities; Lepidoptera needs this many due to ~15 unranked intermediate clades between species and kingdom. Fungorum template is rank-sensitive: `{{Fungorum genus}}` for Q34740 (genus), `{{Fungorum species}}` otherwise. Full taxonavigation template logic (Coleoptera/Lepidoptera wrappers, APG/IOC/Smith suffixes, IUCN template) is documented in README.

**`getInatNames.js`** — normalizes `zh-CN`→`zh-hans`, `zh-TW`→`zh-hant` (Wikidata uses lowercase script subtags).

**`getInatTaxaDb.js`** — SQLite index at `~/.cache/wikidata-inat-checker/taxa.db`, auto-refreshed from iNat S3 every 30 days. `get(name)` uses `LIMIT 2`: returns `{inatId, rank}` for exactly-one-match, `undefined` for no-match or homonym. `getAll(name)` returns all rows. `getAncestors(taxonId)` parses the slash-separated `ancestry` field (no API call), filters the `stateofmatter` root.

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
