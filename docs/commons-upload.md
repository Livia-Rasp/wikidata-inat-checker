# iNaturalist → Commons upload app

An assisted upload step for the image pipeline. The image checker finds Wikidata taxa with
an iNaturalist ID but no image; this web app lets you browse those taxa, look at their
compatibly-licensed iNaturalist photos, and open the Wikimedia Commons upload form
**pre-filled** with everything needed — the file URL, license, filename, and a detailed,
ready-made description (see [What the file description contains](#what-the-file-description-contains)).
You review and submit the form yourself; **nothing is uploaded automatically**.

The design rationale, the inat2wiki prior art it builds on, and the technical research
behind it are in the [design & research record](commons-upload-dev.md).

## Usage

```sh
node checkImages.js        # (or npm run images) — also writes web/data/taxa.json
npm run web                # serve the app at http://localhost:8080
```

Then open <http://localhost:8080/>:

1. **Main view** — a table of image-less taxa (Wikidata item, iNat taxon, Commons category,
   draft category Wikitext). Same look and behaviour as `drafts.html`: click a draft to copy
   it, tick the checkbox to mark a taxon done. A **Download uploaded list** button exports
   what you've marked uploaded (see [Tracking uploads](#tracking-uploads)).
2. Click **View photos ↗** on a row to open that taxon's photo gallery in a new tab.
3. **Gallery** — all of the taxon's research-grade, Commons-compatibly-licensed
   (CC0 / CC BY / CC BY-SA) iNaturalist photos, with a **Most faved / Newest** sort toggle.
4. Click **Upload to Commons ↗** under a photo. The Commons `Special:Upload` form opens
   pre-filled; review it and click Upload there. Then tick **Mark as uploaded** on the card.
5. On the photo you uploaded, tick **Use as Wikidata image (P18)** — exactly one photo per
   taxon. This records the file as the item's image and queues the taxon's QuickStatements on
   the main view (see [Adding P18 + category in batches](#adding-p18--category-in-batches)).

> To actually submit the upload you must be **logged in to Wikimedia Commons** (upload-by-URL
> requires a registered account). The app's job ends at handing you a correctly pre-filled
> form.

The app needs `web/data/taxa.json`, which `checkImages.js` regenerates on every run. Re-run
the image checker to refresh the list (and to reach new taxa as the cache fills).

## What the file description contains

The pre-filled file page is built to be comprehensive but not overloaded. For a photo it
produces wikitext like:

```wikitext
{{Information
|description= {{en|Red-bellied Woodpecker (''Melanerpes carolinus'') in Grayson, Texas, United States}}
|date={{Taken on|2023-02-21|location=United States}}
|source=https://www.inaturalist.org/photos/258148165
|author=[https://www.inaturalist.org/users/24783 Matt DeLozier]
|permission=
|other versions=
}}
{{Location|33.7147|-96.4892|source:iNaturalist|prec=15}}

{{iNaturalist|149781312}}

{{INaturalistreview}}
[[Category:Melanerpes carolinus]]
[[Category:Picidae of Texas]]
[[Category:Grayson County, Texas]]
```

Where each piece comes from:

- **Description** — `{{en|<English common name> (''Scientific name'') in County, State,
  Country}}`, from the observation's *identified* taxon (so a subspecies keeps its precise
  name) and its location. The common name is dropped when iNaturalist has none; the location
  uses whatever administrative levels resolve, and is dropped entirely if none do.
- **Date** — `{{Taken on|<observed date>|location=<Country>}}`, so the file is categorised by
  both date and country. (Falls back to a plain `{{Taken on|<date>}}` when no country.)
- **`{{Location}}`** — the observation's public coordinates, with `prec=<metres>` carrying
  the accuracy radius (`public_positional_accuracy`). Obscured records (threatened taxa, or a
  user's own geoprivacy setting) return a randomized point with a large radius (e.g. ~29 km),
  so `prec` records that the location is coarse rather than implying false precision.
- **`{{iNaturalist}}` + `{{INaturalistreview}}`** — link the source observation and flag the
  file for the Commons license-review bot.
- **Species category** — `[[Category:<Taxon>]]` for the taxon you're sourcing the image for.
- **Geographic categories** — up to two, capturing **two independent axes** so a photo is
  filed as specifically as possible on both:
  - a **taxon-in-place** category — the most *taxon*-specific existing one (e.g.
    `Picidae of Texas`, `Odonata of Argentina`, `Fabaceae in Hawaii`); the place falls back to
    a coarser level when a finer one has no category. Both prepositions (`of`/`in`) are tried,
    plants/animals/fungi map to `Flora`/`Animals`/`Fungi`, and soft redirects (e.g.
    `Plants of Hawaii` → `Flora of Hawaii`) are followed so images never land in a redirect.
  - a **most-specific location** category — the finest *place* available, as
    `Flora/Fauna/Fungi of <place>` if that exists, else `Nature of <place>` (the all-organisms
    category, e.g. `Nature of Pasco Department`), else the plain place category named the way
    Commons does (a county is `Grayson County, Texas`, a town `Williston, Vermont` — never the
    bare iNat name, which would hit an unrelated page). The finest place comes from iNat's
    `place_ids` plus an OpenStreetMap (Nominatim) reverse-geocode of the coordinates, which
    adds the municipality/town level (and any missing county) iNat lacked.
  - **No redundancy:** if one of the two is a subcategory of the other (e.g. the taxon-in-place
    category already sits at the finest place), only the more specific is kept; otherwise both
    are added. Each is emitted only when a real category exists.
- **Author category** — if the photographer has a Commons category, it's added too. It's
  discovered from the iNaturalist user ID via Commons' `{{Inaturalist user}}` template and
  Wikidata's *iNaturalist user ID* property (P12022) — so it currently matches only the
  handful of photographers who have such a category.

All of the location/category lookups are cached in your browser, so repeated photos and
re-visits are fast.

## Tracking uploads

The app can't tell whether an upload actually went through (it just opens the Commons form in
a new tab). So after you submit a file, tick **Mark as uploaded** on its card — it gets an
"uploaded" badge and is remembered in your browser. The main page's **Download uploaded
list** button exports the set as JSON (`{ "exported": …, "uploaded": [ "<filename>", … ] }`).

> Note: the per-tool tracking category (`Media uploaded with wikidata-inat-checker`) is
> intentionally **not** added yet, since the tool isn't public. The uploaded-files list is
> what lets those files be back-filled with the category once it is.

## Adding P18 + category in batches

Uploading the file to Commons still leaves two edits on the **Wikidata** item: setting the
image (**P18**) and linking the Commons category. The app collects these into a
[QuickStatements](https://quickstatements.toolforge.org) batch so you can apply many at once
instead of editing items one by one.

- In a taxon's gallery, ticking **Use as Wikidata image (P18)** on the uploaded photo records
  that file as the item's image. Only one photo per taxon can be picked; it also marks the
  taxon **done** and uploaded.
- The main view has a **QuickStatements** panel at the top. For every taxon that is *done and
  has a picked image*, it emits two tab-separated commands:

  ```
  Q10444353	P18	"Cedarbergeniana imperfecta - 15895773.jpg"
  Q10444353	Scommonswiki	"Category:Cedarbergeniana imperfecta"
  ```

  The first sets the image; the second adds the **Commons-category sitelink** (the
  "Other sites" / Multilingual Sites link — not the P373 statement). The category is the
  taxon's own name; the filename is the one the upload form used.
- Click **Copy & clear**, paste into the QuickStatements *Import* box, and run the batch. The
  picks are then **flushed** from the panel, so the same edit can never be applied twice.

The panel is built entirely in the browser from the picks you make (kept in `localStorage`);
nothing is submitted to Wikidata automatically.

## How it fits together

- `checkImages.js` exports `web/data/taxa.json` (the data contract) via
  `generateImagesJson.js` — the only link between the core tools and the app.
- The `web/` app is **static** (plain HTML/JS/CSS, no build step, no backend): it reads that
  JSON and, from the browser, queries the iNaturalist API (photos, places, taxon ancestry),
  Commons (category existence, author categories), and the Wikidata Query Service (author
  categories) — all CORS-open — then builds the Commons upload URL client-side.
  `web/serve.js` (`npm run web`) is just a static file server so the browser can load the JSON.
- `web/` has no code dependency on the rest of the repo, so it can be split into its own
  repository later. See [commons-upload-dev.md](commons-upload-dev.md) for the architecture.

## Attribution

The upload logic (the `Special:Upload` prefill URL and file-page wikitext in
`web/js/commonsUpload.js`) is adapted from [inat2wiki](https://github.com/lubianat/inat2wiki)
by Tiago Lubiana (@lubianat), which credits kaldari's *iNaturalist2Commons*. See
[web/README.md](../web/README.md) for the full credit.
