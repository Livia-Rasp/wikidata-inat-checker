# Commons + iNaturalist integration — reusable reference

App-agnostic building blocks for tools that **pre-fill Wikimedia Commons uploads** and
**auto-generate file descriptions / categories** from iNaturalist data. Extracted from the
research done for the image-upload app; this is the reusable "how to" so future apps don't
re-derive it. The worked, opinionated application of these pieces lives in
[commons-upload-dev.md](commons-upload-dev.md); the user-facing app doc is
[commons-upload.md](commons-upload.md).

All findings verified against the live APIs in **2026-06**; treat dates/coverage counts as
"as of then" and re-check if something looks off.

---

## 1. Pre-filling `Special:Upload` (no automated upload)

Open Commons' upload form with fields pre-populated via query params; the user reviews and
clicks Upload. No write API, no bot.

```
https://commons.wikimedia.org/wiki/Special:Upload
  ?wpUploadFileURL=<remote image URL>     # "copy upload" / upload-by-URL
  &wpSourceType=url
  &wpDestFile=<destination filename.ext>
  &wpLicense=<Commons license template, e.g. cc-by-4.0 | cc-by-sa-4.0 | Cc-zero>
  &wpUploadDescription=<URL-encoded file-page wikitext>
```

Constraints for `wpUploadFileURL` (copy upload) to work:
- The user needs the **`upload_by_url`** right — granted to all registered Commons users.
- The image **host must be on the copy-upload allowlist**
  ([`MediaWiki:Copyupload-allowed-domains`](https://commons.wikimedia.org/wiki/MediaWiki:Copyupload-allowed-domains),
  backing `$wgCopyUploadsDomains`). To check a host, read that page.
- The destination filename's **extension must match the real file type** — parse it from the
  source URL, don't hardcode.
- `Special:Upload` only pre-fills **wikitext**; it **cannot** set structured data (SDC
  depicts/captions). Templates that want SDC (e.g. `{{Taken on}}`) will add a
  "missing SDC …" maintenance category — harmless and common.

---

## 2. iNaturalist API recipes

- **CORS-open** (`Access-Control-Allow-Origin: *`) — callable directly from a browser app.
- **Photos:** `GET /v1/observations?...&photos=true`. Each `photos[]` has `id`, `url`,
  `license_code`. Full-res URL = `url.replace('square','original')`. Per-photo license can
  differ from the observation; filter on the photo's own `license_code`.
  - Commons-compatible licenses only: `cc0`, `cc-by`, `cc-by-sa`. Openly-licensed photos are
    served from `inaturalist-open-data.s3.amazonaws.com` (allowlisted, see §1); all-rights-
    reserved ones from `static.inaturalist.org`.
- **English common name:** add `locale=en`; read `taxon.preferred_common_name`.
- **Location hierarchy:** `place_guess` is free text (often a street address) — unreliable.
  Use the observation's `place_ids`, resolve via `GET /v1/places/<comma-ids>`, and read
  `admin_level`: **`0` = country, `10` = state/region, `20` = county/district**. Most of an
  observation's place_ids are non-administrative (admin_level null) — ignore those.
- **Taxon ancestry:** `GET /v1/taxa/<id>?locale=en` → `ancestors[]` (`rank`, `name`,
  `preferred_common_name`) + `iconic_taxon_name`. The observation's `taxon` only carries
  `ancestor_ids` (no names), so this extra call is needed for ranks/names.
- **Iconic group vernacular:** the ancestor whose `name === iconic_taxon_name` carries the
  group's common name (e.g. Aves → "Birds"), used for vernacular categories (§5).

Be polite: iNat suggests ~1 req/s; batch and cache.

---

## 3. Commons category techniques

- **Does a category exist?** `action=query&prop=info&titles=Category:A|Category:B…&origin=*`
  — a page with a `missing` key doesn't exist. Batch ≤50 titles per call. Watch the
  `query.normalized` map to tie responses back to requested titles.
- **Soft redirects — existence is not enough.** Many categories exist *only* as a soft
  redirect: a page whose wikitext is `{{Category redirect|<target>}}` (e.g. `Plants of Hawaii`
  → `Flora of Hawaii`). `prop=info` reports such a page as existing (not `missing`), so a plain
  existence check will file media into a deprecated redirect. `redirects=1` does **not** follow
  it — soft redirects are template-based, not `#REDIRECT`. To detect+follow, fetch wikitext
  (`prop=revisions&rvprop=content&rvslots=main`, same batching as existence) and look for the
  template. It has **~16 aliases** (`Seecat`, `Cat redirect`, `Catredirect`, `Cat-red`,
  `Redirect category`, `Catr`, `Ctr`, …) — normalise the template name (lowercase, strip
  spaces/`_`/`-`) and match a small alias set. Follow the chain a few hops to a real category.
- **Test what categories a template emits:** `action=parse` with `text=<wikitext>` **and
  `title=File:Example.jpg`**, `prop=categories`. The `title` matters: many Commons
  date/location templates only categorise inside the **File namespace**, so without a File
  title you'll see no categories.
- **Find pages containing a template/text:** `list=search&srnamespace=14&srsearch=insource:"…"`
  (namespace 14 = Category).
- **Enumerate by prefix / membership:** `list=allcategories&acprefix=…`;
  `list=categorymembers&cmtitle=…`.
- The Commons API is CORS-accessible with `origin=*`.

---

## 4. Date categorisation — `{{Taken on}}`

- Single template with a `location=` parameter — there are **no** separate per-country date
  templates.
- `{{Taken on|<ISO date>}}` → `[[Category:Photographs taken on <date>]]`;
  `{{Taken on|<date>|location=<X>}}` → `[[Category:<X> photographs taken on <date>]]`.
- **No validation:** whatever you pass to `location=` becomes the category prefix verbatim
  (`location=Freedonia` "works"). So `location=` **must** be a Commons-canonical country
  name or you create an orphan category.
- Canonical names use e.g. **`United States`** (no "the"), `France`, `New Zealand`, `Russia`,
  `South Korea`, `United Kingdom`. (Contrast §5 — "of X" uses "the United States".)
- Only categorises in the **File namespace** (see §3 testing note).

---

## 5. Geographic taxon categories — `<Taxon> of/in <Place>`

Commons groups media by taxon-in-place, e.g. `Picidae of Texas`, `Odonata of Argentina`,
`Birds of the United States`. Humans create these by hand, so naming is **inconsistent** —
budget for several traps:

- The **taxon** side uses **scientific names at higher ranks** (`Picidae`, `Piciformes`)
  **and iconic-group vernaculars** (`Birds`, not `Aves`).
- **Kingdom vernacular drift:** plants use **`Flora of <Place>`** (with `Plants of <Place>`
  a soft redirect — see §3); animals use **`Animals of <Place>`** (with `Fauna of <Place>`
  often missing). Map the iconic taxon to **both** labels (`Plantae` → `Flora`, `Plants`;
  `Animalia` → `Animals`, `Fauna`) and let existence + redirect-resolution pick the live one.
- **Preposition drift:** most cats use **"of"**, but some branches use **"in"** — notably
  family-level plant cats (`Fabaceae in Hawaii` exists; `Fabaceae of Hawaii` does not). Try
  **both** prepositions per candidate.
- The **place** naming **differs from §4**: "of X" uses **`the United States`** (with "the"),
  while states are bare (`Texas`). Generate place variants (bare + `the <country>`) and let
  existence-checks decide.
- **Discovery algorithm:** candidate taxa = the taxon's ancestor scientific names + iconic
  vernacular/Flora-Fauna labels; candidate places = the resolved admin levels (+ "the" variant
  for country). Build `<taxon> {of,in} <place>` for the cross product, existence-check (§3,
  batched) **and resolve soft redirects to their real target**.

**Two axes, not one.** Selecting a single "most specific" category loses the actual county/city
a photo was taken in, because fine places rarely have a `<Taxon> of <Place>` category and the
search falls through to a coarser *place*. Instead emit **up to two** categories:

- **Taxon axis** — the most *taxon*-specific `<Taxon> {of,in} <Place>` (iterate taxa
  deepest-first; place falls through). Captures the precise lineage even at a coarse place.
- **Place axis** — the most *place*-specific category: at the finest place, try the kingdom
  label (`Flora/Fauna/Fungi of <place>`), then `Nature of <place>` (the all-living-organisms
  category, broader than a kingdom label but narrower than the plain place), then the **plain
  place category**. Plain titles must follow Commons' **disambiguated** naming — a US county is
  `"<Name> County, <State>"`, a town `"<Name>, <State>"`; the bare admin name (`Perry`, `Medina`)
  hits an unrelated or disambiguation page. So sub-state levels are only tried qualified, and
  otherwise fall up a level. (On the `taxonDepth` axis, `Nature of <place>` sits one tier below
  kingdom — `RANK_DEPTH.kingdom - 1` — so the dedup treats it as more general than `Flora/Fauna`
  and more specific than the plain place.)
- **Drop redundant (nested) categories** structurally — no extra queries. Tag each pick
  `(taxonDepth, placeLevel)`; one is an ancestor of (and dropped alongside) the other iff it is
  ≤ on **both** axes. This holds because every place is one nested hierarchy, so
  `<Taxon> of <FinePlace>` ⊂ `<CoarserTaxon> of <CoarserPlace>` exactly when both axes are ≤.
  Independent picks (different axes) are both kept.

**Finest place — reverse geocoding.** iNat `place_ids` already reverse-geocode the GPS but cover
sub-county levels patchily. A reverse geocoder fills the municipality/town level (and any missing
county). **OSM Nominatim** (`/reverse?format=jsonv2&lat=&lon=&zoom=14`) is CORS-open and key-less;
map its `address` fields (`city`/`town`/`village`/`municipality` → town, `county`, `state`,
`country`) to admin levels. Honour its **~1 req/sec** policy: cache per rounded coordinate
(~110 m) and serialise calls ≥1.1 s apart. Browsers can't set `User-Agent` (forbidden header) —
the page **Referer** satisfies the identification requirement instead. Merge only the levels iNat
lacked (iNat's bare names already match Commons); on any failure fall back to the iNat hierarchy.

**Don't geocode obscured points.** Threatened taxa (and user geoprivacy) expose a **randomized**
coordinate (`geoprivacy`/`taxon_geoprivacy` = `obscured`/`private`, large `public_positional_
accuracy`). Reverse-geocoding it assigns a confidently-wrong town/county, so skip the geocode for
those (and drop the municipality level once accuracy exceeds ~2 km). iNat's exposed admin
`place_ids` for obscured records are still the *true* containing places — keep using them. Bonus:
skipping obscured points also keeps **threatened-species localities coarse**, which is the point
of obscuring — only open observations get a precise place category.

**Exact place categories via Wikidata (ISO 3166-2).** Admin-division naming on Commons is
region-specific — `<X> County, <State>` (US), `<X> Province`, `<X> Canton`, `<X> Department`,
`Landkreis <X>`, often accented (`Sucumbíos Province`) — too varied to guess. Resolve it instead:
Nominatim's reverse `address` carries the province's **ISO 3166-2 code** (`ISO3166-2-lvl4`, e.g.
`EC-U`) and the county name. One WDQS query maps them to the exact Commons category — the province
via `?area wdt:P300 "<ISO>"`, the county as its `wdt:P131` child whose `rdfs:label`/`skos:altLabel`
matches the Nominatim name — then read `wdt:P373` (or the `commonswiki` Category sitelink). This
yields `Sucumbíos Province` / `Lago Agrio Canton` with no heuristics; cache per ISO+county.

**Two more naming traps** (both existence-checked, so they fail safe):
- **Disambiguation pages.** A bare place name often lands on a `{{Disambig}}` page (`Victoria`,
  `Washington`, `Georgia`) — a real page, never a valid category. Detect the disambiguation
  template (as with soft redirects) and reject it. (Ambiguous *non*-disambig pages, e.g. a
  Bermuda parish `Smiths`, still slip through — a residual small-territory limitation.)
- **Diacritics.** iNat carries accents (`Québec`) that Commons titles often drop
  (`Flora of Quebec`). Retry each title deaccented (`String.normalize('NFD')` minus combining
  marks) so the accented form falls back to the plain Commons title.
- **Place floor.** `place_ids` can include continents (admin_level < 0); cap the place search at
  country so images aren't filed into a continent.

### Endemic variant — `Endemic <group> of <place>` (from P183)

A taxon's Wikidata **P183 ("endemic to")** drives a parallel family of categories:
`Endemic fauna of Tanzania`, `Endemic flora of Réunion`, `Endemic birds of Australia`. Same
existence-checked, most-specific-first approach as above, with two domain specifics:

- **Group word** from the taxon's ancestry (match by **scientific name**, not rank QID):
  specific class words (`Aves→birds`, `Mammalia→mammals`, `Amphibia→amphibians`,
  `Reptilia→reptiles`, ray-/cartilaginous-/jawless-fish classes→`fish`) → kingdom words
  (`Animalia→fauna`, `Plantae→flora`, `Fungi→fungi`) → `species` as a last resort. **A matched
  animal class implies `fauna` directly** — don't wait to see `Animalia` in the chain, because
  for deep lineages (birds via `Dinosauria`) it sits beyond a sane ancestor-walk depth.
  **Never map `Sarcopterygii`/`Osteichthyes` to `fish`** — cladistically they contain all
  tetrapods, so they'd tag frogs and birds as fish.
- **Place** = the P183 value's English label (or P373), tried bare and with a leading `the`.
  A Wikidata label that differs from the Commons place name (e.g. `Taiwan Island` vs the
  `Taiwan` used by `Endemic flora of Taiwan`) just yields no match — emit nothing rather than
  guess. Resolving the place up its admin hierarchy (as in §5) would close some of these gaps.

---

## 6. Author (photographer) categories

Some iNaturalist photographers have a Commons category (e.g.
`Category:Photographs by Donald Hobern`). Two complementary ways to map an **iNat numeric
user ID** → category (keying on the ID sidesteps inconsistent "Photographs by …" vs
"Photos by …" naming — you *discover* the title, not build it):

1. **Commons template:** author categories may contain `{{Inaturalist user|<id>}}`. Find via
   `insource:"Inaturalist user|<id>"` (namespace 14). Coverage: **~4 category pages** total.
2. **Wikidata:** property **P12022 (iNaturalist user ID)** on a person → their Commons
   category **P373** (or Creator page **P1472**). SPARQL:
   `SELECT ?cat WHERE { ?item wdt:P12022 "<id>". ?item wdt:P373 ?cat. }`. Coverage: **~107
   items have P12022, ~23 with a P373 category**.

The two sources barely overlap, so use the **union**. P373 stores the category name without
the `Category:` prefix. Coverage is small but grows over time — cache results (including
negatives) per user ID.

---

## 7. Wikidata techniques

- **WDQS** (`https://query.wikidata.org/sparql?format=json&query=…`) is CORS-open.
- **Find a property by name:** `action=wbsearchentities&type=property&search=…` (this is how
  P12022 was found).
- Person → Commons: **P373** (Commons category), **P1472** (Commons Creator page).
- `{{Creator|Wikidata=Q…}}` on a Commons author category links back to the Wikidata person.

---

## 8. Cross-cutting gotchas

- **Place naming is context-dependent.** The same country is `United States` for `{{Taken on}}`
  date categories but `the United States` for `<Taxon> of <Place>` categories. Don't assume a
  single canonical spelling; generate variants and existence-check. **Diacritics** are handled by
  retrying each title deaccented (`Québec` → `Flora of Quebec`); a few word-level divergences
  remain (Czechia/Czech Republic, Türkiye/Turkey) — a small iNat→Commons mapping table is the
  eventual fix.
- **Cache everything**, including negative results — these external facts rarely change. A
  cached "none" won't pick up a category created later; clearing the cache re-checks.
- **Provenance once.** For iNaturalist sources, `{{iNaturalist|<obs id>}}` +
  `{{INaturalistreview}}` (license-review bot) are the conventional templates.
- **No upload confirmation.** A prefill-URL app can't know whether the user completed the
  upload (new tab, no callback); track "uploaded" manually if you need a record.

---

## 9. Endpoints & identifiers

| Thing | Where |
|---|---|
| Commons API | `https://commons.wikimedia.org/w/api.php` (CORS `origin=*`) |
| Copy-upload allowlist | `MediaWiki:Copyupload-allowed-domains` |
| iNat API | `https://api.inaturalist.org/v1` (CORS `*`) |
| WDQS | `https://query.wikidata.org/sparql` (CORS) |
| OSM Nominatim (reverse geocode) | `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=&lon=&zoom=14` (CORS `*`; ~1 req/sec policy, identify via Referer/User-Agent; ODbL attribution) |
| Commons license templates | `cc-by` → `cc-by-4.0`, `cc-by-sa` → `cc-by-sa-4.0`, `cc0` → `Cc-zero` |
| iNat place admin levels | `0` country, `10` state, `20` county; we also use `30` for town/municipality (from reverse geocoding) |
| iNat geoprivacy fields | `geoprivacy`, `taxon_geoprivacy` (`open`/`obscured`/`private`), `public_positional_accuracy` (m) — gate precise geocoding on these |
| Wikidata: iNat user ID | **P12022** · Commons category **P373** · Creator **P1472** |
| Wikidata: place → Commons cat | ISO 3166-2 **P300** (province) · located-in **P131** (county) · **P373**/`commonswiki` Category sitelink |
