# Vernacular names checker

Finds iNaturalist vernacular names (common names in any language) that are missing from Wikidata
taxon items (P1843), and records what it finds.

> The findings this records are also the worklist of the assisted **iNat → Commons upload app**
> (`npm run web`), which reads them live from `GET /api/findings?kind=name`. See
> [commons-upload.md](commons-upload.md).

## How it works

1. Queries Wikidata for taxon items that have an iNaturalist taxon ID (P3151). The query goes by
   iNat ID, in bounded `VALUES` POST batches, the same enumeration shape as the image and links
   checkers — deduped by **QID**, not iNat ID, since `taxa`/`findings`/`skipQids()` are all
   qid-keyed throughout the database. `--iucn` instead runs one direct P141-filtered query.

   The local ID list is shuffled before `--limit` caps the candidates, so a limited scan does not
   always hit the same slice first. The shuffle uses a seeded PRNG and is therefore reproducible;
   override it with `--seed <n>` (default `42`).
2. Fetches their existing P225 (scientific name) and P1843 claims from Wikidata, in one batched
   call.
3. Fetches all vernacular names from iNaturalist (`all_names=true`), filtering out invalid entries,
   scientific-name-locale entries, and names that duplicate the taxon's scientific name or bare
   genus (see [dev.md's "Genus-as-vernacular leak"](dev.md#genus-as-vernacular-leak-checknamesjs)).
4. Compares the two sets, case-insensitive. Names present in iNat but absent from Wikidata's P1843
   become a finding's `missing` list. Unless `--all` is passed, a taxon that already carries *any*
   P1843 value is skipped entirely rather than partially recorded — see [Usage](#usage).
5. Records the result in the **findings database** at `data/findings.db`, `kind='name'`, and
   renders `output/names.html` from the **whole accumulated backlog**, not just this run's finds.

## Statuses

Unlike links, a name finding has **no ambiguity to resolve** — every candidate already carries a
confirmed `inatId` from a P3151-linked Wikidata item, so the only open question is which languages
are missing, not which iNat taxon is meant. There is accordingly no `ambiguous`/`conflict`/
`no_match` equivalent, and no [Pick](links.md#pick)-style primitive: five statuses cover every
transition, the same core set images use.

| Status | Meaning | Payload |
|---|---|---|
| `open` | At least one iNat vernacular name is missing from Wikidata's P1843 | `missing`: `[{locale, name}, ...]` — every language still absent |
| `done` | Every proposed language is now live (set by [Confirm](#confirm)) | `resolution` records which locales were confirmed |
| `skipped` | Every known client has skipped it, or one skip was marked "forever" (slice 8b — see [links.md#statuses](links.md#statuses)) | |
| `fixed_upstream` | Every proposed language went live independently of this tool (set by [Verify](#verify)) | `resolution` records which locales, and why |
| `gone` | The Wikidata item was merged or deleted | |

A taxon can be missing names in several languages at once — `payload.missing` holds all of them on
one row, not one row per language. **Verify and confirm both re-check every proposed `{locale,
name}` pair independently**: if only some of a multi-language batch has landed on Wikidata, the
finding is re-recorded with `missing` trimmed to what's still absent and **stays `open`** — it is
not marked `done` until nothing remains, and it is not left claiming the full original list once
part of it has genuinely landed. This is the concrete shape of "verification is per-language."

## Verify

`npm run verify -- --kind name` reconciles the open backlog against live Wikidata — see
[images.md#verification](images.md#verification) for the general shape (Action API, never SPARQL,
same reasons). For names the predicate re-checks P1843 **once per proposed language**, not once for
the whole finding:

- Every proposed locale now present (whoever added it) → `fixed_upstream`, the same "presence
  alone resolves it" asymmetry images'/links' verify already have over their own confirm.
- Some but not all present → `missing` is trimmed to what's still absent via a fresh
  `recordFinding`, and the finding **stays `open`** — a smaller, genuine candidacy, not a "still
  true" observation, so `resolved_at`/`resolution` are not stamped on a row that is, again,
  actionable.
- None present, unchanged → the finding stays open untouched; only `verified_at` moves.

## Confirm

Like links, a name finding needs no sitelink pairing — but unlike links' single P3151 statement, it
proposes **several** P1843 statements at once, one per missing language, so "complete" means every
one of them, not any one of them. `POST /findings/:id/confirm` and the bulk `POST
/findings/confirm` both dispatch by the finding's own kind automatically, so a batch mixing image,
link and name ids confirms correctly regardless of which kinds it spans.

- All proposed locales live → `done`.
- Some live → `missing` trims to what's still absent, the finding stays `open` (reason
  `partially_confirmed` in the response) — paste only half a QuickStatements batch, and the half
  that landed is not offered again.
- None live → no-op, same as every other kind's confirm (reason `missing_names`).

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

By default only taxa with **no** vernacular names on Wikidata (P1843) are shown. Those are the
highest-priority additions. Pass `--all` to also include taxa that have some names already but are
still missing others iNaturalist knows.

`checkNames.js` is a thin CLI wrapper over `lib/discoverNames.js`, the same shape `checkImages.js`
and `checkLinks.js` have over their own discovery modules — the server runs the identical pipeline
for on-demand and scheduled top-up (see [commons-upload.md](commons-upload.md) and
[threat-model.md](threat-model.md)).

## output/names.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done (localStorage-persisted — the app's Confirm button is the real done-state; see [Statuses](#statuses)). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| iNat taxon | Link to the iNaturalist taxon page. |
| Missing names | Language code + name for each name iNat has but Wikidata doesn't. |
| QuickStatements | Click to copy a tab-separated block ready to paste into [QuickStatements](https://quickstatements.toolforge.org/). Each statement includes a source reference: stated in iNaturalist (P248), the taxon URL (P854), and today's date as retrieved (P813). |

## Typical workflow

**The app is the worklist. `output/names.html` is the fallback view**, matching images' and links'
pattern (see [images.md#typical-workflow](images.md#typical-workflow)). Run `npm run names` to fill
the backlog, then `npm run web` and work through `/names` there — its QuickStatements panel batches
every open finding automatically (there is no confidence axis to gate on, unlike links' `--auto`
bar: every candidate's iNat match is already certain), so copy, run the batch, then Confirm pending.

Working from the report directly:

1. Run `npm run names -- --limit 500` to generate `output/names.html`.
2. Open `output/names.html` in a browser.
3. Review rows and check off items you want to import. An aggregate QuickStatements field appears
   above the table and accumulates all checked rows — click it to copy everything in one go.
4. Paste into [QuickStatements](https://quickstatements.toolforge.org/) and run.
5. Use **Hide done** to keep the list tidy.
