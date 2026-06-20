# iNat → Commons upload — design & research record

The research notes, technical investigation, and design decisions behind the assisted
iNat → Commons upload app. This is the **historic record** of how the feature was designed;
for what the app does and how to use it, see [commons-upload.md](commons-upload.md).

**Implementation map:** `checkImages.js` → `generateImagesJson.js` exports
`web/data/taxa.json` (the data contract). The static app: `web/index.html` + `web/js/main.js`
(taxa list), `web/taxon.html` + `web/js/gallery.js` (per-taxon photo gallery),
`web/js/commonsUpload.js` (the `Special:Upload` prefill-URL builder, ported from
inat2wiki — see `web/README.md` for attribution), `web/serve.js` (zero-dep static server,
`npm run web`). Shared taxon-name parsing lives in `htmlShared.js` (`extractTaxonName`).

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
  &wpDestFile=<Taxon - Author - photoID.jpeg>
  &wpLicense=<cc-by-4.0 | cc-by-sa-4.0 | Cc-zero>
  &wpUploadDescription=<URL-encoded wikitext>
```

`Special:Upload` form fields used:

| Param | Value |
|---|---|
| `wpSourceType` | `url` — tells the form to fetch from a remote URL (copy-upload) |
| `wpUploadFileURL` | the full-resolution photo URL (see §2) |
| `wpDestFile` | destination filename, e.g. `Taxon name - Author - <photoId>.jpeg` |
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
{{Location|<lat>|<lon>|source:iNaturalist}}   ← only when taxon_geoprivacy == "open"
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
- The `{{Location}}` line is **omitted** unless `taxon_geoprivacy == "open"` (don't leak
  obscured coordinates of threatened taxa).
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

Observation-level fields we need: `observed_on`, `place_guess`, `taxon_geoprivacy`,
`geojson.coordinates` (`[lon, lat]`), `taxon.name`, `user.{id,login,login_exact,name}`.

---

## 3. The granularity gap

Our pipeline and inat2wiki operate at different levels:

- **`checkImages.js`** finds Wikidata **taxa** (have P3151, lack P18). It already calls
  iNat (`/v1/observations/species_counts`) to confirm each taxon has *at least one*
  research-grade, compatibly-licensed photo, and `drafts.html` already renders a
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
`[[Category:<Taxon>]]`. We deliberately do **not** pull in `generateWikitext.js` here:
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

### Option A — Static enhancement of `drafts.html`

Port `get_commons_url()` into a shared JS module (e.g. `commonsUpload.js`). In
`checkImages.js`, for each image-less taxon, run the §3 photo query for a few candidates
and render them as thumbnails in `drafts.html`, each with its own pre-filled "Upload to
Commons" link.

- **Pros:** matches the requirement exactly (browse a selection → click → pre-filled
  Commons form); stays inside the current "Node script → static HTML" architecture; no new
  running service; reuses `generateWikitext.js` for categories.
- **Cons:** more iNat API calls per run (one extra photo query per taxon-with-hit); larger
  HTML; thumbnails make the page heavier.

### Option B — Small local interactive web app *(CHOSEN)*

Mirror `inat2wiki-dev` in spirit: a local server where you browse image-less taxa,
search/select observations and photos live, then click through to the pre-filled Commons
upload form. Two views (#2):

1. **Main view** — a list of image-less taxa, **similar to today's `drafts.html`** (same
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
repo's current zero-build simplicity and the closest feel to today's `drafts.html`. See
§4.2 for why **no application backend** is needed.

### Option C — Link-builder module + minimal hook

Port `get_commons_url()` only and add a single "Upload" link per existing `drafts.html`
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
  CLI tools and the data-export step; `better-sqlite3` (a native dep) is compiled once.
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
   (`getInatTaxaDb.js`, native `better-sqlite3` → Node-only) plus Wikidata SPARQL
   enumeration (`utils.js`) — heavy, batch-shaped work that cannot/should not run on a page
   load. `checkImages.js` exports the taxon list as JSON (`web/data/taxa.json`, gitignored)
   alongside `drafts.html`, via `generateImagesJson.js`.
2. **Static client app (`web/`).** Plain HTML/JS/CSS. The **main view** reads `taxa.json`.
   The **per-taxon gallery** calls the **iNat API directly from the browser** — verified
   CORS-open (`Access-Control-Allow-Origin: *`), exactly as the existing Chrome addon
   relies on. The **prefill upload URL** is built client-side (pure string assembly, §6).
   No server-side logic at any point.

**Only a trivial static file server is needed**, and only because browsers won't `fetch()`
a local JSON over `file://`. `web/serve.js` is a ~10-line zero-dependency Node static
server (`npm run web`) — this is *not* an application backend.

A real backend (Express/Fastify) only earns its keep later for: on-demand re-scanning
triggered from the UI, auth, or proxying/throttling external APIs. Out of scope for the
initial implementation.

---

## 5. Resolved decisions

1. ~~Option A / B / C~~ — **decided: Option B, in this repo (§4, §4.1).**
2. ~~Candidate sourcing~~ — **decided:** research-grade only; show **all** matching photos
   of the taxon; sort toggle **most faved** (`order_by=votes`) / **newest**
   (`created_at`). Two-view UI: a `drafts.html`-like main list, each row opening a
   per-taxon photo gallery in a new tab (§3, §4).
3. ~~Wikitext richness~~ — **decided:** keep the description minimal (inat2wiki-style, bare
   `[[Category:<Taxon>]]`); do **not** reuse `generateWikitext.js` — that detail lives on
   the category page already. Richer file-page descriptions/categories = separate future
   feature (§3).
4. ~~Defensive host check~~ — **dropped:** unnecessary. Verified that all CC-licensed
   photos (the only ones we upload) come exclusively from the allowlisted
   `inaturalist-open-data.s3.amazonaws.com`; the `photo_license` filter guarantees the host
   (§2). No fallback needed.
5. ~~Filename collisions~~ — **decided: keep** the `Taxon - Author - <photoId>.<ext>`
   scheme; the `photoId` makes it effectively unique, avoiding Commons' duplicate-name
   rejection.

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
destFile   = `${taxonName} - ${author} - ${photoId}.${ext}`
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
