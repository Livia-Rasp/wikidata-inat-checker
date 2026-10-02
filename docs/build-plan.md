# Build plan

The ordered ladder for the findings-database restructure. Each slice's plan, and what turned out
differently from it, is in the maintainer's planning notes (*Wikidata iNat Checker – Findings DB
Roadmap*); what the shipped code does is in [dev.md](dev.md). Unordered defects are in
[todo.md](todo.md).

```
0   `node:sqlite` + Node 26                                                   ✅
1   findings store replaces the images tombstone cache                        ✅
2   verification pass                                                         ✅
3   Fastify serves the images app from the DB                                 ✅
4   confirm-gated done state in the DB                                        ✅
5   on-demand scoped discovery from the app                                   ✅
5c  a search page over the backlog                                            ✅
5d  a container that runs, plus GHCR publishing (pulled forward from 9)       ✅
5b  scheduled top-up                                                          ✅
6   app shell, plus area as a discovery scope                                 ✅
7   links checker → `kind=link`, and an ambiguous/conflict review UI          ✅
8   names checker → `kind=name` and a `/names` subpage                        ✅
8b  per-client skip scoping (pulled forward ahead of 9)                       ✅
9a  deploy that container: the redeploy label and backups                     ✅
10  discovery reachable from a deployed container                             ✅
11  a LAN deployment for one operator: `.env`, the `cli` service, the runbook ✅
9b  beta-tester access: who gets in, and through what                       ← next
─── outside the ordered plan ───
    OAuth upload and direct editing — not scheduled, on purpose
```

## Reorderings

- **5c and 5d before 5b.** The roadmap lists them in this order; why was not recorded.
- **GHCR publishing moved from 9 into 5d.** It took fifteen lines and no secrets, since
  `GITHUB_TOKEN` can push to the repository's own namespace, so deferring it bought nothing.
- **8b ahead of 9 (2026-08-26).** The deployment target changed from one operator to a home server
  with beta testers, and a global `skipped` status would have bitten on day one.
- **9 split into 9a and 9b (2026-08-26).** What does not depend on how testers connect shipped; what
  does waits on that decision.

- **11 ahead of 9b (2026-10-02).** Nothing had been used for real since the ladder began, and the
  tester decision is easier to make from a running deployment than from a plan. So the
  operator-only half went first: the port binding and `ALLOWED_HOSTS` became `.env` settings, the
  image learned to run the checkers and the backup for a host without Node, and the one gap plain
  http opens was closed. [deployment.md](deployment.md) is the runbook.

## 9b — beta-tester access

**An open question, not yet a slice.** How testers reach the app — a VPN/Tailscale hop, an exposed
instance behind an access-control layer, or per-tester SSH tunnels. Slice 11 took the mechanics
out of it (the binding and `ALLOWED_HOSTS` are settings now), so what is left is the decision
itself: who may reach an unauthenticated API, and whether an https origin and `TRUST_PROXY` come
with the answer. Its decision rule gets written before any of it is built, and what the first
weeks of slice 11's deployment show is an input to it.

**Not in this slice:** OAuth and Toolforge.
