# Image checker

Finds [iNaturalist](https://www.inaturalist.org/) observations with Wikimedia-Commons-compatible licenses for Wikidata taxon items that do not yet have an image. Useful for sourcing candidate photos to upload to Commons and then add to the corresponding Wikidata entry.

> The findings this records are also the worklist of the assisted **iNat → Commons upload app** (`npm run web`), which reads them live from `GET /api/findings` — pick a photo, open a pre-filled Commons upload form, then confirm the edit landed. See [docs/commons-upload.md](commons-upload.md).

## How it works

1. On first run, downloads the iNaturalist open-data taxa dump and builds the local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~180 MB download, shared with the links/names checkers). It then finds Wikidata taxon items that have an iNaturalist taxon ID (P3151) but no image (P18) by querying Wikidata **by iNat ID** — feeding the local iNat IDs to Wikidata in bounded `VALUES` POST batches. This avoids scanning the ~619 K no-image set directly (which WDQS times out on) and lets re-runs skip cached entries to reach genuinely new taxa. (With `--iucn <code>` it instead runs one direct query filtered by P141 — that set is small enough for WDQS to answer in seconds, so the batched scan is skipped.) See [docs/dev.md](dev.md#large-dataset-enumeration-wdqs-cant-scan-these-sets).
2. For each candidate taxon, asks iNat whether there is at least one research-grade observation whose photo is licensed CC0, CC BY, or CC BY-SA. All data is kept in memory.
3. For each taxon with a hit, queries Wikidata for taxon name, NCBI/EOL/MycoBank/Index Fungorum identifiers, Wikispecies page, taxonomy (class through genus), and "endemic to" places (P183), then generates a draft Commons category Wikitext.
4. Exports all drafts to `output/drafts.html` — a done checkbox, a Wikidata item link, the IUCN status, a filtered iNaturalist observations link, a Commons category edit link, and the draft Wikitext. Clicking the draft text copies it to the clipboard.

iNat queries are batched via the `/v1/observations/species_counts` endpoint (up to 200 taxa per request), so a 5000-taxon scan takes about a minute while staying within iNat's recommended ~1 request/second rate. The number of taxa per run is configurable — see [Usage](#usage).

Results are recorded in the **findings database** at `data/findings.db`, which is what makes the backlog survive: every outcome is stored, so re-runs skip taxa already dealt with *and* `output/drafts.html` shows the whole accumulated open worklist rather than just the latest run's. Statuses are `open` (CC photos found and a draft built), `no_draft` (photos found but no draft was possible — no P225, or the family template is missing), and `no_photos`. A taxon whose iNat request *failed* is recorded not at all, so it is retried next run rather than written off.

`no_photos` and `no_draft` are observations with a shelf life, not verdicts — CC-licensed photos keep being uploaded and missing P225s keep being filled in — so they carry a `checked_at` and expire after `--recheck-after` days (default 90), at which point the taxon becomes a candidate again. Settled outcomes never expire. Unlike `output/` and `cache/`, **`data/` is not safe to delete**: it is the only record of what has been found and worked through.

## Verification

Wikidata is a wiki, so a finding can stop being work while it sits in the backlog: somebody else adds the image, or the item is merged away or deleted. `npm run verify` (`verifyFindings.js`) reconciles the open backlog against live Wikidata and then re-renders `output/drafts.html`, so the report stops offering work already done. The web app needs no re-render — it reads the same database live.

**Verification is not the same test as the app's Confirm button**, deliberately. Verify asks "does this taxon still need an image?", so anybody's P18 resolves it to `fixed_upstream`. Confirm asks "did *my* edit land in full?", and this app emits two statements per taxon, so it requires the P18 *and* the Commons-category sitelink before writing `done`. A taxon whose sitelink half failed will therefore refuse to confirm and later be swept to `fixed_upstream` — it no longer needs an image, even though your batch was half-applied. See [dev.md](dev.md#confirming-libconfirmjs--and-why-it-is-not-verification).

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

**It reads the Action API, never SPARQL.** WDQS is an eventually-consistent index whose lag is usually seconds and occasionally hours, and it fails in the worst possible way here: immediately after a QuickStatements batch it may not show the edit yet, so a re-check would report the image still missing and you would add a second one. `wbgetentities` reads the live database, 50 items per request. Requests carry `redirects=no`, which makes the API report a redirect exactly like a deleted entity — since merged and deleted both become `gone`, one check covers both. The trade-off: the record does not distinguish them, or say where a merged item went.

A separate cache, `cache/cache-commons-cats.json`, records which `Endemic <group> of <place>` categories exist on Commons (see [Endemic](#endemic) below) so those existence checks are reused across runs; delete it to re-verify against Commons.

## Usage

```sh
npm run images                         # default: 5000 taxa
npm run images -- --limit 500          # custom limit
npm run images -- --limit 500 --iucn VU  # limit + IUCN status filter (VU, EN, CR, NT, DD, EX, EW, LC, NE)
npm run images -- --taxon Orchidaceae  # scope the scan to one clade (orchids only)
npm run images -- --taxon 47217 --iucn EN  # by iNat ID, combined with an IUCN filter
```

`--limit` caps how many not-yet-cached candidate taxa are collected (each is a real no-image taxon; cached entries are skipped, so re-runs keep reaching new ones rather than re-fetching the same front-of-set). `--iucn` filters by IUCN conservation status (P141), useful for prioritising threatened species. Note the `--` separator after `npm run images` — it's required so npm forwards the flags to the script rather than interpreting them itself.

`--taxon <name|id>` scopes the run to a single clade — the given taxon **plus all of its iNat descendants**. It accepts either a scientific name (`Orchidaceae`) or a numeric iNat taxon ID (`47217`). The clade is computed locally from the iNat taxa index's `ancestry` paths (a single sub-second SQLite scan), so a scoped run is typically *faster* than an unscoped one: only the clade's IDs are sent to Wikidata. It composes with `--iucn` and `--limit` (e.g. endangered orchids). If a name is **ambiguous** (a homonym shared by 2+ taxa, e.g. `Iris`), the checker prints the candidate iNat IDs and ranks and exits so you can re-run with the exact ID; an unknown name exits with a "not found" message.

Coverage caveat: the scan only reaches Wikidata items whose P3151 points to an iNat taxon present in the local index (active taxa). Items linked to inactive/merged iNat taxa are skipped — they have no current iNat photo to source anyway.

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

**Taxonavigation.** Coleoptera and Lepidoptera taxa use the dedicated `{{Coleoptera|familia=…}}` / `{{Lepidoptera|familia=…}}` wrappers (named params for family through species plus authority; superfamily resolved automatically). All other taxa use `{{Taxonavigation|include=…}}` with the most specific matching Commons ancestor template — angiosperm families take the `(APG)` suffix (e.g. `include=Asparagaceae (APG)`), bird families `(IOC)`, fern families `(Smith)`; conifer families and higher groups (Mammalia, Reptilia, Agaricomycetes, …) use plain names. Only ranks below the `include=` level are listed manually, and rank-aware: species get `Genus|…|` + `Species|…|`, genus-rank items get `Genus|…|` only, family/order/class items use just their rank label. `authority=` is filled from NCBI (P685) where available. Full template rules: [docs/dev.md](dev.md#commons-taxonavigation-templates-libgeneratewikitextjs).

**IUCN.** When the item has both P627 (Red List ID) and P141 (status), a `{{IUCN|code|id|name|authority}}` line is added after NCBI — it auto-categorises the Commons page into the correct IUCN maintenance category. With P141 only (no P627), a manual `[[Category:IUCN X species]]` line is added instead.

### Endemic

When the item has P183 (**endemic to**), the draft adds the matching Commons `Endemic <group> of <place>` category — e.g. P183 = Tanzania on a frog yields `[[Category:Endemic fauna of Tanzania]]`. For each place the taxon is endemic to, candidate categories are tried most-specific → general and only emitted if they actually exist on Commons (soft redirects followed):

- **group word**, by the taxon's ancestry: a specific class word (`birds`, `mammals`, `amphibians`, `reptiles`, `fish`) when one applies, else the kingdom word (`fauna` / `flora` / `fungi`), with `species` as a final fallback — so a bird endemic to Australia gets `Endemic birds of Australia`, while a frog with no `Endemic amphibians of …` category falls back to `Endemic fauna of …`;
- **place**, from the P183 value's English label, trying both `… of <place>` and `… of the <place>`.

Nothing is emitted when the taxon has no P183, or when no matching category exists on Commons (e.g. the place's Wikidata label differs from the Commons place name, like "Taiwan Island" vs "Taiwan"). Existence results are cached in `cache/cache-commons-cats.json`. Implementation: [docs/commons-integration.md](commons-integration.md) and [docs/dev.md](dev.md).

## Generating a single category draft

A draft's parent category link (e.g. `[[Category:Cornicandovia|australica]]`) sometimes points to a Commons category that doesn't exist yet — the genus/family page still has to be created. `draftCategory.js` generates a draft for any taxon **from just its Wikidata QID**, using the exact same schema as the image checker (Taxonavigation, ID templates, IUCN, endemic categories, parent category link):

```sh
node draftCategory.js Q14625955            # genus Cornicandovia
npm run draft -- Q14625955 Q10459793       # multiple QIDs at once (-- forwards the args)
```

Each draft is printed to stdout under a `== Category:<name> ==` header. QIDs may be given bare (`Q14625955`), prefixed (`wd:Q14625955`), or as full entity URLs. It builds purely from Wikidata, so it works for any rank (genus, family, …) regardless of whether the taxon has iNat photos. A QID that isn't a taxon (or lacks a scientific name, P225) is reported on stderr and skipped. See [Draft Wikitext contents](#draft-wikitext-contents) for what the draft includes.

## Typical workflow

**The app is the worklist; `output/drafts.html` is the fallback view.** Run `npm run images` to
fill the backlog, then `npm run web` and work through it there — it lists each taxon's photos,
pre-fills the Commons upload form, and confirm-gates the done state in the database. See
[commons-upload.md](commons-upload.md).

The report is for working offline, or without the server:

1. Run `npm run images` to scan Wikidata and iNat.
2. Open `output/drafts.html` in a browser.
3. For each row: click the iNat link to preview candidate photos, then click the Commons link to open the category editor. Paste the draft (click to copy) and save.
4. Upload a suitable iNat photo to Commons (CC0/CC BY/CC BY-SA, research grade) and add it as P18 on the Wikidata item.
5. Check the row's checkbox to mark it done, and use **Hide done** to keep the list tidy. That tick lives in `localStorage`, so it hides the row and nothing more — the finding stays `open` until the app confirms it, or until `npm run verify` sees the P18 you added and resolves it to `fixed_upstream`.
