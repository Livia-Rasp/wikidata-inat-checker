# iNaturalist → Commons upload app

An assisted upload step for the image pipeline. The image checker finds Wikidata taxa with
an iNaturalist ID but no image; this web app lets you browse those taxa, look at their
compatibly-licensed iNaturalist photos, and open the Wikimedia Commons upload form
**pre-filled** with everything needed — the file URL, license, filename, and a
ready-made description. You review and submit the form yourself; **nothing is uploaded
automatically**.

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
   it, tick the checkbox to mark a taxon done.
2. Click **View photos ↗** on a row to open that taxon's photo gallery in a new tab.
3. **Gallery** — all of the taxon's research-grade, Commons-compatibly-licensed
   (CC0 / CC BY / CC BY-SA) iNaturalist photos, with a **Most faved / Newest** sort toggle.
4. Click **Upload to Commons ↗** under a photo. The Commons `Special:Upload` form opens
   pre-filled; review it and click Upload there.

> To actually submit the upload you must be **logged in to Wikimedia Commons** (upload-by-URL
> requires a registered account). The app's job ends at handing you a correctly pre-filled
> form.

The app needs `web/data/taxa.json`, which `checkImages.js` regenerates on every run. Re-run
the image checker to refresh the list (and to reach new taxa as the cache fills).

## How it fits together

- `checkImages.js` exports `web/data/taxa.json` (the data contract) via
  `generateImagesJson.js` — the only link between the core tools and the app.
- The `web/` app is **static** (plain HTML/JS/CSS, no build step, no backend): it reads that
  JSON, queries the iNaturalist API directly from the browser for the gallery, and builds
  the Commons upload URL client-side. `web/serve.js` (`npm run web`) is just a static file
  server so the browser can load the JSON.
- `web/` has no code dependency on the rest of the repo, so it can be split into its own
  repository later. See [commons-upload-dev.md](commons-upload-dev.md) for the architecture.

## Attribution

The upload logic (the `Special:Upload` prefill URL and file-page wikitext in
`web/js/commonsUpload.js`) is adapted from [inat2wiki](https://github.com/lubianat/inat2wiki)
by Tiago Lubiana (@lubianat), which credits kaldari's *iNaturalist2Commons*. See
[web/README.md](../web/README.md) for the full credit.
