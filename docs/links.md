# iNat links checker

Finds Wikidata taxon items with no iNaturalist taxon ID (P3151) at all, matches them against iNaturalist's full taxonomy, and produces QuickStatements to add the missing link.

## How it works

1. Queries Wikidata for taxon items that have a scientific name (P225) but no P3151.
2. On first run, downloads the iNaturalist open-data taxa dump (~180 MB, 1.4 M active taxa) from the iNat S3 bucket and builds a local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~124 MB). The download is refreshed automatically every 30 days; the index is rebuilt whenever the download is newer (also auto-rebuilt once if the schema needs migration).
3. Looks up each Wikidata scientific name in the SQLite index (no API calls). Names matching exactly one active iNat taxon are clean matches. Names matching two or more are flagged as ambiguous for human review. Names with no match are skipped.
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

`npm run linkStats` fetches every Wikidata taxon without P3151 (no limit, paginated), classifies each name against the iNat SQLite index, and prints a console table:

```
Loading iNat taxa DB…

Fetching IUCN-coded taxa…
  CR… 1,764 taxa
  EN… 4,855 taxa
  ...

Fetching taxa without IUCN status (paginated)…
  Page 1 (offset 0)… 25000 rows, 25,000 unique so far
  ...

IUCN stats — Wikidata taxa without P3151
=========================================================
Status          |   Total |   Match |   Ambig |  No match
-----------------+---------+---------+---------+-----------
CR              |   1,764 |     765 |       0 |       999
EN              |   4,855 |   2,738 |       4 |     2,113
VU              |   3,577 |   1,992 |       1 |     1,584
NT              |   1,953 |   1,004 |       2 |       947
LC              |  14,014 |   8,579 |       4 |     5,431
DD              |   4,473 |   1,748 |       3 |     2,722
EX              |      46 |      24 |       0 |        22
EW              |       6 |       5 |       0 |         1
NE              |      24 |       5 |       0 |        19
(no IUCN status) (incomplete)| 349,408 |  75,955 |     511 |   272,942
-----------------+---------+---------+---------+-----------
TOTAL           | 380,120 |  92,815 |     525 |   286,780
```

**Match** = exactly one active iNat taxon found — ready to import via the normal `npm run links` workflow. **Ambig** = two or more iNat taxa share the name — needs human review in `links-ambiguous.html`. **No match** = name not found in the iNat database. No files are written and the cache is not modified.

## Typical workflow

1. Run `npm run links -- --limit 1000` to generate `links.html` and `links-ambiguous.html` (first run downloads the taxa database; subsequent runs are fast).
2. Open `links.html` in a browser. Compare the WD tree and iNat tree columns for each match to confirm the taxon placement is consistent. Check rows you want to import, copy the aggregate field, and paste into [QuickStatements](https://quickstatements.toolforge.org/).
3. Open `links-ambiguous.html`. For each group, compare the WD tree against the iNat candidate trees to identify the correct match (if any), then click its QuickStatements cell to copy.
4. If a conflict table is present in `links.html`, review `inat-links-conflicts.json` and investigate each case before acting.
