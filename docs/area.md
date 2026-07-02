# Area checker

Finds Wikidata taxon items that lack an image (P18) among all species observed within a geographic radius. Useful for targeting a specific location — a nature reserve, a city, a field trip area — and identifying which local species still need photos on Wikidata.

## How it works

1. Queries iNaturalist for all species with research-grade observations within the specified radius (`/v1/observations/species_counts` with `lat`, `lng`, `radius`). No license filter — the intent is to photograph these species yourself. Paginates until all results are fetched.
2. For each iNat taxon ID found, queries Wikidata via a SPARQL VALUES lookup to find items where P3151 matches and P18 (image) is absent.
3. For each qualifying taxon, fetches up to 3 sample observations from the area (ordered by community votes), providing thumbnail photos to help assess upload candidates.
4. Exports `output/area.html` — a list of taxa with their Wikidata link, iNat taxon link, observation count in the area, and clickable photo thumbnails linking to the individual observations.

No cache — results reflect live Wikidata and iNat state at the time of the run.

### Known limitation — under-filled photo/date enrichment (to fix)

The taxa list is always complete (it comes from the fully-paginated Step 1). But the photo and
"latest observation" enrichment (Steps 3a/3b in `checkArea.js`) queries **20 taxa at once
against a single fixed result window** — 60 rows for photos, 20 for dates. When a few taxa
dominate that window, the others get no rows back, so the report shows "no photo found" and a
blank date for taxa that actually *do* have qualifying observations. The date column is
worst-hit (20 taxa share only 20 rows). This misrepresents those taxa; it is slated to be
fixed by fetching per taxon instead of relying on a shared batch window. See the
`TODO(area-enrichment)` comment in `checkArea.js`.

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
| Observation count | Number of research-grade observations in the area |
| Thumbnails | Up to 3 photos from the area; each links to the iNat observation page |

Rows are sorted by observation count descending (most-observed first).

## Typical workflow

1. Run `npm run area -- <lat> <lng> <radius>` to generate `output/area.html`.
2. Open `output/area.html` in a browser.
3. Browse the thumbnails to find a good candidate photo. Click the thumbnail to open the iNat observation, then upload the photo to Commons.
4. Add the uploaded file as P18 on the Wikidata item (linked from each row).
