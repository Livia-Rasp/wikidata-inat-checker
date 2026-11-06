# To do

Known defects and small implementation work, unordered. The ordered plan is [build-plan.md](build-plan.md).

## Known: a CLI run killed outright stays `running` forever

Raised 2026-08-19, by doing it. `startRun` inserts a row with `state = 'running'`, and each pipeline
sets the terminal state from a `finally`, so an error or a cancel is recorded honestly — `failed`,
`cancelled`, `done`. What bypasses that block is a process that dies without unwinding.

**Ctrl-C and `SIGTERM` are handled since v1.10.1.** `interruptibleRun()` in `lib/cli.js` turns the
first signal into a graceful `cancelled` and a second into `interrupted`, marking only the CLI's own
row (see [dev.md](dev.md#discovery-libdiscoverjs-serverjobsjs)). **What remains is `SIGKILL`, the
OOM killer, and power loss:** nothing runs, so the row is a permanent claim that a run is in
progress. `store.reconcileRuns()` fixes it, but it is called only from **`server/index.js` at
startup**, so someone who drives the CLI and never starts the server keeps those rows.

**Cosmetic today, and worth knowing why**, because the reasons are what a fix must not break:

- **Nothing is blocked.** `server/jobs.js` holds the single-flight lock in an in-memory `record`,
  not in the `runs` table, so a stale row cannot wedge discovery.
- **Freshness is unaffected.** The "backlog as of" query is `MAX(finished_at) … WHERE finished_at
  IS NOT NULL`, which already ignores unfinished runs by design.
- The damage is a misleading history, and it will matter more once anything reports on runs.

**The obvious fix is wrong.** Calling `reconcileRuns()` at CLI startup would mark a *genuinely
live* run as interrupted: the server may be running a discovery child at that moment, and from a
row alone a second process cannot tell "died" from "still going". Two processes share this file —
that is the whole reason `busy_timeout` and `BEGIN IMMEDIATE` are there — so any reconciliation has
to prove the owner is gone, not assume it.

**The real fix:** record who owns a run (pid plus start time, or a heartbeat column the running
process touches) and reconcile only rows whose owner is provably gone. That is a schema change,
which is why it is not worth doing before something actually reads run history.

Related, and deliberately unfixed for the same reason: `reconcileRuns()` is a blunt sweep at
startup, so two servers against one database would each interrupt the other's live runs. Today
there is one server by construction.
