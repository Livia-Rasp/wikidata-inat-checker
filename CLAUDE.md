# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
node checkImages.js 500    # image checker — custom limit
npm run images -- 500      # same via npm (-- required to forward arg)

node checkNames.js 500     # vernacular names checker — custom limit
npm run names -- 500       # same via npm

node checkLinks.js 200     # iNat links checker — custom limit
npm run links -- 200       # same via npm
```

No build step, no tests. Outputs are `drafts.html`, `names.html`, `links.html`, and `inat-links-conflicts.json` (all gitignored).

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
  └─ getInatLinks.js: iNat /v1/taxa?q={name} search, exact match, pLimit(4) at 4 req/s
       → Map<taxonName, {inatId, rank} | null>
  └─ SPARQL → Wikidata: check found iNat IDs for existing P3151 on other items
  └─ SPARQL → Wikidata: P13177 (homonymous taxon) check to filter false conflicts
  └─ generateLinksHTML.js: writes links.html + inat-links-conflicts.json
```

**`generateWikitext.js`** — exports `fetchEntities(qids)` and `chunk(arr, n)` used by multiple tools. Also fetches Wikidata entities in rounds (max 5), walking P171 (parent taxon) links for the image checker. Builds Commons category Wikitext including `{{Wikidata Infobox}}`, `{{Taxonavigation}}`, `{{VN}}`, and identifier templates (NCBI, EOL, MycoBank, Index Fungorum). Fungorum template is rank-sensitive: `{{Fungorum genus}}` for Q34740, `{{Fungorum species}}` otherwise.

**`getFromInat.js`** — batches 200 iNat taxon IDs per request to `/v1/observations/species_counts`, token-bucket rate-limited to ~1 req/s. Returns taxa that have at least one research-grade photo with CC0/CC-BY/CC-BY-SA license.

**`getInatNames.js`** — batches 30 iNat taxon IDs per request to `/v1/taxa?all_names=true`, rate-limited to ~1 req/s. Normalizes `zh-CN`→`zh-hans`, `zh-TW`→`zh-hant` (Wikidata uses lowercase script subtags). Filters invalid and scientific-name entries.

**`getInatLinks.js`** — searches iNat `/v1/taxa?q={name}` per scientific name. Exact match only; returns null for zero or multiple matches (ambiguous). `pLimit(2)` + 500 ms token bucket = 2 req/s sustained. Retries up to 3× on HTTP 429, honouring the `Retry-After` header.

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
| P1843 | vernacular name (monolingualtext) |
| P13177 | homonymous taxon (used to filter false P3151 conflicts) |

Rank QIDs: `Q34740` = genus, `Q35409` = family.

iNaturalist Wikidata item: Q16958215 (used as S248 source in P1843 references).
