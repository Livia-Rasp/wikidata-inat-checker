# wikidata-inat-checker

A set of tools for improving Wikidata taxon items using iNaturalist data — finding missing images, missing vernacular names, and missing iNaturalist taxon links, and generating the Wikitext or QuickStatements needed to fill them in.

## Installation

Requires Node.js 18+.

```sh
git clone https://github.com/Livia-Rasp/wikidata-inat-checker.git
cd wikidata-inat-checker
npm install
```

## Tools

| Tool | Command | Output | Documentation |
|---|---|---|---|
| Image checker | `npm run images` | `drafts.html` | [docs/images.md](docs/images.md) |
| Vernacular names | `npm run names` | `names.html` | [docs/names.md](docs/names.md) |
| iNat links | `npm run links` | `links.html`, `links-ambiguous.html` | [docs/links.md](docs/links.md) |
| Area checker | `npm run area -- <lat> <lng> <km>` | `area.html` | [docs/area.md](docs/area.md) |

All tools accept an optional taxon limit as the first argument and an IUCN status filter (e.g. `CR`, `EN`, `VU`) as the second:

```sh
npm run images -- --limit 500 --iucn CR   # 500 Critically Endangered taxa
npm run links -- --limit 1000 --iucn EN   # 1000 Endangered taxa
```

## License

ISC — see [LICENSE](LICENSE).
