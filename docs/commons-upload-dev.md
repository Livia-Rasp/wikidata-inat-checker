# iNat → Commons upload — design & research record

The research notes, technical investigation, and design decisions behind the assisted
iNat → Commons upload app. This is the **historic record** of how the feature was designed;
for what the app does and how to use it, see [commons-upload.md](commons-upload.md). The
**reusable, app-agnostic building blocks** (Special:Upload prefill, Commons/iNat/Wikidata
API recipes, category-discovery patterns) are factored out into
[commons-integration.md](commons-integration.md) for future Commons-upload tools.

**Implementation map:** `checkImages.js` records findings in `data/findings.db`, and
`server/routes/findings.js` serves them as `GET /api/findings` (the data contract; the older
`web/data/taxa.json` export still runs but nothing reads it). The app: `web/index.html` +
`web/js/main.js` (taxa list), `web/taxon.html` + `web/js/gallery.js` (per-taxon photo gallery),
`web/js/commonsUpload.js` (the `Special:Upload` prefill-URL builder, ported from
inat2wiki — see `web/README.md` for attribution), served by `server/` (`npm run web`, see
[security.md](security.md)). Shared taxon-name parsing lives in `report/htmlShared.js`
(`extractTaxonName`).

---

## 1. How inat2wiki works (prior art)

The whole `inat2wiki` ecosystem boils down to **one function** that builds a URL to
Commons' `Special:Upload` page with query parameters that pre-fill the upload form. It is
**not** an automated uploader — the user still reviews the form and clicks "Upload". That
half-automated behaviour is exactly what we want.

The three repos are layers around that one function:

