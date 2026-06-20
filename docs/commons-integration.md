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

## 5. Geographic taxon categories — `<Taxon> of <Place>`

Commons groups media by taxon-in-place, e.g. `Picidae of Texas`, `Odonata of Argentina`,
`Birds of the United States`.

- The **taxon** side uses **scientific names at higher ranks** (`Picidae`, `Piciformes`)
  **and iconic-group vernaculars** (`Birds`, not `Aves`).
- The **place** naming **differs from §4**: "of X" uses **`the United States`** (with "the"),
  while states are bare (`Texas`). Generate place variants (bare + `the <country>`) and let
  existence-checks decide.
- **Discovery algorithm:** candidate taxa = the taxon's ancestor scientific names + iconic
  vernacular; candidate places = the resolved admin levels (+ "the" variant for country).
  Build `<taxon> of <place>` for the cross product, existence-check (§3, batched), and select
  the **most specific** that exists (deepest place, then deepest taxon) to avoid
  over-categorising.

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
  single canonical spelling; generate variants and existence-check. iNat admin-0 names mostly
  match but a few diverge (Czechia/Czech Republic, Türkiye/Turkey, diacritics) — a small
  iNat→Commons mapping table is the eventual fix.
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
| Commons license templates | `cc-by` → `cc-by-4.0`, `cc-by-sa` → `cc-by-sa-4.0`, `cc0` → `Cc-zero` |
| iNat place admin levels | `0` country, `10` state, `20` county |
| Wikidata: iNat user ID | **P12022** · Commons category **P373** · Creator **P1472** |
