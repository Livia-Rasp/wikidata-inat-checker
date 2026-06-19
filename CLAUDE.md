# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
node checkImages.js --limit 500 --iucn VU   # image checker (--limit, --iucn optional)
npm run images -- --limit 500 --iucn VU     # same via npm (-- required to forward flags)

node checkNames.js --limit 500 --iucn CR    # vernacular names checker (zero-P1843 taxa only by default)
node checkNames.js --limit 500 --all        # include taxa that already have some P1843
npm run names -- --limit 500 --iucn CR      # same via npm
npm run names -- --limit 500 --all          # same with --all flag

node checkLinks.js --limit 200 --iucn EN          # iNat links checker (--limit, --iucn optional)
node checkLinks.js --limit 200 --auto             # also write links-auto.qs (certain matches only)
npm run links -- --limit 200 --iucn EN            # same via npm
npm run links -- --limit 200 --auto               # same with --auto flag
node checkLinksStats.js                           # stats mode: per-IUCN match/ambig/no-match breakdown for all taxa without P3151 (no HTML output)
npm run linkStats                                 # same via npm

node checkArea.js --lat 48.147 --lng 11.589 --radius 10   # area checker (all three required)
npm run area -- --lat 48.147 --lng 11.589 --radius 10     # same via npm
```

No build step, no tests. Outputs are `drafts.html`, `names.html`, `links.html`, `links-ambiguous.html`, `links-auto.qs`, `area.html`, and `inat-links-conflicts.json` (all gitignored).

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
  └─ getInatTaxaDb.js: SQLite-backed taxa index (~124 MB, built from iNat open-data S3 dump)
       → {get(name)} returning {inatId, rank} | undefined (undefined = not found or homonym)
       → {getAll(name)} returning [{inatId, rank}] for all active taxa sharing the name
       → {allNames()} returning all distinct iNat names (drives the Wikidata query)
  └─ utils.fetchWdTaxaByNames() → Wikidata: query BY iNat name in VALUES POST batches
       → taxa with P225 = an iNat name but no P3151 (IUCN via OPTIONAL, JS-filtered)
       → --limit caps collected candidates (real matches), not raw taxa scanned
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

Two phases, both reliable to completion. (1) Exact per-IUCN-status totals from CirrusSearch (`cirrusCount()`) — WDQS times out merely *counting* the ~3 M no-P3151 set. (2) Match/ambig by querying Wikidata BY iNat name (`fetchWdTaxaByNames()`, VALUES POST batches over the full ~1.4 M-name index, ~20 min). No-match is derived as `total − match − ambig`. Prints a console table grouped by IUCN code in conservation-priority order. No HTML output, no cache interaction.

```
checkLinksStats.js
  └─ getInatTaxaDb.js {allNames(), get(), getAll()}: name universe + classification
  └─ utils.cirrusCount() → Wikidata CirrusSearch: exact total per IUCN bucket (instant)
  └─ utils.fetchWdTaxaByNames() → Wikidata: match/ambig via name-keyed VALUES POST batches
  └─ console table output (No match = total − match − ambig)
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

See [`docs/dev.md`](docs/dev.md) for implementation details — read it on demand when working on the relevant modules:
- **SQLite taxa index** — schema, `get()`/`getAll()`/`getAncestors()` behaviour, stateofmatter filter (`getInatTaxaDb.js`)
- **zh-hans/zh-hant normalization** — why `zh-CN`/`zh-TW` are remapped (`getInatNames.js`)
- **Ancestor traversal depth** — why the cap is 20 rounds; Lepidoptera unranked clades (`generateWikitext.js`)
- **Commons Taxonavigation templates** — Coleoptera/Lepidoptera wrappers, APG/IOC/Smith suffixed families, Fungorum rank sensitivity, IUCN Commons category names and QIDs, category placement rules (`generateWikitext.js`)
- **SPARQL TSV format** — why `wbk.sparqlQuery()` must not be used for TSV requests (`utils.js`)
- **Large-dataset enumeration** — why WDQS can't scan the ~3 M no-P3151 set (even COUNT), CirrusSearch counts, and the query-by-iNat-name (`VALUES` POST) inversion (`utils.js`, `checkLinksStats.js`, `checkLinks.js`)
- **Taxonomy tree comparison and `--auto` filter** — `compareAncestorTrees()` rank-alignment logic, certainty filter rationale, Noctuidae/Erebidae recurring disagreement (`utils.js`, `checkLinks.js`)

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
