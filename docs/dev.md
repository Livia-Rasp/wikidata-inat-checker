# Developer notes

Implementation details for contributors and for Claude to read on demand when debugging or extending the tools.

## Module wiring

Each entry script wires shared modules together; all data flows in memory.

### Image checker (`checkImages.js`)
```
checkImages.js
  └─ getInatTaxaDb.js {allInatIds()}: all iNat taxon IDs (drives the Wikidata query)
  └─ utils.fetchWdTaxaByInatIds() → Wikidata: query BY iNat ID in VALUES POST batches
       → taxa with P3151 = a local iNat ID but no P18 (IUCN via OPTIONAL, JS-filtered)
       → --limit caps collected candidates; cached ids skipped to reach new taxa
  └─ getFromInat.js: iNat /v1/observations/species_counts → { available, inatTaxonIds }
  └─ generateWikitext.js: Wikidata wbgetentities ancestor traversal → { [wdUri]: wikitext }
  └─ generateHTML.js: writes drafts.html
```

### Vernacular names checker (`checkNames.js`)
```
checkNames.js
  └─ SPARQL → Wikidata: all taxa with P3151
       └─ generateWikitext.js (fetchEntities): Wikidata P225 + P1843 per item
       └─ getInatNames.js: iNat /v1/taxa?all_names=true → names per taxon
       └─ diff: iNat names absent from Wikidata P1843 (case-insensitive, scientific name excluded)
       └─ generateNamesHTML.js: writes names.html (QuickStatements + aggregate field)
```

### iNat links checker (`checkLinks.js`)
```
checkLinks.js
  └─ getInatTaxaDb.js: SQLite taxa index (~124 MB, built from iNat open-data S3 dump)
       → get(name) → {inatId, rank} | undefined   (undefined = not found or homonym)
       → getAll(name) → [{inatId, rank}]           (all active taxa sharing the name)
       → allNames() → all distinct iNat names       (drives the Wikidata query)
  └─ utils.fetchWdTaxaByNames() → Wikidata: query BY iNat name in VALUES POST batches
       → taxa with P225 = an iNat name but no P3151 (IUCN via OPTIONAL, JS-filtered)
       → --limit caps collected candidates (real matches), not raw taxa scanned
  └─ Ambiguous collection: names where get() is undefined but getAll() finds 2+ taxa
  └─ SPARQL → Wikidata: found iNat IDs already on other items (conflict detection)
  └─ SPARQL → Wikidata: P13177 (homonymous taxon) to filter false conflicts
  └─ getInatTaxaDb.getAncestors(inatId): iNat ancestor chain from SQLite (no API call)
  └─ utils.fetchWdAncestorChains() (wdt:P171+, batches of 50): Wikidata ancestor chain
  └─ generateLinksHTML.js: writes links.html + inat-links-conflicts.json
  └─ generateAmbiguousHTML.js: writes links-ambiguous.html (one row per iNat candidate)
```

### iNat links stats (`checkLinksStats.js`)
```
checkLinksStats.js
  └─ getInatTaxaDb.js {allNames(), get(), getAll()}: name universe + classification
  └─ utils.cirrusCount() → CirrusSearch: exact total per IUCN bucket (instant)
  └─ utils.fetchWdTaxaByNames() → Wikidata: match/ambig via name-keyed VALUES POST batches
  └─ console table (No match = total − match − ambig)
```

### Area checker (`checkArea.js`)
```
checkArea.js (args: --lat --lng --radius)
  └─ iNat /v1/observations/species_counts (paginated, location-filtered, research-grade)
       → [{taxonId, taxonName, commonName, count}]
  └─ SPARQL VALUES → Wikidata: P3151 lookup + FILTER NOT EXISTS P18
       → Map<inatId, {wdUri, wdName}>            (items with no image)
  └─ iNat /v1/observations (batched 20 taxa/call, ordered by votes): up to 3 sample photos each
  └─ generateAreaHTML.js: writes area.html
```

## iNat taxa SQLite index (`getInatTaxaDb.js`)

The local SQLite DB at `~/.cache/wikidata-inat-checker/taxa.db` has schema `taxa(taxon_id PK, name, rank, ancestry)` with an index on `name`. `get(name)` issues a `LIMIT 2` query: exactly one row → returns `{inatId, rank}`, two or more rows → returns `undefined` (homonym, treated the same as not-found). `getAll(name)` returns all matching rows and is used to surface the ambiguous cases. `getAncestors(taxonId)` parses the slash-separated `ancestry` field (ancestor IDs root-to-parent) and looks each up by primary key — no API call needed; filters out the `stateofmatter` root concept.

## Vernacular name language codes (`getInatNames.js`)

