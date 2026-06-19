# Area checker

Finds Wikidata taxon items that lack an image (P18) among all species observed within a geographic radius. Useful for targeting a specific location — a nature reserve, a city, a field trip area — and identifying which local species still need photos on Wikidata.

## How it works

1. Queries iNaturalist for all species with research-grade observations within the specified radius (`/v1/observations/species_counts` with `lat`, `lng`, `radius`). No license filter — the intent is to photograph these species yourself. Paginates until all results are fetched.
2. For each iNat taxon ID found, queries Wikidata via a SPARQL VALUES lookup to find items where P3151 matches and P18 (image) is absent.
3. For each qualifying taxon, fetches up to 3 sample observations from the area (ordered by community votes), providing thumbnail photos to help assess upload candidates.
4. Exports `area.html` — a list of taxa with their Wikidata link, iNat taxon link, observation count in the area, and clickable photo thumbnails linking to the individual observations.

No cache — results reflect live Wikidata and iNat state at the time of the run.

## Usage

```sh
node checkArea.js <lat> <lng> <radius_km>
npm run area -- <lat> <lng> <radius_km>
```

Example (10 km around Munich city centre):

```sh
npm run area -- 48.147 11.589 10
```

## area.html layout

| Element | Description |
|---|---|
| Taxon name | Scientific name (linked to iNat taxon page) and common name if available |
| Wikidata | QID link to the Wikidata item |
| Observation count | Number of research-grade observations in the area |
| Thumbnails | Up to 3 photos from the area; each links to the iNat observation page |

Rows are sorted by observation count descending (most-observed first).

## Typical workflow

1. Run `npm run area -- <lat> <lng> <radius>` to generate `area.html`.
2. Open `area.html` in a browser.
3. Browse the thumbnails to find a good candidate photo. Click the thumbnail to open the iNat observation, then upload the photo to Commons.
4. Add the uploaded file as P18 on the Wikidata item (linked from each row).
