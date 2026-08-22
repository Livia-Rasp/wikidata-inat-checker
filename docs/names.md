# Vernacular names checker

Finds iNaturalist vernacular names (common names in any language) that are missing from Wikidata taxon items (P1843).

## How it works

1. Queries Wikidata for taxon items that have an iNaturalist taxon ID (P3151) — by iNat ID, in bounded `VALUES` POST batches, the same enumeration shape as the image and links checkers (`--iucn` instead runs one direct P141-filtered query). The local ID list is shuffled with a seeded, reproducible PRNG before `--limit` caps the candidates, so a limited scan doesn't always hit the same slice first; override with `--seed <n>` (default `42`).
2. Fetches their existing P1843 claims from Wikidata.
3. Fetches all vernacular names from iNaturalist (`all_names=true`), filtering out invalid entries, scientific-name-locale entries, and names that duplicate the taxon's scientific name.
4. Compares the two sets (case-insensitive). Names present in iNat but absent from Wikidata are reported.
5. Exports `output/names.html` — a table with QuickStatements snippets for batch-importing missing names.

Results are cached locally in `cache/cache-names.json` so re-runs skip taxa already checked. Delete the file to force a full re-scan.

## Usage

```sh
npm run names                              # default: 5000 taxa with zero existing P1843
npm run names -- --limit 500              # custom limit
npm run names -- --limit 500 --iucn CR    # limit + IUCN status filter
npm run names -- --all                    # include taxa that already have some P1843
npm run names -- --limit 500 --all
npm run names -- --limit 500 --iucn CR --all
npm run names -- --limit 500 --seed 7     # different shuffle of the scan order
```

By default, only taxa with **no** vernacular names on Wikidata (P1843) yet are shown — these are the highest-priority additions. Pass `--all` to also include taxa that already have some names but are still missing certain iNat ones.

## output/names.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done (localStorage-persisted). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| iNat taxon | Link to the iNaturalist taxon page. |
| Missing names | Language code + name for each name iNat has but Wikidata doesn't. |
| QuickStatements | Click to copy a tab-separated block ready to paste into [QuickStatements](https://quickstatements.toolforge.org/). Each statement includes a source reference: stated in iNaturalist (P248), the taxon URL (P854), and today's date as retrieved (P813). |

## Typical workflow

1. Run `npm run names -- --limit 500` to generate `output/names.html`.
2. Open `output/names.html` in a browser.
3. Review rows and check off items you want to import. An aggregate QuickStatements field appears above the table and accumulates all checked rows — click it to copy everything in one go.
4. Paste into [QuickStatements](https://quickstatements.toolforge.org/) and run.
5. Use **Hide done** to keep the list tidy.