iNaturalist returns Chinese names under `zh-CN` and `zh-TW`. These are normalised to `zh-hans` and `zh-hant` respectively before comparison with Wikidata, because Wikidata uses lowercase script subtags for these languages.

## Genus-as-vernacular leak (`checkNames.js`)

iNaturalist sometimes stores the genus name itself as a vernacular name for a species in certain locales (e.g. `de:"Olyra"` for *Olyra longicaudata*). These pass through the scientific-name exclusion filter — which only strips the full binomial — unless explicitly checked. `checkNames.js` filters them by comparing each candidate name against the first word of the scientific name (`sciName.split(' ')[0]`).

## Taxonavigation ancestor traversal (`generateWikitext.js`)

The wbgetentities ancestor walk is capped at 20 rounds. This is higher than one might expect: Lepidoptera sits roughly 15 levels above species rank due to many unranked intermediate clades in the Wikidata taxonomy, so a lower cap would silently truncate the taxonavigation block for butterflies and moths.

## Commons Taxonavigation templates (`generateWikitext.js`)

Every Commons taxon category uses `{{Taxonavigation|include=X|Rank|Name|…}}`. The `include=` value names a template from [Category:Templates to include in Taxonavigation](https://commons.wikimedia.org/wiki/Category:Templates_to_include_in_Taxonavigation); that template renders everything above its level, so only ranks **below** `include=` are listed manually.

### Orders with dedicated wrapper templates

These bypass `{{Taxonavigation}}` entirely — use the wrapper directly:

| Wrapper | Group | Detection (Wikidata) | Notes |
|---|---|---|---|
| `{{Coleoptera\|familia=…\|…}}` | Beetles | ancestor P105=Q36602, P225="Coleoptera" | params: `familia`, `subfamilia`, `tribus`, `subtribus`, `genus`, `species` (epithet only), `auth` |
| `{{Lepidoptera\|familia=…\|…}}` | Butterflies & moths | ancestor P105=Q36602, P225="Lepidoptera" | same params minus `subtribus`; sits ~15 P171 levels above species (many unranked clades) |

`Coleoptera (include)` and `Lepidoptera (include)` are internal templates used by the wrappers — do not use them directly as `include=`.

### Family-level suffixed templates

| Group | Suffix | Example |
|---|---|---|
| Angiosperms (flowering plants) | `(APG)` | `Asparagaceae (APG)` |
| Birds (Aves) | `(IOC)` | `Corvidae (IOC)` |
| Ferns (Polypodiopsida) | `(Smith)` | `Polypodiaceae (Smith)` |

When a suffixed family template is used as `include=`, the manual chain starts at **subfamily** level — Ordo and Familia are rendered inside the included template and must not be repeated.

Conifers use plain-name family templates (`Cupressaceae`, `Pinaceae` — no suffix).

### Higher-level fallbacks (no family template exists)

Use the most specific ancestor that has a Commons template: `Reptilia`, `Amphibia`, `Mammalia`, `Actinopterygii`, `Agaricomycetes`, `Hemiptera`, `Angiosperms`, `Aves`, `Polypodiopsida`, etc.

### Fungorum templates

Two templates exist for Index Fungorum entries: `{{Fungorum genus}}` (rank = genus, Q34740) and `{{Fungorum species}}` (all other ranks). Using the wrong one miscategorises the Commons page.

### IUCN Commons categories

Species with IUCN status get `[[Category:IUCN X species]]`. LC (Q211005) has no Commons maintenance category and is omitted. Category names:

| P141 QID | Code | Commons category |
|---|---|---|
| Q219127 | CR | IUCN Critically endangered species |
| Q96377276 | EN | IUCN Endangered species |
| Q278113 | VU | IUCN Vulnerable species |
| Q719675 | NT | IUCN Near Threatened species |
| Q3245245 | DD | IUCN Data Deficient species |
| Q237350 | EX | IUCN Extinct species |
| Q239509 | EW | IUCN Extinct In The Wild species |

Note: "Critically **e**ndangered" is lowercase; "Extinct **I**n **T**he **W**ild" is mixed caps. The correct QID for Endangered is `Q96377276`, not `Q11394`.

### Category placement line

`[[Category:ParentName|sortKey]]` at the bottom is always required explicitly — the auto-categorisation inside wrapper/APG/IOC templates fires only for gallery pages, not category pages. For species: `[[Category:GenusName|epithet]]`. For genera and above: `[[Category:ImmediateParentName|taxonName]]`.

---

## SPARQL patterns (`utils.js`, `checkLinksStats.js`)

The endpoint is `https://query.wikidata.org/sparql` (Blazegraph). Since the May 2025 [WDQS graph split](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split) it serves the **main** subgraph (scholarly articles moved to a separate `query-scholarly` endpoint); taxon data is in the main graph, so the default endpoint is correct here. Always send a descriptive `User-Agent` — Wikidata blocks anonymous bots.

### TSV format for large result sets

Request TSV instead of JSON to avoid the ~7 MB JSON truncation limit and control-character parse errors:

```js
const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`;
const res = await fetch(url, { headers: { ...HEADERS, 'Accept': 'text/tab-separated-values' } });
```

**Critical:** do not use `wbk.sparqlQuery(query)` as the URL — it appends `format=json` which overrides the Accept header and returns JSON regardless. Use the raw endpoint URL with no `format=` param.

TSV parsing: header row has `?varName` columns; URI cells are `<http://…>`; literal cells are `"value"`. Strip BOM (`﻿`) from the first line.

### Large-dataset enumeration (WDQS can't scan these sets)

Two filtered sets are too big for WDQS to scan: taxa with `P225` and no `P3151` (**~2.94 M**, the links/stats target) and taxa with `P3151` and no `P18` (**~619 K**, the images target). WDQS/Blazegraph times out even on `SELECT (COUNT(*) …)` for either (65 s), as it does on a rank-restricted (`species` only) `ORDER BY`/keyset query. `LIMIT/OFFSET` re-scans from row 0 each page, so it dies at depth (429/504) and silently truncates. **Do not try to page these sets through WDQS.**

**WDQS approaches that don't work** (all measured against the live endpoint):
- `LIMIT/OFFSET` to cover the whole set → 429/504 at high offset; pages overlap/skip without `ORDER BY`; a 200 can return a truncated body
- `ORDER BY ?item` (even rank-restricted) → 504
- `FILTER(?item > wd:QN)` → 0 rows (IRI comparison unsupported); `BIND(xsd:integer(STRAFTER(…))) FILTER(?qnum > N)` → 504 on page 1
- `STRSTARTS(?taxonName, "A")` letter partitioning → full scan, no text index → slower than OFFSET
- adding `?item wdt:P141 wd:<qid>` to a large `VALUES`-by-name query → bad query plan → 504 (fetch P141 via `OPTIONAL`, filter in JS)

**What works — two complementary backends:**
1. **CirrusSearch (`cirrusCount()` in `utils.js`)** for exact counts. The MediaWiki search API (`list=search`, `haswbstatement:`/`-haswbstatement:`) is Elasticsearch-backed: it returns exact `totalhits` instantly and its negation partitions cleanly (WITH + WITHOUT a property sum to the total). Include `haswbstatement:P31=Q16521` to match "instance of taxon". It caps any single query at 10 000 results, so it is used for **counting**, not enumeration.
2. **Query Wikidata BY value (`fetchWdTaxaByValues()` in `utils.js`)** for enumeration — the "flip". We hold a complete local key set in `taxa.db`, so instead of scanning Wikidata we probe it with `VALUES ?value { … } ?item wdt:<valueProperty> ?value . FILTER NOT EXISTS {<absentProperty>}` in bounded batches (an indexed lookup, ~10 k values/batch in seconds; full pass in minutes). Two wrappers:
   - `fetchWdTaxaByNames()` — by P225 name, absent P3151 (~1.4 M names). Used by `checkLinks.js` (collect matches up to `--limit`) and `checkLinksStats.js` (full pass; no-match = `total − match − ambig`).
   - `fetchWdTaxaByInatIds()` — by P3151 iNat ID, absent P18 (~1.4 M ids). Used by `checkImages.js` **only when no IUCN status is given**, skipping cached ids until `--limit` new candidates are collected.

   **Exception — `checkImages.js --iucn <code>`:** when an IUCN status *is* given, do **not** flip. `fetchWdTaxaByIucn()` runs a single direct query (`?item wdt:P141 wd:<qid> ; wdt:P3151 ?inatId . FILTER NOT EXISTS {wdt:P18}`). Here P141 is the selective constraint, so the no-P18 set per status is small (CR ~2 k, even LC ~30 k) and WDQS answers in 1–6 s. The flip would instead brute-force all ~1.4 M iNat IDs across ~141 batches, and because the status filter is client-side the `--limit` early-exit never fires for rare statuses — it was scanning the whole taxonomy to find a few thousand CR taxa (the regression this path fixes). The flip is reserved for the unfiltered case, where the full ~619 K no-P18 set genuinely can't be scanned.

   Coverage note: the flip only reaches values present in `taxa.db` (active iNat taxa). For images this means WD items whose P3151 points to an inactive/merged iNat taxon are skipped — acceptable, as they have no current iNat photo to source. The direct `--iucn` query has no such restriction (it reads P3151 straight off the WD item).

**POST vs GET:** large `VALUES` lists exceed the GET URL length limit, so `fetchWdTaxaByValues()` uses `sparqlPost()` (form-encoded `query=` body). `sparqlPost()` shares TSV parsing and 429/502/503/504 backoff with `sparqlTSV()`. P141 is fetched via `OPTIONAL` and the `iucnQid` filter applied in JS — adding `?item wdt:P141 wd:<qid>` to a large `VALUES` query makes WDQS pick a bad plan and time out.

### CirrusSearch (MediaWiki search API) cheatsheet

Endpoint `https://www.wikidata.org/w/api.php?action=query&list=search&srnamespace=0&srinfo=totalhits&srprop=&format=json&srsearch=<query>`. Elasticsearch-backed, so it indexes **independently of WDQS** — expect a few-item freshness lag between the two (verified: CirrusSearch reported 1,043 CR no-P3151 taxa vs 1,036 live on WDQS).

- **`haswbstatement:`** — `haswbstatement:P225` = has the statement; **`-haswbstatement:P3151`** = lacks it. Value equality: `haswbstatement:P141=Q219127`, `haswbstatement:P105=Q7432`. Multiple space-separated terms are ANDed. Negation partitions exactly (WITH + WITHOUT a property sum to the total). Matches **direct/truthy statements only** — there is no transitive form, so you cannot filter "descendant of Insecta".
- **Hard caps:** `sroffset > 10000` → error `cirrussearch-offset-too-large`; `srlimit` max 500. Usable for counts and small/partitioned enumeration, **not deep paging**. This is why the ~2.5 M `species` rank can't be tiled out — there is no enumerable indexed sub-key fine enough to keep every bucket under 10 000.
- **`inlabel:Token`** matches whole label tokens (e.g. `inlabel:Carabus` matches every "Carabus …" binomial). Prefix wildcards (`inlabel:Aba*`) are unreliable (inconsistent counts) — don't depend on them for partitioning.
- **Names without WDQS:** `generator=search&prop=entityterms&wbetlanguage=mul` returns the `mul` label, which for taxa is the scientific name — an alternative way to enumerate name+QID together if a local name list isn't available (we don't need it here since `taxa.db` already has every name).

