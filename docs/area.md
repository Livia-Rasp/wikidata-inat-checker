# Area checker

Finds Wikidata taxon items that lack an image (P18) among the species observed within a geographic radius. Point it at a nature reserve, a city or a field trip area, and it tells you which local species still need photos on Wikidata.

This is the CLI. For picking a point on a map instead of typing coordinates, and a free preview
before spending anything, see the web app's [area picker](commons-upload.md#area-picker-areahtml).
Both run the same underlying pipeline (below) and feed the same shared backlog.

## How it works

Area is a discovery *scope* on the image kind (`{lat, lng, radius}`), alongside `--taxon` and
`--iucn`. It runs the same pipeline as `checkImages.js`. `checkArea.js` is a thin CLI wrapper
around `lib/discover.js` and `lib/areaCandidates.js`.

1. `fetchAreaSpecies` (`lib/areaCandidates.js`) queries iNaturalist for all species with
   research-grade observations within the radius (`/v1/observations/species_counts` with `lat`,
   `lng`, `radius`). It paginates until all results are fetched. There is no license filter here,
   because the intent is to photograph these species yourself.
2. `fetchAreaCandidates` cross-references those iNat taxon IDs against Wikidata via
   `fetchWdTaxaByInatIds`. That is the same P3151-present/P18-absent SPARQL lookup every other
   image-scope candidate goes through, not a separate query shape.
3. `discover()` records the result exactly like a `--taxon` or `--iucn` run. A CC-licensed photo
   and a generated draft make a candidate `open` in `data/findings.db`. An area run therefore
   feeds the shared worklist the web app and the other checkers work through, not just this report.
4. `fetchAreaEnrichment` makes one iNat request per qualifying taxon (`order_by=observed_on`),
   taking the latest observation date from the first result and up to 3 of that page's photos.
   One request per taxon rather than a shared batch, deliberately, so no taxon's enrichment can
   be crowded out by another's.
5. `generateAreaHTML` exports `output/area.html`: a list of taxa with their Wikidata link, iNat
   taxon link, observation count in the area, latest observation date, and clickable photo
   thumbnails linking to the individual observations.

No cache. Results reflect live Wikidata and iNat state at the time of the run.

## Usage

```sh
node checkArea.js --lat <lat> --lng <lng> --radius <km>
npm run area -- --lat <lat> --lng <lng> --radius <km>
```

Example (10 km around Munich city centre):

```sh
npm run area -- --lat 48.147 --lng 11.589 --radius 10
```

## output/area.html layout

| Element | Description |
|---|---|
| Taxon name | Scientific name (linked to iNat taxon page) and common name if available |
| Wikidata | QID link to the Wikidata item |
| Obs. | Number of research-grade observations in the area (sortable) |
| Latest obs. | Date of the most recent observation in the area (sortable) |
| Thumbnails | Up to 3 photos from the area; each links to the iNat observation page |

Rows arrive sorted by **latest observation date**, newest first, with the observation count as the
tiebreak. What is being seen right now ends up at the top. Click the **Obs.** or **Latest obs.**
header to re-sort on that column; click again to reverse the direction.

## Typical workflow

1. Run `npm run area -- <lat> <lng> <radius>` to generate `output/area.html`.
2. Open `output/area.html` in a browser.
3. Browse the thumbnails to find a good candidate photo. Click the thumbnail to open the iNat observation, then upload the photo to Commons.
4. Add the uploaded file as P18 on the Wikidata item (linked from each row).
