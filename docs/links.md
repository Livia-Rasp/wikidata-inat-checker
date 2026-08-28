# iNat links checker

Finds Wikidata taxon items with no iNaturalist taxon ID (P3151) at all, matches them against
iNaturalist's full taxonomy, and records what it finds.

> The findings this records are also the worklist of the assisted **iNat → Commons upload app**
> (`npm run web`), which reads them live from `GET /api/findings?kind=link` and offers a review UI
> for ambiguous and conflicting matches. See [commons-upload.md](commons-upload.md).

## How it works

1. On first run, downloads the iNaturalist open-data taxa dump (~189 MB, 1.4 M active taxa) and
   builds the local SQLite index at `~/.cache/wikidata-inat-checker/taxa.db` (~236 MB, shared with
   the images and names checkers). The download is refreshed automatically every 30 days; the
   index is rebuilt whenever the download is newer.
2. Queries Wikidata *by iNaturalist name*. For each name in the local index it asks Wikidata, in
   bounded `VALUES` POST batches, for taxon items carrying that name (P225) with no P3151. Every
   candidate returned is therefore already a name match. This inverts scanning Wikidata's ~3 M
   no-P3151 taxa directly, which WDQS cannot do.

   The local index's name list comes back in incidental alphabetical order. It is shuffled before
   `--limit` caps the number of collected candidates, or the whole budget would go on
   early-alphabet names. The PRNG is seeded and reproducible; override it with `--seed <n>`
   (default `42`).

   `--iucn <code>` instead runs one direct query filtered by P141 — that no-P3151 set is small
   enough for WDQS to answer in seconds, so the batched name scan and its shuffle are skipped.
