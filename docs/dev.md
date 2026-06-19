# Developer notes

Implementation details for contributors and for Claude to read on demand when debugging or extending the tools.

## iNat taxa SQLite index (`getInatTaxaDb.js`)

The local SQLite DB at `~/.cache/wikidata-inat-checker/taxa.db` has schema `taxa(taxon_id PK, name, rank, ancestry)` with an index on `name`. `get(name)` issues a `LIMIT 2` query: exactly one row → returns `{inatId, rank}`, two or more rows → returns `undefined` (homonym, treated the same as not-found). `getAll(name)` returns all matching rows and is used to surface the ambiguous cases. `getAncestors(taxonId)` parses the slash-separated `ancestry` field (ancestor IDs root-to-parent) and looks each up by primary key — no API call needed; filters out the `stateofmatter` root concept.

## Vernacular name language codes (`getInatNames.js`)

iNaturalist returns Chinese names under `zh-CN` and `zh-TW`. These are normalised to `zh-hans` and `zh-hant` respectively before comparison with Wikidata, because Wikidata uses lowercase script subtags for these languages.

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

### TSV format for large result sets

Request TSV instead of JSON to avoid the ~7 MB JSON truncation limit and control-character parse errors:

```js
const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`;
const res = await fetch(url, { headers: { ...HEADERS, 'Accept': 'text/tab-separated-values' } });
```

**Critical:** do not use `wbk.sparqlQuery(query)` as the URL — it appends `format=json` which overrides the Accept header and returns JSON regardless. Use the raw endpoint URL with no `format=` param.

TSV parsing: header row has `?varName` columns; URI cells are `<http://…>`; literal cells are `"value"`. Strip BOM (`﻿`) from the first line.

### Large-dataset pagination

Wikidata's Blazegraph does not maintain cursor state between requests. `LIMIT/OFFSET` without `ORDER BY` is non-deterministic — pages overlap and skip items. Do not use it to cover a complete result set on large (100k+) datasets.

**What doesn't work:**
- `ORDER BY ?item` → 504 (full sort too expensive)
- `FILTER(?item > wd:QN)` → 0 rows (IRI comparison not supported)
- `BIND(xsd:integer(STRAFTER(…)) as ?qnum) FILTER(?qnum > N)` → 504 on page 1
- `STRSTARTS(?taxonName, "A")` letter partitioning → slower than plain OFFSET (full scan, no index)
- `OPTIONAL { ?item wdt:P141 ?status }` across pages → minority-bound rows severely undercounted; Wikidata's scan order returns the majority group first (saw 11 CR items instead of 1,764 actual)

**What works — partition by category:** run one dedicated query per group (e.g. one per IUCN status code), then paginate the dominant no-match group separately with `FILTER NOT EXISTS { ?item wdt:P141 ?any . }`. This is why `checkLinksStats.js` uses two phases.

**Rate limiting:** Wikidata returns HTTP 429 at high OFFSET values (~350k+). Retry with 30s delay; add 2s inter-page pause for long runs. A 200 response can also return a truncated body — fewer rows than LIMIT without an error code.