---

## Taxonomy tree comparison and `--auto` certainty filter (`utils.js`, `checkLinks.js`)

`compareAncestorTrees(wdChain, inatChain)` aligns the WD and iNat ancestor chains by rank name (case-insensitive), counts agreements and disagreements among labeled ranks present in **both** chains, and returns `{ matches, mismatches, matchedRanks }`. Only the 9 ranks in `WD_RANK_LABELS` can be labeled on the WD side (genus, family, superfamily, subfamily, tribe, subtribe, order, subclass, class); iNat rank strings are used as-is. Ranks present in only one chain are ignored — they do not count as mismatches.

The `--auto` certainty filter requires: `mismatches === 0 && matches >= 3 && (matchedRanks.includes('family') || matchedRanks.includes('order'))`. The family-or-order anchor prevents three coincidentally agreeing intermediate ranks (e.g. subfamily/tribe/subtribe within a split family) from triggering auto-approval on an actually wrong match.

**Known recurring disagreement — Noctuidae/Erebidae:** many moth genera were reclassified from Noctuidae to Erebidae; WD and iNat have not fully converged on this split. Affected genera produce a family-level mismatch for otherwise correct matches and correctly fail the auto-filter, appearing in `links.html` for human review.

---

## Wikidata QID reference

Most QIDs live in code constants; this is the human-readable map. **QIDs can change via item merges** — if rank or ancestor detection breaks unexpectedly, re-verify these against the live items.

**Taxon ranks** (`WD_RANK_LABELS` in `utils.js`, `RANK_LABELS` in `generateWikitext.js`): genus `Q34740`, family `Q35409`, superfamily `Q2136103`, subfamily `Q164280`, tribe `Q227936`, subtribe `Q3965313`, order `Q36602`, subclass `Q5867051`, class `Q37517`. "Instance of taxon" is `Q16521`.

**IUCN status (P141)** QIDs and their Commons categories: see the [IUCN Commons categories](#iucn-commons-categories) table above. Note EN is `Q96377276` (not `Q11394`).

**`{{IUCN}}` template logic** (`generateWikitext.js`): when an item has both P627 (Red List numeric ID) and P141 (status), emit `{{IUCN|code|id|name|authority}}`, which auto-categorises the Commons page into the correct IUCN maintenance category. With P141 only (no P627), emit a manual `[[Category:IUCN X species]]` instead.

**Source item:** the iNaturalist Wikidata item `Q16958215` is used as the `S248` (stated in) source on generated P1843 vernacular-name references (`checkNames.js`).
