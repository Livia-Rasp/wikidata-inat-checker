# Image checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

## How it works

1. Queries Wikidata via SPARQL for taxon items that have an iNaturalist taxon ID (P3151) but no image (P18).
2. For each of those taxa, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
3. For each taxon with a hit, queries Wikidata for taxon name, NCBI/EOL/MycoBank/Index Fungorum identifiers, Wikispecies page, and taxonomy (class through genus) and generates a draft Commons category Wikitext.
4. Exports all drafts to `drafts.html` — a table with five columns: a done checkbox, a Wikidata item link, a filtered iNaturalist observations link, a Commons category edit link, and the draft Wikitext. Clicking the draft text copies it to the clipboard.

iNat queries are batched via the `/v1/observations/species_counts` endpoint (up to 200 taxa per request), so a 5000-taxon scan takes about a minute while staying within iNat's recommended ~1 request/second rate. The number of taxa per run is configurable — see [Usage](#usage).

Results are cached locally in `cache-images.json` so re-runs skip taxa already checked in a prior session. Delete the file to force a full re-scan.

## Usage

```sh
npm run images                         # default: 5000 taxa
npm run images -- --limit 500          # custom limit
npm run images -- --limit 500 --iucn VU  # limit + IUCN status filter (VU, EN, CR, NT, DD, EX, EW, LC, NE)
```

`--limit` is passed to the SPARQL `LIMIT` clause, controlling how many image-less taxa are fetched from Wikidata. `--iucn` filters by IUCN conservation status (P141), which is useful for prioritising threatened species. Note the `--` separator after `npm run images` — it's required so npm forwards the flags to the script rather than interpreting them itself.

| File | Description |
|---|---|
| `drafts.html` | Human-readable overview of all drafts. See below for column details. |

## drafts.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done. State persists in `localStorage` across page reloads. Use the **Hide done** button to collapse completed rows. |
| Wikidata item | Link to the Wikidata entity (e.g. `Q15438811`). |
| iNat taxon | Link to the filtered iNaturalist observations page for that taxon (research-grade, CC0/CC-BY/CC-BY-SA), so you can preview candidate photos without a separate lookup. |
| Commons category | Opens the Commons category page in edit mode — ready to paste if it doesn't exist yet, or to edit if it does. |
| Draft Wikitext | Click to copy to clipboard. Includes `{{Wikidata Infobox}}`, a taxonavigation block, `{{VN}}` (only when P1843 vernacular names are present), NCBI/EOL/MycoBank/Index Fungorum identifier templates, an optional `{{IUCN}}` conservation status link, and the parent category link. Details: **Taxonavigation** — Coleoptera taxa use `{{Coleoptera\|familia=…\|…}}` and Lepidoptera taxa use `{{Lepidoptera\|familia=…\|…}}` (dedicated wrapper templates with named params for family through species and authority; superfamily resolved automatically). All other taxa use `{{Taxonavigation\|include=…}}` with the most specific matching ancestor template from Commons: angiosperm families use the `(APG)` suffixed form (e.g. `include=Asparagaceae (APG)`), bird families the `(IOC)` form, fern families the `(Smith)` form; conifer families and higher-level groups (Mammalia, Reptilia, Agaricomycetes, …) use plain names. Only ranks below the include= level are listed manually. Rank-aware: species get `Genus|…|` + `Species|…|`, genus-rank items get `Genus|…|` only, family/order/class items use their rank label with no genus/species lines. `authority=` is populated automatically from NCBI (P685) where available. **IUCN** — when the Wikidata item has both P627 (IUCN Red List ID) and P141 (conservation status), a `{{IUCN\|code\|id\|name\|authority}}` line is added after NCBI; this template auto-categorizes the Commons page into the correct IUCN maintenance category. If only P141 is present (no P627), a manual `[[Category:IUCN X species]]` line is added instead. |

## Typical workflow

1. Run `npm run images` to scan Wikidata and iNat.
2. Open `drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy) and save.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.
5. Check the row's checkbox to mark it done. Use **Hide done** to keep the list tidy.
