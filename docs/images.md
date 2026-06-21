# Image checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

> The checker also exports `web/data/taxa.json`, consumed by the assisted **iNat → Commons upload app** (`npm run web`) — pick a photo and open a pre-filled Commons upload form. See [docs/commons-upload.md](commons-upload.md).

## How it works

1. On first run, downloads the iNaturalist open-data taxa dump and builds the local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~180 MB download, shared with the links/names checkers). It then finds Wikidata taxon items that have an iNaturalist taxon ID (P3151) but no image (P18) by querying Wikidata **by iNat ID** — feeding the local iNat IDs to Wikidata in bounded `VALUES` POST batches. This avoids scanning the ~619 K no-image set directly (which WDQS times out on) and lets re-runs skip cached entries to reach genuinely new taxa. (With `--iucn <code>` it instead runs one direct query filtered by P141 — that set is small enough for WDQS to answer in seconds, so the batched scan is skipped.) See [docs/dev.md](dev.md#large-dataset-enumeration-wdqs-cant-scan-these-sets).
2. For each candidate taxon, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
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

`--limit` caps how many not-yet-cached candidate taxa are collected (each is a real no-image taxon; cached entries are skipped, so re-runs keep reaching new ones rather than re-fetching the same front-of-set). `--iucn` filters by IUCN conservation status (P141), useful for prioritising threatened species. Note the `--` separator after `npm run images` — it's required so npm forwards the flags to the script rather than interpreting them itself.

Coverage caveat: the scan only reaches Wikidata items whose P3151 points to an iNat taxon present in the local index (active taxa). Items linked to inactive/merged iNat taxa are skipped — they have no current iNat photo to source anyway.

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
| Draft Wikitext | Click to copy to clipboard. The generated Commons category Wikitext — see [Draft Wikitext contents](#draft-wikitext-contents). |

## Draft Wikitext contents

Each draft contains:

- `{{Wikidata Infobox}}`
- a **taxonavigation** block (see below)
- `{{VN}}` — only when the item has P1843 vernacular names
- NCBI / EOL / MycoBank / Index Fungorum identifier templates
- an optional `{{IUCN}}` conservation-status line (see below)
- the parent category link

**Taxonavigation.** Coleoptera and Lepidoptera taxa use the dedicated `{{Coleoptera|familia=…}}` / `{{Lepidoptera|familia=…}}` wrappers (named params for family through species plus authority; superfamily resolved automatically). All other taxa use `{{Taxonavigation|include=…}}` with the most specific matching Commons ancestor template — angiosperm families take the `(APG)` suffix (e.g. `include=Asparagaceae (APG)`), bird families `(IOC)`, fern families `(Smith)`; conifer families and higher groups (Mammalia, Reptilia, Agaricomycetes, …) use plain names. Only ranks below the `include=` level are listed manually, and rank-aware: species get `Genus|…|` + `Species|…|`, genus-rank items get `Genus|…|` only, family/order/class items use just their rank label. `authority=` is filled from NCBI (P685) where available. Full template rules: [docs/dev.md](dev.md#commons-taxonavigation-templates-generatewikitextjs).

**IUCN.** When the item has both P627 (Red List ID) and P141 (status), a `{{IUCN|code|id|name|authority}}` line is added after NCBI — it auto-categorises the Commons page into the correct IUCN maintenance category. With P141 only (no P627), a manual `[[Category:IUCN X species]]` line is added instead.

## Typical workflow

1. Run `npm run images` to scan Wikidata and iNat.
2. Open `drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy) and save.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.
5. Check the row's checkbox to mark it done. Use **Hide done** to keep the list tidy.
