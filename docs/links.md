# iNat links checker

Finds Wikidata taxon items with no iNaturalist taxon ID (P3151) at all, matches them against iNaturalist's full taxonomy, and produces QuickStatements to add the missing link.

## How it works

1. On first run, downloads the iNaturalist open-data taxa dump (~180 MB, 1.4 M active taxa) from the iNat S3 bucket and builds a local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~124 MB). The download is refreshed automatically every 30 days; the index is rebuilt whenever the download is newer (also auto-rebuilt once if the schema needs migration).
2. Queries Wikidata *by iNaturalist name*: for each name in the local index it asks Wikidata — in bounded `VALUES` POST batches — for taxon items carrying that name (P225) with no P3151. This inverts the old approach (which scanned Wikidata's ~3 M no-P3151 taxa and discarded the non-matches); WDQS cannot scan that full set, whereas batched name lookups are fast and reliable. Every candidate returned is therefore already a name match. `--limit` caps the number of collected candidates (real matches), and the cache lets re-runs reach further into the name list.
3. Classifies each candidate name against the SQLite index (no API calls). Names matching exactly one active iNat taxon are clean matches. Names matching two or more are flagged as ambiguous for human review.
4. Checks whether any found iNat ID is already linked to a *different* Wikidata item — potential mismatch.
5. Filters out apparent conflicts where the two Wikidata items are known homonyms (linked by P13177).
6. Fetches the full taxonomic ancestor chain for each clean match and each ambiguous case — from the SQLite index (iNat side, using the stored `ancestry` field, no API call) and from Wikidata via a `wdt:P171+` SPARQL query (Wikidata side).
7. Exports `links.html` — QuickStatements to add P3151 for clean matches plus taxonomy trees for verification, and a conflict table for cases needing manual investigation.
8. Exports `links-ambiguous.html` — one row group per ambiguous WD item, with the Wikidata tree on the left and each iNat candidate (tree + QS copy button) on the right for side-by-side comparison.
9. Writes `inat-links-conflicts.json` — machine-readable bookkeeping of all conflicts found, for raising with the Wikidata community if needed.

After the initial download and index build (~20 seconds), name lookups and iNat tree fetches are instant (local SQLite only). The Wikidata tree SPARQL adds a few seconds for large result sets. Results are cached locally in `cache-links.json` so re-runs skip taxa already processed. Delete the file to force a full re-scan.

## Usage

```sh
npm run links                              # default: 200 taxa
npm run links -- --limit 1000             # custom limit — fast even for large numbers
npm run links -- --limit 1000 --iucn EN   # limit + IUCN status filter
npm run links -- --limit 1000 --auto      # also write links-auto.qs (certain matches only)
npm run linkStats                          # stats mode: survey ALL taxa, print IUCN breakdown (no HTML output)
```

## links.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done (localStorage-persisted). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| iNat taxon | Link to the iNaturalist taxon page. |
| QuickStatements | Click to copy. Adds P3151 with the iNat taxon ID. |
| WD tree | Full Wikidata ancestor chain (kingdom → genus), sourced from Wikidata P171 links. Rank labels shown for known ranks (genus, family, order, class, etc.). |
| iNat tree | Full iNat ancestor chain (kingdom → genus), sourced from the local taxa database — no extra API call. Rank labels (Family, Order, Class, …) shown for all entries. |

The two tree columns let you verify at a glance that a matched pair actually refers to the same organism — mismatched families or genera are immediately visible without opening additional tabs.

An aggregate field above the table accumulates QuickStatements from all checked rows for batch copying.

The conflict table below (shown only when conflicts exist) lists iNat IDs found by name-search that are already linked to a different Wikidata item. These need manual investigation before importing.

## links-ambiguous.html layout

Each row group represents one Wikidata item whose scientific name matches multiple iNat taxa. The columns with rowspan (✓, Wikidata item, Taxon name, WD tree) appear once per group; the remaining columns repeat for each candidate:

| Column | Description |
|---|---|
| ✓ | Checkbox to mark the group resolved (localStorage-persisted). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| WD tree | Full Wikidata ancestor chain — shown once per group for comparison. |
| iNat candidate | Link to the iNat taxon page, plus its rank (species, genus, …). |
| iNat tree | Full iNat ancestor chain for this candidate. |
| QuickStatements | Click to copy `{qid} P3151 "{inatId}"` for this specific candidate. |

Compare the WD tree against each iNat candidate tree to identify which (if any) refers to the same organism.

## Stats mode

`npm run linkStats` reports, per IUCN status, how many Wikidata taxa without P3151 have a name that matches the iNat index. It works in two phases:

1. **Exact totals** per IUCN status come from Wikidata's CirrusSearch backend (instant). WDQS/Blazegraph times out merely *counting* the ~3 M no-P3151 set, so it cannot be used here.
2. **Match / Ambig** are found by querying Wikidata *by* every iNat name in bounded `VALUES` POST batches (~20 min for the full ~1.4 M-name index, and it always runs to completion). Every Wikidata taxon name either is an iNat name (→ match or ambiguous) or isn't (→ no match), so **No match is derived** as `total − match − ambig`.

```
Loading iNat taxa DB…
1,401,759 distinct iNat names loaded.

Fetching exact totals (CirrusSearch)…
  CR               1,043
  ...

Classifying matches (querying Wikidata by iNat name)…
  1,401,759 / 1,401,759 names queried

IUCN stats — Wikidata taxa without P3151
=========================================================
Status          |   Total |   Match |   Ambig |  No match
-----------------+---------+---------+---------+-----------
CR              |   1,043 |      37 |       0 |     1,006
EN              |   3,783 |   1,364 |       0 |     2,419
VU              |   1,950 |     317 |       1 |     1,632
NT              |   1,182 |     177 |       0 |     1,005
LC              |  14,010 |   8,579 |       4 |     5,427
DD              |   4,519 |   1,748 |       3 |     2,768
EX              |      24 |       2 |       0 |        22
EW              |       1 |       0 |       0 |         1
NE              |      22 |       3 |       0 |        19
(no IUCN status)|2,938,679| 443,243 |   2,614 | 2,492,822
-----------------+---------+---------+---------+-----------
TOTAL           |2,965,213| 455,470 |   2,622 | 2,507,121
```

**Match** = exactly one active iNat taxon found — ready to import via the normal `npm run links` workflow. **Ambig** = two or more iNat taxa share the name — needs human review in `links-ambiguous.html`. **No match** = Wikidata name not present in the iNat database (derived from the total). No files are written and the cache is not modified.

Totals come from CirrusSearch and matches from WDQS, two backends that index independently. Match/ambig are exact; because no-match is derived (`total − match − ambig`), any few-item indexing lag between the backends lands in the no-match figure.

## Auto mode (`--auto`)

Pass `--auto` to additionally write `links-auto.qs` — a plain-text QuickStatements file
containing only matches that pass a programmatic certainty filter:

- **Zero mismatches** — no labeled rank (genus, family, order, class, …) conflicts between the WD and iNat taxonomy trees
- **≥3 rank agreements** — at least three labeled ranks match by name
- **Family or order among the matches** — prevents three obscure intermediate ranks (e.g. subfamily/tribe/subtribe) from coincidentally agreeing

Matches that fail these criteria still appear in `links.html` for manual review.

`links-auto.qs` format — one statement per line, ready to paste into [QuickStatements](https://quickstatements.toolforge.org/):

```
Q12345	P3151	"67890"
```

## Typical workflow

1. Run `npm run links -- --limit 1000` to generate `links.html` and `links-ambiguous.html` (first run downloads the taxa database; subsequent runs are fast).
2. Open `links.html` in a browser. Compare the WD tree and iNat tree columns for each match to confirm the taxon placement is consistent. Check rows you want to import, copy the aggregate field, and paste into [QuickStatements](https://quickstatements.toolforge.org/).
3. Open `links-ambiguous.html`. For each group, compare the WD tree against the iNat candidate trees to identify the correct match (if any), then click its QuickStatements cell to copy.
4. If a conflict table is present in `links.html`, review `inat-links-conflicts.json` and investigate each case before acting.

**With `--auto`:** paste `links-auto.qs` directly into QuickStatements for the certain matches, then use `links.html` for the remainder.