| Repo | Role |
|---|---|
| [`inat2wiki-module`](https://github.com/lubianat/inat2wiki-module) | Core Python library. `inat2wiki/parse_observation.py` holds `get_commons_url()` — the prefill-URL builder. The Unlicense (public domain). |
| [`inat2wiki`](https://github.com/lubianat/inat2wiki) / [`inat2wiki-dev`](https://github.com/lubianat/inat2wiki-dev) | Flask (`inat2wiki`) and Svelte+Flask (`inat2wiki-dev`, the current rewrite) web apps that call the module. `inat2wiki-dev/www/python/src/app.py` route `parse_obs` renders each observation photo with its own upload link. |
| [`addon_inat2wiki`](https://github.com/lubianat/addon_inat2wiki) | Chrome extension. Injects an "Add it to Wikimedia Commons!" button onto iNat observation pages, checks the license client-side, and opens the toolforge app. Pure convenience wrapper (`content.js`). |

Live tool: <https://inat2wiki-dev.toolforge.org/>. The credit chain notes the Commons
import logic was originally adapted from kaldari's *iNaturalist2Commons*.

### The prefill URL

```
https://commons.wikimedia.org/wiki/Special:Upload
  ?wpUploadFileURL=<original-resolution iNat photo URL>
  &wpSourceType=url
  &wpDestFile=<Taxon - photoID.jpeg>
  &wpLicense=<cc-by-4.0 | cc-by-sa-4.0 | Cc-zero>
  &wpUploadDescription=<URL-encoded wikitext>
```

`Special:Upload` form fields used:

| Param | Value |
|---|---|
| `wpSourceType` | `url` — tells the form to fetch from a remote URL (copy-upload) |
| `wpUploadFileURL` | the full-resolution photo URL (see §2) |
| `wpDestFile` | destination filename, e.g. `Taxon name - <photoId>.jpeg` |
| `wpLicense` | mapped license template name |
| `wpUploadDescription` | the file page wikitext, URL-encoded |

### The wikitext (`wpUploadDescription`)

From `get_commons_url()`:

```wikitext
{{Information
|description= <Taxon, place_guess, date> (iNaturalist).
|date=<observed_on>
|source=https://www.inaturalist.org/photos/<photo_id>
|author=[https://www.inaturalist.org/users/<user_id> <user_name>]
|permission=
|other versions=
}}
{{Location|<lat>|<lon>|source:iNaturalist|prec=<accuracy_m>}}   ← whenever coords exist
{{iNaturalist|<observation_id>}}
{{INaturalistreview}}
[[Category:Media uploaded with inat2wiki]]
[[Category:<Taxon>]]
```

Notes:
- `{{INaturalistreview}}` flags the file for a Commons bot that re-verifies the license
  against iNat after upload.
- `author` links to the iNat user page; the display name falls back to `login_exact`
  when the user has no display name.
- The `{{Location}}` line is included **whenever the observation has coordinates**, with
  `prec=<metres>` set from `public_positional_accuracy` (the public accuracy radius, which
  already reflects obscuring — ~29 km for an obscured record). Obscured coordinates aren't a
  leak: iNat returns a randomized point for them, and `prec` records the coarse accuracy
  rather than implying precision. `prec` is omitted only when no accuracy value is available.
- Categories are minimal: a tracking category plus a bare `[[Category:<Taxon>]]`.

### License handling

Only three iNat license codes are accepted; everything else is rejected before a URL is
built (`"License not supported"`):

| iNat `license_code` | Commons `wpLicense` |
|---|---|
| `cc-by` | `cc-by-4.0` |
| `cc-by-sa` | `cc-by-sa-4.0` |
| `cc0` | `Cc-zero` |

### Photo URL

iNat API returns a thumbnail URL like `.../photos/<id>/square.jpg`. The code derives
full resolution by string-replacing `square` → `original`. See §2 for the host details.

---

## 2. Copy-upload feasibility (the make-or-break question) — VERIFIED ✅

`wpUploadFileURL` (upload-by-URL, a.k.a. "copy upload") only works when **both** hold:

1. **The user has the `upload_by_url` right.** On Commons this is granted to *all
   registered users* — fine for our use.
2. **The image host is on Commons' copy-upload allowlist**
   ([`MediaWiki:Copyupload-allowed-domains`](https://commons.wikimedia.org/wiki/MediaWiki:Copyupload-allowed-domains),
   backing `$wgCopyUploadsDomains`).

We confirmed the allowlist contains **both** iNat hosts:

```
static.inaturalist.org                          # iNaturalist - T221154
inaturalist-open-data.s3.amazonaws.com          # iNaturalist - T275318
```

**Host split (verified live against the iNat API, 2026-06):**

| Photo license | Host |
|---|---|
| openly licensed (cc-by, cc-by-sa, cc0) | `inaturalist-open-data.s3.amazonaws.com` ✅ allowlisted |
| all rights reserved (`license_code: null`) | `static.inaturalist.org` ✅ allowlisted (but we never upload these) |

Since we only ever upload CC photos, the source URL is **always** on the open-data bucket,
which is allowlisted. We confirmed the full-res URL resolves:

```
HEAD https://inaturalist-open-data.s3.amazonaws.com/photos/137831879/original.jpeg → HTTP 200
```

**Every photo we'd upload is on an allowlisted host (verified).** Sampling ~5,000 photos
across varied taxa: all three Commons-compatible licenses (`cc0`, `cc-by`, `cc-by-sa`) are
served **exclusively** from `inaturalist-open-data.s3.amazonaws.com` (allowlisted), 100% of
the time. Only *unlicensed* photos (`license_code: null`) appear elsewhere —
`static.inaturalist.org` (also allowlisted) and, rarely, `www.inaturalist.org` (not
allowlisted, 2 of ~5,000). Since we filter to `photo_license=cc-by,cc-by-sa,cc0`, the
license filter itself guarantees the open-data bucket, so no defensive host check is
needed (see §5 #4).

**Conclusion: the prefill upload-by-URL approach works end-to-end today.** The historical
["can't import newer iNaturalist images" bug](https://forum.inaturalist.org/t/cant-import-newer-images-from-inaturalist-to-wikimedia-commons/20458)
was caused by iNat migrating media to the open-data S3 bucket before it was allowlisted;
ticket **T275318** added that bucket, resolving it. No host-rewriting workaround is needed.

### Real photo URL shape (from live API)

```
https://inaturalist-open-data.s3.amazonaws.com/photos/<photoId>/square.jpg   ← API returns this
https://inaturalist-open-data.s3.amazonaws.com/photos/<photoId>/original.jpg  ← replace square→original
```

Gotcha: the extension varies per photo — observed both `.jpg` and `.jpeg` in the same
result set. `wpDestFile` should use the photo's **actual** extension (parse it from
`photo.url`), not a hardcoded `.jpeg` as inat2wiki does, so the Commons destination
filename matches the real file type.

Useful per-photo API fields (`/v1/observations`, each `photos[]` entry):
- `id`, `url`, `license_code`, `original_dimensions` (`{width,height}`)
- `attribution` — a ready-made credit string, e.g. `(c) Morten Ross, some rights reserved (CC BY)`

Observation-level fields we need: `observed_on`, `place_guess`,
`geojson.coordinates` (`[lon, lat]`), `public_positional_accuracy` (accuracy radius in m,
reflects obscuring; falls back to `positional_accuracy`), `taxon.name`,
`user.{id,login,login_exact,name}`.

---

## 3. The granularity gap

Our pipeline and inat2wiki operate at different levels:

- **`checkImages.js`** finds Wikidata **taxa** (have P3151, lack P18). It already calls
  iNat (`/v1/observations/species_counts`) to confirm each taxon has *at least one*
  research-grade, compatibly-licensed photo, and `output/drafts.html` already renders a
  "filtered iNaturalist observations" link per taxon.
- **inat2wiki** works from a **specific photo of a specific observation**.

To bridge taxon → photo we need a new query: for a chosen taxon, fetch **all** its
research-grade, compatibly-licensed photos with their metadata, e.g.

```
GET /v1/observations
    ?taxon_id=<id>
    &photo_license=cc-by,cc-by-sa,cc0
    &quality_grade=research          # research grade ONLY
    &order_by=votes  &order=desc     # "most faved"  (default)
    &per_page=200    &page=N         # paginate to fetch ALL, not a fixed handful
    &photos=true
```

Decisions (#2):
- **Research grade only.**
- **Show every** matching photo of the taxon (paginate through all pages, 200/req).
- Offer **two orderings** the user can toggle: **most faved** (`order_by=votes`) and
  **newest** (`order_by=created_at`), both `order=desc`.

`checkImages.js` already proves the taxon has a hit; this query upgrades that boolean into
the concrete, rankable photo set the per-taxon view needs.

### Wikitext richness — keep it simple for now (#3)

**Decision:** the upload description stays **minimal**, like inat2wiki — a `{{Information}}`
block, optional `{{Location}}`, `{{iNaturalist}}`, `{{INaturalistreview}}`, and a bare
`[[Category:<Taxon>]]`. We deliberately do **not** pull in `lib/generateWikitext.js` here:
that Taxonavigation/category detail already lives on the Commons **category page** (which
this repo's image checker already drafts), so duplicating it into every file description is
redundant.

Richer descriptions/categories (e.g. enriching the file page beyond the bare taxon
category) are noted as a **separate future feature**, not part of the initial app.

---

## 4. Design options

**Decision: Option B** — an interactive local web app — was chosen for maximum flexibility
and because it can grow into a genuinely useful standalone tool. See §4.1 for the repo
placement decision (build here now, extract later).

### Option A — Static enhancement of `output/drafts.html`

Port `get_commons_url()` into a shared JS module (e.g. `commonsUpload.js`). In
`checkImages.js`, for each image-less taxon, run the §3 photo query for a few candidates
and render them as thumbnails in `output/drafts.html`, each with its own pre-filled "Upload to
Commons" link.

- **Pros:** matches the requirement exactly (browse a selection → click → pre-filled
  Commons form); stays inside the current "Node script → static HTML" architecture; no new
  running service; reuses `lib/generateWikitext.js` for categories.
- **Cons:** more iNat API calls per run (one extra photo query per taxon-with-hit); larger
  HTML; thumbnails make the page heavier.

### Option B — Small local interactive web app *(CHOSEN)*

Mirror `inat2wiki-dev` in spirit: a local server where you browse image-less taxa,
search/select observations and photos live, then click through to the pre-filled Commons
upload form. Two views (#2):

1. **Main view** — a list of image-less taxa, **similar to today's `output/drafts.html`** (same
   columns/feel: Wikidata link, iNat link, Commons category, draft wikitext). Each row has
   an action that **opens the per-taxon photo view in a new tab**.
2. **Per-taxon photo view** (new tab) — shows **all** research-grade, compatibly-licensed
   photos of that taxon as a thumbnail gallery, with a sort toggle (**most faved** /
   **newest**). Selecting a photo opens its pre-filled Commons upload form (§1/§2).

- **Pros:** most flexible; live search and per-photo selection; closest to the inat2wiki
  UX; room to grow into a genuinely useful standalone app.
- **Cons:** a new always-running component; a departure from the batch-HTML model; most
  work.

**Stack:** **plain JS/HTML/CSS** frontend (decided) — no Svelte/build step, keeping the
repo's current zero-build simplicity and the closest feel to today's `output/drafts.html`. See
§4.2 for why **no application backend** is needed.

### Option C — Link-builder module + minimal hook

Port `get_commons_url()` only and add a single "Upload" link per existing `output/drafts.html`
row using the taxon's **default** iNat photo.

- **Pros:** least work.
- **Cons:** default taxon photos are often *not* openly licensed → many dead links.
  Weakest option.

### 4.1 Repo placement — build here now, extract later

**Decision: build the app inside this repo (`wikidata-inat-checker`)**, with a planned
spin-out into its own repository once this repo becomes public and the web service is
published.

Rationale:
- **Zero packaging friction now.** No git submodule, no `npm install` from a git URL, no
  version-sync tax during active development.
- **One source of truth.** Category/index/wikitext changes are instantly shared between the
  CLI tools and the data-export step, over one SQLite driver (`node:sqlite`, built in — there
  is no native dependency to compile).
- **Premature splitting locks in a boundary we don't understand yet.** The shared modules
  are internal helpers, not a designed public API; let the API surface settle first.

**The app lives entirely in its own folder `web/`** (decided). Thanks to the no-backend
architecture (§4.2), `web/` contains *only* static frontend assets and has **zero code
dependency** on the core modules — its sole coupling to the rest of the repo is the
**JSON data contract** it reads (§4.2). That makes the eventual spin-out near-mechanical:
`web/` moves out as-is, and the JSON schema is the interface.

**Spin-out trigger:** when `wikidata-inat-checker` goes public *and* the web service is
ready to be published (e.g. hosted Toolforge-style like `inat2wiki-dev.toolforge.org`). At
that point `web/` becomes its own repo; the data-export step (or a future backend) stays
with the core here, or the core graduates into a published package.

### 4.2 Architecture — no application backend (decided)

The work splits into a **batch data step** (Node, stays with the core) and a **static
client app** (`web/`):

1. **Data export (CLI, root).** Finding image-less taxa needs the SQLite index
   (`lib/getInatTaxaDb.js`, `node:sqlite` → Node-only) plus Wikidata SPARQL
   enumeration (`lib/utils.js`) — heavy, batch-shaped work that cannot/should not run on a page
   load. `checkImages.js` exports the taxon list as JSON (`web/data/taxa.json`, gitignored)
   alongside `output/drafts.html`, via `report/generateImagesJson.js`.
2. **Static client app (`web/`).** Plain HTML/JS/CSS. The **main view** reads `taxa.json`.
   The **per-taxon gallery** calls the **iNat API directly from the browser** — verified
   CORS-open (`Access-Control-Allow-Origin: *`), exactly as the existing Chrome addon
   relies on. The **prefill upload URL** is built client-side (pure string assembly, §6).
   No server-side logic at any point.

**Originally only a trivial static file server was needed**, and only because browsers won't
`fetch()` a local JSON over `file://` — `web/serve.js`, a zero-dependency Node static server,
explicitly *not* an application backend.

**That changed with the findings database** (roadmap slice 3, 2026-08-15). The app now reads its
worklist from `GET /api/findings` rather than a file, because the file was a snapshot every
checker run overwrote. `server/` (Fastify) serves both it and `web/`; `web/serve.js` is gone. The
things a backend was predicted to earn its keep for — on-demand re-scanning from the UI, auth,
write access — are roadmap slices 5, 4 and 10, and they hang off this same server.

Its configuration is security-relevant (a strict CSP the app has to stay inside, a rate limiter
scoped to `/api`, sanitised errors); the reasoning is in [security.md](security.md).

---

## 5. Resolved decisions

1. ~~Option A / B / C~~ — **decided: Option B, in this repo (§4, §4.1).**
2. ~~Candidate sourcing~~ — **decided:** research-grade only; show **all** matching photos
   of the taxon; sort toggle **most faved** (`order_by=votes`) / **newest**
   (`created_at`). Two-view UI: a `output/drafts.html`-like main list, each row opening a
   per-taxon photo gallery in a new tab (§3, §4).
3. ~~Wikitext richness~~ — **decided:** keep the description minimal (inat2wiki-style, bare
   `[[Category:<Taxon>]]`); do **not** reuse `lib/generateWikitext.js` — that detail lives on
   the category page already. Richer file-page descriptions/categories = separate future
   feature (§3).
4. ~~Defensive host check~~ — **dropped:** unnecessary. Verified that all CC-licensed
   photos (the only ones we upload) come exclusively from the allowlisted
   `inaturalist-open-data.s3.amazonaws.com`; the `photo_license` filter guarantees the host
   (§2). No fallback needed.
5. ~~Filename collisions~~ — the `Taxon - <photoId>.<ext>` scheme; the `photoId` makes it
   effectively unique, avoiding Commons' duplicate-name rejection. (The author name was
   dropped from the filename; it still appears in the `{{Information}}` author field.)

Also decided: frontend = **plain JS/HTML/CSS** (no build step); **no application
backend** — static `web/` app + CLI JSON export + trivial static file server (§4.2).

---

## 6. Reference snippets

### License map
```
cc-by    → cc-by-4.0
cc-by-sa → cc-by-sa-4.0
cc0      → Cc-zero    (anything else → unsupported, no link)
```

### Full-res URL + extension
```
photoUrl   = apiUrl.replace("square", "original")
ext        = photoUrl.split('.').pop()        // "jpg" | "jpeg" | ...
destFile   = `${taxonName} - ${photoId}.${ext}`
```

### Prefill URL assembly
```
Special:Upload
  ?wpUploadDescription=<encodeURIComponent(wikitext)>
  &wpLicense=<mapped>
  &wpDestFile=<encodeURIComponent(destFile)>
  &wpSourceType=url
  &wpUploadFileURL=<photoUrl>
```

### Source references
- `get_commons_url()` — <https://github.com/lubianat/inat2wiki-module/blob/main/inat2wiki/parse_observation.py>
- `parse_obs` route — <https://github.com/lubianat/inat2wiki-dev/blob/main/www/python/src/app.py>
- addon button — <https://github.com/lubianat/addon_inat2wiki/blob/master/content.js>
- Commons copy-upload allowlist — <https://commons.wikimedia.org/wiki/MediaWiki:Copyupload-allowed-domains>
- Upload tools overview — <https://commons.wikimedia.org/wiki/Commons:Upload_tools>

---

## 7. Next iteration — richer file descriptions (working spec)

**Status: collecting specifications, not yet implemented.** The initial file description is
a thin stub (§1); this section is the running spec for making it good, comprehensive, but
not overloaded. Items are confirmed as decided unless marked OPEN.

### 7.1 Tracking category

- **Remove** `[[Category:Media uploaded with wikidata-inat-checker]]` from the generated
  description **for now** — the tool is not public or publicly known yet.
- **Re-add** it after the tool is published.
- Keep `[[Category:<Taxon>]]`.

### 7.2 Uploaded-files backfill list

Purpose: because the tracking category is removed pre-publication (§7.1), files uploaded
before publication won't carry it. To backfill the category onto those files later, keep a
local record of what was uploaded.

- **Confirmation model:** a **"Mark as uploaded" checkbox** on each photo card. The user
  ticks it manually *after* completing the upload on Commons. (The static app cannot detect
  whether an upload actually succeeded — clicking "Upload to Commons" only opens a new tab,
  with no callback — so confirmation must be manual.)
  - Related: uploads can also **fail because the same image is already on Commons** under a
    different name (Commons rejects byte-identical duplicates). In that case the user simply
    leaves the box unticked.
- **Recorded data:** only the **`destFile`** (the Commons filename) per entry — that's all
  the backfill step needs.
- **Storage:** `localStorage`, plus a **Download button on the main page** that exports the
  list as **JSON**.
- **Scope:** purely a backfill record. It does **not** drive a "hide / already done" filter
  in the gallery.

- **Download JSON shape:** wrapped object, e.g.
  `{ "exported": "<ISO date>", "uploaded": ["Genus species - 123.jpg", …] }`.
- **Visual marker:** a ticked card shows a subtle **"uploaded" badge** (card stays
  visible — not hidden, per the scope above).

### 7.3 Description content

The `|description=` field of `{{Information}}` should read, wrapped in the `{{en|…}}`
language template:

```
{{en|<Common English Name> (''Scientific Name'') in <County>, <State>, <Country>}}
```

and, when no English common name is available:

```
{{en|''Scientific Name'' in <County>, <State>, <Country>}}
```

Confirmed:
- Scientific name in italics (`''…''`).
- **No date** and **no "(iNaturalist)"** in the description — redundant with the `date`
  field and the `{{iNaturalist}}` / source templates.
- Must work for **all countries**; the three location levels may differ in meaning/presence
  between countries — **finetune later**.

**Data sourcing (researched against the live iNat API, 2026-06):**

- **English common name:** request the observations query with `locale=en`; then
  `taxon.preferred_common_name` is the English name (verified: "Monarch", "Socotran desert
  rose"). Omit the common-name part when it's absent.
- **Location (County / State / Country):** *not* reliably in `place_guess` — that field is
  free text and is sometimes just a street address (e.g. "7 Monowai Crescent, North Beach").
  The structured source is the observation's `place_ids`, resolved via `/v1/places/{ids}`,
  which return `admin_level`:
  - `0` = Country, `10` = State/region, `20` = County/district (verified for Yemen and NZ).
  - Build the location from the admin-level 0/10/20 places; join only the levels present.
  - Implementation note: each observation lists many `place_ids` (most non-administrative).
    Collect the **unique** ids across the whole gallery and **batch-resolve** them via
    `/v1/places` (chunked) — one extra, shared lookup step, not one call per photo.

Resolved decisions:
1. **Names come from the observation's *identified* taxon** — both the scientific name
   (`observation.taxon.name`) and the English common name
   (`observation.taxon.preferred_common_name`, via `locale=en`). When that taxon is more
   specific than our target (e.g. a **subspecies**), use its precise scientific name (the
   trinomial), not the rolled-up target. Consequence: the description may name a subspecies
   while `wpDestFile` and `[[Category:<Taxon>]]` still use the target `taxonName` — accepted
   (see note below).
2. **Location fallback:** join the admin levels that are present (→ "County, State, Country",
   or "State, Country", or just "Country"); if **none** resolve, **drop the " in …" clause
   entirely** (do not fall back to `place_guess`).
3. **Obscured / non-open geoprivacy:** **include** the coarse textual admin location anyway
   (Country/State/County are not sensitive). The `{{Location}}` template is also included for
   obscured records — iNat returns a randomized point, not the true location — with
   `prec=<public_positional_accuracy>` recording the coarse accuracy radius (~29 km).

Notes / possible later finetuning:
- Filename (`wpDestFile`) and `[[Category:<Taxon>]]` currently use the target `taxonName`;
  the description may use a more specific observation taxon. If that mismatch turns out to
  matter, revisit whether the category/filename should follow the observation taxon too.
- Subspecies scientific names are written as the raw italicised trinomial (e.g.
  `''Adenium obesum socotranum''`); rank-aware formatting (e.g. `subsp.`) is a possible
  later refinement.

### 7.4 Date — wrap in `{{Taken on}}` with country

The `|date=` field should use Commons' **`{{Taken on}}`** template, with the country added
via its `location=` parameter so the file is categorised by date and country:

```
|date={{Taken on|<observed_on ISO date>|location=<Country>}}
```

When no country resolves, fall back to the plain form:

```
|date={{Taken on|<observed_on ISO date>}}
```

**Researched against the live Commons API (2026-06):**
- There are **no separate per-country date templates** — it's a single `{{Taken on}}`
  template with a `location=` parameter.
- `{{Taken on|<date>}}` → `[[Category:Photographs taken on <date>]]`;
  `{{Taken on|<date>|location=<X>}}` → `[[Category:<X> photographs taken on <date>]]`.
- The template does **no validation**: whatever string is passed to `location=` becomes the
  category prefix verbatim (`location=Freedonia` and `location=USA` both produce categories).
  So `location=` **must** be a Commons-canonical country name, or it creates an orphan
  category.
- Canonical naming confirmed to exist for: `United States` (**not** "the United States"),
  `France`, `New Zealand`, `Yemen`, `Russia`, `South Korea`, `United Kingdom`, etc.

**Country source:** the admin-level-`0` place from the same `place_ids` → `/v1/places`
resolution used for §7.3. Include it regardless of geoprivacy (country is coarse), per the
§7.3 #3 decision.

**iNat → Commons country-name mapping:** iNat's admin-level-0 English names mostly match the
Commons category names (verified: Yemen, New Zealand, …). Divergent spellings/diacritics
(e.g. Czechia vs Czech Republic, Türkiye vs Turkey, Côte d'Ivoire, …) need a small mapping
table — part of the **"location params differ between countries → finetune later"** note.

Notes:
- `{{Taken on}}` also emits a `Taken on missing SDC inception` maintenance category because
  `Special:Upload` can't set structured data — harmless and common; no action needed.
- Keep the date as `observed_on` (date only) for now; time (`time_observed_at`) is a possible
  later addition.
- If `observed_on` is missing, omit the `{{Taken on}}` wrapper (leave `|date=` empty or
  handle as an edge case) — to be finalised.

### 7.5 Author category (best-effort) — IN SCOPE this session

Some iNaturalist photographers have a dedicated **Commons author category** (e.g.
`Category:Photographs by Donald Hobern`). When one exists for the photo's author, add it to
the file. **Decided: implement now, using *both* discovery methods (union), with per-user
caching.** Small payoff (few authors match today), but it makes the description noticeably
better when it does, and grows over time.

**Researched against live Commons + Wikidata (2026-06).** Two complementary ways to map an
iNat author (we have `observation.user.id` / `login` / `name`) to a Commons category — both
keyed on the **numeric iNat user ID**, which sidesteps the inconsistent category naming
("Photographs by …" vs "Photos by …") by *discovering* the real title instead of building
it:

1. **Commons template** — author categories can contain `{{Inaturalist user|<id>}}`.
   Discover via `insource:"Inaturalist user|<id>"` (namespace 14). Verified:
   `4859 → Category:Photographs by Donald Hobern`. **Coverage: only ~4 category pages**
   on all of Commons currently use this template.
2. **Wikidata** — property **P12022 (iNaturalist user ID)** on a person item; take their
   Commons category via **P373** (or Creator page P1472). **Coverage: ~107 items have
   P12022, ~23 of those have a P373 Commons category.** (Note the two sources don't fully
   overlap — Hobern was found via method 1 but his Wikidata item lacks P12022.)

Both lookups are CORS-accessible from the browser (Commons API / WDQS), so they fit the
static app.

**Decided behaviour:**
- Run **both** methods for each author and take the **union** of categories found (normally
  0 or 1; add all distinct hits if more).
- Look up per **unique author** (`observation.user.id`) — once per user, not per photo.
- **Cache results per iNat user ID**, including **negative** results (user has no category),
  so we never repeat the same lookup. Persist in `localStorage` (survives reloads/sessions).
  Cache value: the resolved category title(s) or an explicit "none". Caveat: a cached
  "none" won't pick up a category created later — acceptable; clearing the cache re-checks.
- If a category is found, append it to the file's categories; otherwise add nothing.

### 7.6 Geographic taxon categories — IN SCOPE this session

Add Commons "**`<Taxon> of <Place>`**" categories when they exist (e.g. `Picidae of Texas`,
`Birds of Texas`, `Musophagiformes of South Africa`). High value — these are exactly the
geographic-taxon categories Commons curators want. **Decided: implement now, with caching.**

**Researched against live Commons + iNat (2026-06):**

- Naming is `<taxon> of <place>`. The taxon side uses **scientific names at higher ranks**
  (`Picidae`, `Piciformes`) *and* **iconic-group vernaculars** (`Birds`, not `Aves`).
  Verified existing for *Melanerpes carolinus* in Texas: `Picidae of Texas`,
  `Piciformes of Texas`, `Birds of Texas`, plus `… of the United States` /
  `Birds of North America`.
- **Place naming differs from §7.4!** "of X" uses e.g. **`the United States`** (with "the"),
  while the date category uses `United States` (without). States are bare (`Texas`). So the
  place side needs its own naming, generated as variants and confirmed by existence.

**Data sources:**
- Taxon ancestry: `GET /v1/taxa/<id>?locale=en` returns `ancestors` (rank + `name` +
  `preferred_common_name`) and `iconic_taxon_name`. The observation's taxon only carries
  `ancestor_ids`, so this extra call is needed (once per unique taxon — cached).
- Iconic-group vernacular: the ancestor whose `name == iconic_taxon_name` carries the
  vernacular (Aves → "Birds"). A small override map may be needed where the iNat vernacular
  doesn't match Commons (e.g. fish), but existence-checking makes mismatches harmless.
- Places: the admin-level 0/10/20 names from the §7.3 `place_ids` → `/v1/places` resolution.

**Algorithm:**
1. Candidate taxa = ancestor scientific names (species, genus, family, order, class, …) +
   the iconic vernacular group.
2. Candidate places = each admin level (county, state, country); for the country also try
   the `the <country>` variant.
3. Build `<taxon> of <place>` for the cross product and **check existence** on Commons
   (batched `titles=` queries, ≤50 per call).
4. **Selection:** add the **single most specific** existing category — deepest place first,
   then the deepest taxon within that place (this reproduces the real `Picidae of Texas`
   choice). *(OPEN: single vs. one-per-place-level — see below.)*
5. This is **in addition** to the species `[[Category:<Taxon>]]` (different category trees,
   not parent/child).

**Caching (decided):**
- Cache `/v1/taxa/<id>` ancestor results per **taxon ID**.
- Cache Commons **category existence** per candidate title (`"<taxon> of <place>" → bool`),
  reused across taxa/places/sessions (`localStorage`). Negative results cached too (these
  categories rarely change), same caveat as §7.5.

**Selection — decided:** add only the **single most-specific** existing category (deepest
place, then deepest taxon within it). Reproduces the real `Picidae of Texas` choice and
avoids over-categorisation.

OPEN (finetune later, shared with §7.3/§7.4):
- iNat→Commons place-name mapping for "of X" (the `the <country>` and other quirks).

**Refinement (2026-06, after live imports):** real Commons data exposed three failure modes,
now handled in `enrich.js` (`softRedirectTarget`, `loadCatInfo`, `resolveCategory`, and
`ICONIC_LABELS` / dual prepositions in `findGeoCategories`):
- **Soft redirects.** `Plants of <Place>` is a `{{Category redirect|Flora of <Place>}}` soft
  redirect (not `missing`, not `#REDIRECT`), so the old existence check filed images into the
  deprecated redirect. We now fetch each candidate's wikitext, detect the redirect template
  (≈16 aliases, normalised), and follow it to the real target — and never emit a redirect.
- **Kingdom labels.** Plants categorise under **`Flora of <Place>`**, animals under
  **`Animals of <Place>`**. The iconic taxon is mapped to both label forms
  (`Plantae`→`Flora`/`Plants`, `Animalia`→`Animals`/`Fauna`) instead of only the iNat
  vernacular ("Plants").
- **Preposition drift.** Family-level plant cats use **"in"** (`Fabaceae in Hawaii` exists,
  `Fabaceae of Hawaii` does not), so both `of` and `in` are tried (`of` preferred on ties).
- Verified live (2026-06): *Acacia koa*→`Fabaceae in Hawaii`, *Branta sandvicensis*→
  `Anseriformes of Hawaii`, plant in Yemen→`Flora of Yemen` (kingdom fallback, real, not the
  `Plants of …` redirect).

**Refinement (2026-06, two-axis + most-specific location):** the single "most-specific
category" rule lost the actual county/city a photo was taken in — for fine places a
`<Taxon> of <Place>` category rarely exists, so the search fell through to a coarser *place*.
`findGeoCategory` was replaced by **`findGeoCategories`**, which returns **0–2** categories
along two independent axes and removes redundancy:
- **Taxon anchor** (finest taxon): iterate taxa **outer**, deepest-first; place falls through
  (e.g. `Cardinalis cardinalis in the United States` when the state/county species cat is absent).
- **Place anchor** (finest place): iterate places **outer**, deepest-first; at each place try
  the kingdom label (`Flora/Fauna/Fungi of <place>`), then `Nature of <place>` (the
  all-living-organisms category — preferred over the bare place for these organism images, e.g.
  `Nature of Pasco Department` when no `Flora of …` exists), then the **plain place category**.
  The plain title follows Commons' disambiguated naming — county `→ "<Name> County, <State>"`,
  town `→ "<Name>, <State>"` (the bare iNat name "Perry"/"Medina" hits an
  unrelated/disambiguation page), so sub-state levels are only tried qualified and otherwise
  fall up a level. `Nature of <place>` titles are built from both the taxon-style variants
  (`Nature of the United States`) and the disambiguated plain titles so the right Commons name
  is hit at every level; its `taxonDepth` is `RANK_DEPTH.kingdom - 1` (one tier below kingdom)
  so the dedup ranks it between `Flora/Fauna` and the plain place.
- **Dedup is structural, no extra queries:** each anchor is tagged `(taxonDepth, placeLevel)`;
  `a` is an ancestor of `b` (hence dropped) iff it's ≤ on **both** axes. Sound because all
  places are one nested hierarchy, so `<Taxon> of <FinePlace>` ⊂ `<CoarserTaxon> of <CoarserPlace>`
  exactly when both axes are ≤. Independent anchors are both kept.
- **Finest place via reverse geocoding:** `placeHierarchy` now returns an ordered `places`
  list (all numeric admin levels, deepest-first). `reverseGeocode(lat, lon)` (OSM **Nominatim**,
  CORS-open, no key; cached per ~110 m cell and serialised ≥1.1 s apart for the ~1 req/sec
  policy — browsers identify via Referer since `User-Agent` can't be set) supplies the
  municipality/town level (and any missing county/state/country); `mergeGeocodedPlaces` adds
  only the levels iNat lacked (iNat's bare names win). Verified live (2026-06): obs in
  Mobile, AL → `Cardinalis cardinalis in Alabama` + `Mobile, Alabama` (city, via geocode);
  obs in Massac Co., IL → `… in Illinois` + `Massac County, Illinois` (town `Round Knob` had
  no Commons cat, fell up to county).

**Safeguards (2026-06, from thorough testing on the real image-less targets):** four side
effects surfaced and were fixed; verified across diverse kingdoms/regions (Madagascar, Yemen,
Bermuda, Brazil, …) and a headless-Chrome run of the app:
- **Precision-gated geocoding (`geocodePlaces`).** The targets are mostly *threatened* taxa
  whose iNat coordinates are **obscured** (randomized ~km). Reverse-geocoding that point would
  assign a confidently-wrong town/county. So obscured/private records and `public_positional_
  accuracy` > 20 km skip the geocode entirely; > 2 km drops only the municipality level. (iNat's
  exposed admin `place_ids` for obscured records are the *true* places, so they're still used.)
- **Place floor = country.** `placeHierarchy.places` now spans all admin levels including
  continents (`North America` at admin_level −10); the category search filters to `level ≥ 0`
  so images aren't filed into a continent.
- **Disambiguation pages.** A bare place name often lands on a `{{Disambig}}` page (`Victoria`,
  `Washington`, `Georgia`) — a real page that's never a valid category. `isDisambiguation`
  rejects them like a missing page (surgical: `California`, `Northern Cape`, `Antananarivo` are
  kept). Residual: ambiguous *non*-disambig pages (`Smiths` for a Bermuda parish) still slip
  through — a small-territory edge case.
- **Diacritic fallback (`resolveAnyCase`).** iNat carries accents (`Québec`) that Commons
  titles often drop (`Flora of Quebec`); each title is retried deaccented, upgrading the broad
  bare `Quebec` to `Flora of Quebec`.

**Refinement (2026-06, exact non-US place categories via Wikidata).** The heuristic plain-place
names (`<X> County, <State>`) only fit US-style admin divisions, so e.g. an Ecuadorian observation
fell up to `… of Ecuador` (the `Sucumbíos Province` / `Lago Agrio Canton` categories exist but
under names we can't guess: accented, with `Province`/`Canton` suffixes). Now, on the (non-obscured)
geocode path, `parseNominatim` also returns the province **ISO 3166-2 code** + county name, and
`resolvePlaceCats(iso, county)` (WDQS, cached in `placewd`) maps them to the **exact** Commons
category — province via `wdt:P300`, county as its named `wdt:P131` child, reading `wdt:P373`/the
`commonswiki` Category sitelink. The category is attached as `commonsCat` on the place and used as
the place anchor's plain title (preferred over the heuristic). `mergeGeocodedPlaces` upgrades a
level iNat already had with the resolved `commonsCat`. Verified: the `Symmachia batesi` observation
that prompted this now yields `Lago Agrio Canton` instead of bottoming out at `Ecuador`. Obscured
records skip this (no ISO, and threatened localities should stay coarse).

### 7.7 Other `{{Information}}` fields — keep as-is

`author`, `source`, `permission`, `other versions` stay as in the current
`buildDescription` (§1). In particular **`source` keeps the raw photo URL**
(`https://www.inaturalist.org/photos/<photo_id>`) and the separate `{{iNaturalist|<obs_id>}}`
line below the Information block remains.

## 8. Testing the enrichment & the app (no test suite)

There is no automated test suite; the app is plain ES modules that call live APIs. Two harness
patterns cover it, both runnable from throwaway scripts (keep them in a temp/scratch dir, not the
repo — see the project's "verify in a temp dir" note). Node ≥18 has a global `fetch`; Node ≥21
has a global `WebSocket` (used for the Chrome DevTools Protocol below).

### 8.1 Node harness — exercise `enrich.js` + `commonsUpload.js` directly

The modules are browser-oriented but run in Node with two shims:

- **Stub `localStorage`** before importing, so `web/js/cache.js`'s `Cache`/`localStorage` calls work
  (the `Cache` ctor already swallows a missing `localStorage`, but a stub gives real caching):
  ```js
  const store = new Map();
  globalThis.localStorage = { getItem:(k)=>store.has(k)?store.get(k):null,
    setItem:(k,v)=>store.set(k,v), removeItem:(k)=>store.delete(k) };
  ```
- **Inject a `User-Agent`** into `fetch` *only in Node* — Nominatim rejects key-less, refererless
  requests, but in a browser you must NOT set it (forbidden header; the page Referer is used):
  ```js
  const real = globalThis.fetch;
  globalThis.fetch = (u, o={}) => real(u, { ...o, headers:{ ...(o.headers||{}),
    'User-Agent':'wikidata-inat-checker dev test (you@example.com)' } });
  ```

Then mirror `gallery.js`'s `enrich()` exactly to get the real generated wikitext:
`resolvePlaceIds(obs.place_ids)` → `placeHierarchy` → `mergeGeocodedPlaces(h, await geocodePlaces(obs))`
→ `Promise.all([findGeoCategories(obs.taxon.id, h), findAuthorCategories(obs.user.id)])` →
`buildDescription({ observation, photo, taxonName, location: locationString(h), country: h.country, extraCategories })`.

**Use representative inputs:** load real targets from `web/data/taxa.json` (image-less, mostly
*threatened* taxa) and fetch their observations — NOT common species. Common species have rich
Commons presence that hides the real behaviour (e.g. they show a `<Species> in <Place>` /
species-category overlap that does **not** occur for sparse rare taxa, and they hide the
obscured-coordinate path because their points aren't obscured). Include at least one obscured
record (`geoprivacy`/`taxon_geoprivacy === 'obscured'`, `public_positional_accuracy` ~30 km) to
confirm `geocodePlaces` returns `[]`.

**Oddity-scanner false positives to expect** (when auto-grepping generated categories): tautonyms
(`Vulpes vulpes`, `Cardinalis cardinalis`) look like a doubled word; and any name containing the
substring `nan` (Anta**nan**arivo, Boswellia **nan**a) trips a naïve case-insensitive `NaN` check.

### 8.2 Headless-Chrome harness — the browser-only paths

The Node harness can't verify ES-module loading, CORS from a real origin, Nominatim via **Referer**
(the only way it's identified in-browser), or the DOM. Drive Chrome over CDP — no Puppeteer needed:

1. `google-chrome --headless=new --no-sandbox --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank`.
2. Poll `http://127.0.0.1:9333/json/version`; open a tab with **`PUT /json/new?about:blank`**.
3. Connect a global `WebSocket` to the tab's `webSocketDebuggerUrl`; `Runtime.enable` + `Log.enable`
   + `Page.enable` **before** `Page.navigate` so early errors are caught.
4. Collect `Runtime.exceptionThrown`, `Runtime.consoleAPICalled` (type `error`), `Log.entryAdded`
   (level `error`). Then `Runtime.evaluate({ expression, returnByValue:true, awaitPromise:true })`.
   **Response nesting gotcha:** the value is at `msg.result.result.value` (and `result.exceptionDetails`).

Useful in-page assertions: main view → `#tbody tr` count == `taxa.json` length, `#qs-panel` present;
gallery → `.card` count, every `a.upload` href contains `wpUploadDescription`, decode it
(`new URL(href).searchParams.get('wpUploadDescription')`) and regex out `[[Category:…]]`, and read
`localStorage['winc-cache-geocode']` — a non-empty geocode cache proves **Nominatim ran from the
browser** (Referer accepted, no CORS error). A clean run shows zero collected errors.

### 8.3 What the testing has to cover (regression checklist)

- Two-axis result with **no nesting** (`findGeoCategories` ≤2 cats; neither a subcategory of the
  other) — and dedup when they coincide.
- **Obscured/coarse** coordinates → `geocodePlaces` skips geocoding (no fabricated town/county,
  and threatened localities stay at country level by design).
- **Exact non-US places** resolve via Wikidata (`Lago Agrio Canton`, `Sucumbíos Province`) on the
  open-coordinate path; the canonical name is preferred over the heuristic.
- **Diacritics** (`Québec` → `Flora of Quebec`), **disambiguation** pages rejected
  (`Victoria`/`Washington`/`Georgia`), **place floor** (no continent categories).
- Plain-place uses Commons' **disambiguated** naming (`<X> County, <State>`, `<Town>, <State>`),
  never the bare iNat name. Known residual: ambiguous non-disambig pages (a Bermuda parish
  `Smiths`) still slip through.