3. Classifies each candidate name against the SQLite index (no API calls). A name matching exactly
   one active iNat taxon is a clean candidate. A name matching two or more becomes `ambiguous`. A
   name matching none becomes `no_match` — a negative result with a shelf life (see
   [Statuses](#statuses)), not a verdict.
4. For clean candidates, checks whether the matched iNat ID is already linked to a *different*
   Wikidata item — a `conflict` — then filters out conflicts where the two Wikidata items are
   already known homonyms (linked by P13177).
5. Fetches the full taxonomic ancestor chain for each remaining candidate — from the SQLite index
   (iNat side, using the stored `ancestry` field, no API call) and from Wikidata via a `wdt:P171+`
   SPARQL query — and compares them rank by rank.

## Statuses

Findings are recorded in the **findings database** at `data/findings.db`, `kind='link'`. That is
what makes the backlog survive: every outcome is stored, so re-runs skip taxa already dealt with,
and both the app and `output/links.html` show the whole accumulated backlog rather than just the
latest run's. Six statuses:

| Status | Meaning | Payload |
|---|---|---|
| `open` | Exactly one same-named iNat taxon, not claimed elsewhere — a proposed P3151 statement | `inatId`, `rank`, `evidence` (rank-agreement summary), `autoEligible` |
| `ambiguous` | Two or more same-named iNat taxa — needs a human pick | `wdChain`, `candidates[]` (each with `inatId`, `rank`, `evidence`, its own `inatChain`, and reserved `score`/`scoredBy` — see [Beyond this checker](#beyond-this-checker-a-confidence-model)) |
| `conflict` | The matched iNat id is already claimed by a *different* Wikidata item, with no known P13177 link between them | `inatId`, `rank`, `evidence`, `wdChain`, `inatChain`, `existingWdItem`, `existingTaxonName` |
| `no_match` | The taxon name isn't in the local iNat index at all | none — expires after `--recheck-after` days (default 90), like `no_photos`/`no_draft` for images |
| `done` | Live Wikidata now carries the proposed P3151 (set by [Confirm](#confirm)) | `resolution` records what was confirmed |
| `skipped` / `gone` | User skip, or the Wikidata item was merged/deleted (set by [Verify](#verify)) | |

`ambiguous` and `conflict` are *settled* the same way `open`/`done`/`skipped` are: discovery never
re-processes them. Only `no_match` expires and becomes a candidate again.

**`skipped` is per-client until every known client agrees (slice 8b).** A single Skip no longer
flips `status` on its own — it only does once every browser profile the app has ever seen (or one
skip marked "forever") has passed on the same finding, so one tester's judgement can't silently hide
work from everyone else. Until then the row stays exactly as it was; only the client who skipped it
stops seeing it on their own worklist. See
[findings-db-roadmap.md#8b-per-client-skip-scoping](findings-db-roadmap.md#8b-per-client-skip-scoping).

`evidence` is `{matches, mismatches, matchedRanks}` — the rank-by-rank agreement count, not the
full ancestor chains. `open` findings only ever carry this summary; `ambiguous` and `conflict`
findings also carry the full `wdChain`/`inatChain` arrays, because the app's review UI renders a
side-by-side comparison table for them (the summary alone isn't enough to *show* the evidence, only
to score it). `autoEligible` is the `--auto` bar below, computed once at discovery time.

## Pick

`POST /findings/:id/pick` (body `{inatId}`) is how a human resolves an `ambiguous` finding in the
app: it re-records the finding as `open` with the chosen candidate's `inatId`/`rank`/`evidence`,
recomputing `autoEligible`. Refused (400) if `inatId` isn't one of the finding's own candidates.
There is no equivalent for `conflict` — resolving one is an off-platform judgement (adding a P13177
statement, or fixing a name on one side), so a conflict row only offers Skip.

## Verify

`npm run verify -- --kind link` reconciles the open backlog against live Wikidata — see
[images.md#verification](images.md#verification) for the general shape (Action API, never SPARQL,
same reasons). For links the predicate is P3151 presence alone, and `conflict` findings are
re-verified too: if the competing Wikidata item's P3151 claim on the disputed iNat id has since
gone or moved, the conflict re-opens as a fresh `open` candidacy rather than staying stuck.

## Confirm

Unlike images (which pairs P18 with a Commons-category sitelink), a link finding proposes exactly
one statement, so confirming needs no pairing: `done` iff live P3151 equals the proposed `inatId`.
`POST /findings/:id/confirm` and the bulk `POST /findings/confirm` both dispatch by the finding's
own kind automatically, so a batch mixing image and link ids confirms correctly either way.

## Usage

```sh
npm run links                              # default: 200 taxa
npm run links -- --limit 1000              # custom limit — fast even for large numbers
npm run links -- --limit 1000 --iucn EN    # limit + IUCN status filter
npm run links -- --limit 1000 --auto       # also write output/links-auto.qs (certain matches only)
npm run links -- --limit 1000 --ambiguous-only  # only ambiguous/no_match — see below
npm run links -- --limit 1000 --seed 7     # different shuffle of the name scan order
npm run linkStats                          # stats mode: survey ALL taxa, print IUCN breakdown (no HTML output)
```

`checkLinks.js` is a thin CLI wrapper over `lib/discoverLinks.js`, the same shape
`checkImages.js` has over `lib/discover.js` — the server runs the same discovery pipeline for
on-demand and scheduled top-up (see [commons-upload.md](commons-upload.md) and
[threat-model.md](threat-model.md)).

After a run, three files are (re)generated from the **whole DB backlog**, not just this run's
findings:

| File | From | Description |
|---|---|---|
| `output/links.html` | `open` + `conflict` findings | QuickStatements for clean matches plus taxonomy trees for verification, and a conflict table |
| `output/links-ambiguous.html` | `ambiguous` findings | One row group per ambiguous WD item, WD tree against each iNat candidate's tree, side by side |
| `output/inat-links-conflicts.json` | `conflict` findings | Machine-readable bookkeeping, for raising with the Wikidata community if needed |

**These two HTML reports are kept deliberately compatible with the sibling
[`xgboost-inat-wikidata-match`](https://github.com/Livia-Rasp/xgboost-inat-wikidata-match) repo**,
whose `build_gold_labeling_kit.py` scrapes `output/links-ambiguous.html`'s exact row structure
(`id="row-{qid}"`, `td.wd-col`, `td.taxon-col`, `class="candidate-row"`) to build its gold-labelling
sample. Changing that markup shape without checking that script still parses it would silently
break another project's reproducibility. See [Beyond this checker](#beyond-this-checker-a-confidence-model).

## output/links.html columns

| Column | Description |
|---|---|
| ✓ | Checkbox to mark a row as done (localStorage-persisted — the app's Confirm button is the real done-state; see [Statuses](#statuses)). |
| Wikidata item | Link to the Wikidata entity. |
| Taxon name | Scientific name (P225). |
| iNat taxon | Link to the iNaturalist taxon page. |
| QuickStatements | Click to copy. Adds P3151 with the iNat taxon ID. |
| Taxonomy (WD · iNat) | The two ancestor chains side by side, rank labels shown for the known ranks — green where names agree, red where they conflict. |

The conflict table below (shown only when conflicts exist) lists iNat IDs found by name-search
that are already linked to a different Wikidata item. These need manual investigation.

## output/links-ambiguous.html layout

Each row group represents one Wikidata item whose scientific name matches multiple iNat taxa. The
columns with rowspan (✓, Wikidata item, Taxon name) appear once per group; the remaining three
repeat for each candidate — see [images.md](images.md) for the general column pattern this and
`output/links.html` share, and the app's `/links` page for the same comparison rendered live.

## Stats mode

`npm run linkStats` reports, per IUCN status, how many Wikidata taxa without P3151 have a name
that matches the iNat index. It reads no database and writes nothing — a live survey, not a
backlog operation:

1. **Exact totals** per IUCN status come from Wikidata's CirrusSearch backend (instant). WDQS/
   Blazegraph times out merely *counting* the ~3 M no-P3151 set.
2. **Match / Ambig** are found by querying Wikidata *by* every iNat name in bounded `VALUES` POST
   batches (~20 min for the full ~1.4 M-name index). **No match is derived** as `total − match −
   ambig`.

**Match** = exactly one active iNat taxon found — a candidate the normal `npm run links` workflow
would record as `open`. **Ambig** = two or more iNat taxa share the name — `ambiguous`. **No
match** = the Wikidata name is not present in the iNat database — `no_match` if discovered.

## Auto mode (`--auto`)

Pass `--auto` to additionally write `output/links-auto.qs` from the DB backlog's `open` findings
whose `autoEligible` is true — a plain-text QuickStatements file for a programmatic certainty bar,
computed once at discovery time and stored on the finding:

- **Zero mismatches.** No labeled rank (genus, family, order, class, …) conflicts between the WD
  and iNat taxonomy trees
- **≥3 rank agreements.** At least three labeled ranks match by name
- **Family or order among the matches.** This stops three obscure intermediate ranks, say
  subfamily, tribe and subtribe, from coincidentally agreeing

Findings that fail this bar stay `open` and appear in `output/links.html` (and the app) for manual
review, with a "check taxonomy" badge instead of "high confidence". The app's own QuickStatements
panel on `/links` reads the same `autoEligible` flag.

```
Q12345	P3151	"67890"
```

## Ambiguous-only mode (`--ambiguous-only`)

Pass `--ambiguous-only` to skip the P3151 cross-check, the conflict bookkeeping and the
ancestor-chain fetch for clean matches, and go straight to classifying and recording `ambiguous`
(and `no_match`) candidates — the much cheaper half of a run. `no_match` findings cost nothing
extra either way (no network call), so they are always recorded regardless of this flag.

The ancestor-chain fetch for clean matches is the expensive part skipped here: one SPARQL batch
per 100 matches, up to 2 in flight, and at a `--limit` in the tens of thousands it dominates a run.

**This is how the sibling `xgboost-inat-wikidata-match` repo sources its gold-labelling sample** —
see [Beyond this checker](#beyond-this-checker-a-confidence-model). It cuts a large-`--limit` run
from well over an hour to single-digit minutes, and avoids most of the exposure to WDQS's
intermittent truncated and slow responses.

## Fixed: the Wikidata tree used to silently drop real ranks

**Historical note, fixed 2026-08-22.** `fetchWdAncestorChains` (`lib/utils.js`) rebuilds the
linear ancestor chain client-side by walking `directParent → parent → parent → ...`. Wikidata's
taxonomic graph is not a strict tree: an ancestor can carry more than one `wdt:P171` statement, and
the old code kept a single `parent` per ancestor, so whichever SPARQL row arrived last silently
overwrote the others — the walk could derail onto a dead end outside the item's own ancestor
closure, dropping every subsequent rank with no error. Reproduced on `Q5049369` and `Q2474088`,
both missing everything above Class.

The fix collects every candidate parent per ancestor instead of overwriting, and the walk prefers
whichever candidate is itself a known ancestor of the item. This does not resolve every possible
fork in Wikidata's graph — where several candidate parents are each genuinely part of the item's
closure, the choice among them is deterministic but not necessarily canonical — but it eliminates
the nondeterministic overwrite and the dead-end truncation, which was the concrete defect.

## Beyond this checker: a confidence model

**Not built. To do, tracked for a future slice.** A separate repo,
[`xgboost-inat-wikidata-match`](https://github.com/Livia-Rasp/xgboost-inat-wikidata-match), trains
an XGBoost classifier that ranks ambiguous iNat candidates by confidence — 98.7% top-1 accuracy on
a hand-labelled gold set, against 20.9% for exact-name matching alone. Its own `docs/future-work.md`
names "close the loop back into the Node tool" as the next step, currently blocked on threshold
work: at the precision bar this task needs, the model ranks well but doesn't yet decide, so the
honest output today is a ranking a human still reviews, not an auto-accept.

The findings-DB migration was deliberately shaped to make that integration easier when it happens,
without needing a schema change:

- Every `ambiguous` candidate already carries reserved `score` and `scoredBy` fields, currently
  always `null` — a scoring pass would fill them in and record which model version produced them.
- The full `wdChain`/`inatChain` evidence a model would want as features is already on the finding
  (see [Statuses](#statuses)), reachable via `GET /api/findings?kind=link&status=ambiguous`
  instead of scraping HTML.
- `output/links-ambiguous.html` keeps being generated in the exact shape
  `build_gold_labeling_kit.py` already parses, so the gold-labelling workflow that trains the model
  is unaffected either way.

What integrating it would still need, roughly: a scoring pass (Node, calling into the Python
model, or a small service) that reads open `ambiguous` findings and writes `score`/`scoredBy` back
via a new endpoint or a direct DB write; a decision in the app for what a score changes about the
review UI (a sort order, a threshold-based auto-suggestion, nothing that writes P3151 without a
human, given the model's own stated precision ceiling). None of this is scheduled yet.

## Typical workflow

**The app is the worklist. `output/links.html` is the fallback view**, matching images' pattern
(see [images.md#typical-workflow](images.md#typical-workflow)). Run `npm run links` to fill the
backlog, then `npm run web` and work through `/links` there — confirm, skip, or resolve an
ambiguous/conflict row in the review section.

Working from the reports directly:

1. Run `npm run links -- --limit 1000`.
2. Open `output/links.html`. Compare the WD tree and iNat tree columns for each match, check rows
   you want to import, copy the aggregate field, and paste into
   [QuickStatements](https://quickstatements.toolforge.org/).
3. Open `output/links-ambiguous.html`. For each group, compare the WD tree against the iNat
   candidate trees, then click the right candidate's QuickStatements cell to copy.
4. If a conflict table is present, review `output/inat-links-conflicts.json` and investigate each
   case before acting.

**With `--auto`:** paste `output/links-auto.qs` directly into QuickStatements for the certain
matches, then use `output/links.html` for the remainder.
