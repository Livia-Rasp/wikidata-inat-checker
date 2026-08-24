# Image checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

> The findings this records are also the worklist of the assisted **iNat → Commons upload app** (`npm run web`), which reads them live from `GET /api/findings`. Pick a photo, open a pre-filled Commons upload form, then confirm the edit landed. See [docs/commons-upload.md](commons-upload.md).

## How it works

1. On first run, downloads the iNaturalist open-data taxa dump and builds the local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~189 MB download, shared with the links and names checkers).

   It then finds Wikidata taxon items that have an iNaturalist taxon ID (P3151) but no image (P18), by querying Wikidata **by iNat ID**: the local iNat IDs are fed to Wikidata in bounded `VALUES` POST batches. This avoids scanning the ~619 K no-image set directly, which WDQS times out on. It also lets re-runs skip cached entries and reach genuinely new taxa.

   `--iucn <code>` instead runs one direct query filtered by P141. That set is small enough for WDQS to answer in seconds, so the batched scan is skipped. See [docs/dev.md](dev.md#large-dataset-enumeration-wdqs-cant-scan-these-sets).
2. For each candidate taxon, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
3. For each taxon with a hit, queries Wikidata for taxon name, NCBI/EOL/MycoBank/Index Fungorum identifiers, Wikispecies page, taxonomy (class through genus), and "endemic to" places (P183). Then generates a draft Commons category Wikitext.
4. Exports all drafts to `output/drafts.html`: a done checkbox, a Wikidata item link, the IUCN status, a filtered iNaturalist observations link, a Commons category edit link, and the draft Wikitext. Clicking the draft text copies it.

iNat queries are batched through `/v1/observations/species_counts`, up to 200 taxa per request. A 5000-taxon scan therefore takes about a minute and stays within iNat's recommended ~1 request/second rate. The number of taxa per run is configurable, see [Usage](#usage).

Results are recorded in the **findings database** at `data/findings.db`. That is what makes the backlog survive. Every outcome is stored, so re-runs skip taxa already dealt with, and `output/drafts.html` shows the whole accumulated open worklist rather than just the latest run's.

Three statuses: `open` (CC photos found and a draft built), `no_draft` (photos found but no draft was possible, because of a missing P225 or a missing family template), and `no_photos`. A taxon whose iNat request *failed* is not recorded at all, so it is retried next run rather than written off.

`no_photos` and `no_draft` are observations with a shelf life, not verdicts. CC-licensed photos keep being uploaded and missing P225s keep being filled in. So both carry a `checked_at` and expire after `--recheck-after` days (default 90), at which point the taxon becomes a candidate again. Settled outcomes never expire.

Unlike `output/` and `cache/`, **`data/` is not safe to delete.** It is the only record of what has been found and worked through.

## Verification

Wikidata is a wiki, so a finding can stop being work while it sits in the backlog. Somebody else adds the image, or the item is merged away or deleted. `npm run verify` (`verifyFindings.js`) reconciles the open backlog against live Wikidata, then re-renders `output/drafts.html` so the report stops offering work already done. The web app needs no re-render. It reads the same database live.

**Verification is not the same test as the app's Confirm button.** That is deliberate. Verify asks "does this taxon still need an image?", so anybody's P18 resolves it to `fixed_upstream`. Confirm asks "did *my* edit land in full?" This app emits two statements per taxon, so Confirm requires the P18 *and* the Commons-category sitelink before writing `done`.

One consequence is worth knowing. A taxon whose sitelink half failed will refuse to confirm, then later be swept to `fixed_upstream`: it no longer needs an image, even though your batch was only half-applied. See [dev.md](dev.md#confirming-libconfirmjs--and-why-it-is-not-verification).

```sh
npm run verify                    # verify the whole open backlog
npm run verify -- --limit 200     # cap one pass
npm run verify -- --kind image    # default
```

| What it finds | New status |
|---|---|
| P18 has appeared since discovery | `fixed_upstream` (the filename is recorded) |
| Item merged or deleted | `gone` |
| Still no image | stays `open`, `verified_at` refreshed |

Resolved findings leave the worklist but stay in the database, so discovery never rediscovers them.

**It reads the Action API, never SPARQL.** WDQS is an eventually-consistent index. Its lag is usually seconds and occasionally hours, and it fails in the worst possible way here: right after a QuickStatements batch it may not show the edit yet, so a re-check would report the image still missing and you would add a second one. `wbgetentities` reads the live database, 50 items per request.

Requests carry `redirects=no`, which makes the API report a redirect exactly like a deleted entity. Merged and deleted both become `gone`, so one check covers both. The trade-off is that the record does not distinguish them, or say where a merged item went.

A separate cache, `cache/cache-commons-cats.json`, records which `Endemic <group> of <place>` categories exist on Commons (see [Endemic](#endemic) below), so those existence checks are reused across runs. Delete it to re-verify against Commons.

## Usage

```sh
npm run images                         # default: 5000 taxa
npm run images -- --limit 500          # custom limit
npm run images -- --limit 500 --iucn VU  # limit + IUCN status filter (VU, EN, CR, NT, DD, EX, EW, LC, NE)
npm run images -- --taxon Orchidaceae  # scope the scan to one clade (orchids only)
npm run images -- --taxon 47217 --iucn EN  # by iNat ID, combined with an IUCN filter
npm run images -- --limit 500 --seed 7     # different shuffle of the scan order
```

`--limit` caps how many not-yet-cached candidate taxa are collected. Each is a real no-image taxon, and cached entries are skipped, so re-runs keep reaching new ones rather than re-fetching the same front-of-set. `--iucn` filters by IUCN conservation status (P141), which is how you prioritise threatened species. The `--` separator after `npm run images` is required, or npm interprets the flags itself instead of forwarding them.

The candidate ID list is shuffled before `--limit` caps it, so a limited scan does not always hit the same slice of that list's incidental order. That list is either the whole local index or a `--taxon` clade's descendant set. The shuffle uses a seeded PRNG, so the same seed always reproduces the same order; `--seed <n>` (default `42`) picks a different sample. `--iucn` needs no shuffle, because that set is queried directly from Wikidata rather than enumerated by id.

`--taxon <name|id>` scopes the run to a single clade: the given taxon **plus all of its iNat descendants**. It accepts a scientific name (`Orchidaceae`) or a numeric iNat taxon ID (`47217`), and composes with `--iucn` and `--limit`. The clade is computed locally from the iNat taxa index's `ancestry` paths, one sub-second SQLite scan, so a scoped run is typically *faster* than an unscoped one. Only the clade's IDs are sent to Wikidata.

An **ambiguous** name is a homonym shared by two or more taxa, such as `Iris`. The checker prints the candidate iNat IDs and ranks, then exits, so you can re-run with the exact ID. An unknown name exits with a "not found" message.

Coverage caveat: the scan only reaches Wikidata items whose P3151 points to an iNat taxon present in the local index, meaning active taxa. Items linked to inactive or merged iNat taxa are skipped. They have no current iNat photo to source anyway.

| File | Description |
|---|---|
| `output/drafts.html` | Human-readable overview of all drafts. See below for column details. |

## output/drafts.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done. State persists in `localStorage` across page reloads — the checker cannot see it, so a ticked row stays `open` in the database. Use the **Hide done** button to collapse completed rows. |
| Wikidata item | Link to the Wikidata entity (e.g. `Q15438811`). |
| IUCN | The taxon's Red List category, in the Red List's own colours. Added when the backlog started accumulating across runs: without it there is no way to tell what a row is or what to prioritise. |
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
- optional **endemic** category link(s) (see below)

**Taxonavigation.** Coleoptera and Lepidoptera taxa use the dedicated `{{Coleoptera|familia=…}}` and `{{Lepidoptera|familia=…}}` wrappers, which take named params for family through species plus authority and resolve superfamily automatically.

All other taxa use `{{Taxonavigation|include=…}}` with the most specific matching Commons ancestor template. Angiosperm families take the `(APG)` suffix (`include=Asparagaceae (APG)`), bird families `(IOC)`, fern families `(Smith)`. Conifer families and higher groups such as Mammalia, Reptilia and Agaricomycetes use plain names.

Only ranks below the `include=` level are listed manually, and the listing is rank-aware. Species get `Genus|…|` plus `Species|…|`. Genus-rank items get `Genus|…|` only. Family, order and class items use just their rank label. `authority=` is filled from NCBI (P685) where available. Full template rules: [docs/dev.md](dev.md#commons-taxonavigation-templates-libgeneratewikitextjs).

**IUCN.** When the item has both P627 (Red List ID) and P141 (status), a `{{IUCN|code|id|name|authority}}` line is added after NCBI. That template auto-categorises the Commons page into the correct IUCN maintenance category. With P141 only, a manual `[[Category:IUCN X species]]` line is added instead.

### Endemic

When the item has P183 (**endemic to**), the draft adds the matching Commons `Endemic <group> of <place>` category. P183 = Tanzania on a frog yields `[[Category:Endemic fauna of Tanzania]]`.

For each place the taxon is endemic to, candidate categories are tried most-specific first and only emitted if they actually exist on Commons. Soft redirects are followed. Two axes vary:

- **group word**, from the taxon's ancestry. A specific class word (`birds`, `mammals`, `amphibians`, `reptiles`, `fish`) when one applies, otherwise the kingdom word (`fauna`, `flora`, `fungi`), with `species` as a final fallback. So a bird endemic to Australia gets `Endemic birds of Australia`, while a frog with no `Endemic amphibians of …` category falls back to `Endemic fauna of …`.
- **place**, from the P183 value's English label, trying both `… of <place>` and `… of the <place>`.

Nothing is emitted when the taxon has no P183, or when no matching category exists on Commons. The usual cause of the latter is a Wikidata label that differs from the Commons place name, like "Taiwan Island" against "Taiwan". Existence results are cached in `cache/cache-commons-cats.json`. Implementation: [docs/commons-integration.md](commons-integration.md) and [docs/dev.md](dev.md).

## Generating a single category draft

A draft's parent category link, such as `[[Category:Cornicandovia|australica]]`, sometimes points to a Commons category that does not exist yet. The genus or family page still has to be created. `draftCategory.js` generates a draft for any taxon **from just its Wikidata QID**, using the same schema as the image checker: Taxonavigation, ID templates, IUCN, endemic categories, parent category link.

```sh
node draftCategory.js Q14625955            # genus Cornicandovia
npm run draft -- Q14625955 Q10459793       # multiple QIDs at once (-- forwards the args)
```

Each draft is printed to stdout under a `== Category:<name> ==` header. QIDs may be given bare (`Q14625955`), prefixed (`wd:Q14625955`), or as full entity URLs. It builds purely from Wikidata, so it works at any rank regardless of whether the taxon has iNat photos. A QID that is not a taxon, or that lacks a scientific name (P225), is reported on stderr and skipped. See [Draft Wikitext contents](#draft-wikitext-contents) for what the draft includes.

## Typical workflow

**The app is the worklist. `output/drafts.html` is the fallback view.** Run `npm run images` to
fill the backlog, then `npm run web` and work through it there. The app lists each taxon's photos,
pre-fills the Commons upload form, and confirm-gates the done state in the database. See
[commons-upload.md](commons-upload.md).

The report is for working offline, or without the server:

1. Run `npm run images` to scan Wikidata and iNat.
2. Open `output/drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy) and save.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.
5. Check the row's checkbox to mark it done, and use **Hide done** to keep the list tidy. That tick lives in `localStorage`, so it hides the row and nothing more. The finding stays `open` until the app confirms it, or until `npm run verify` sees the P18 you added and resolves it to `fixed_upstream`.
