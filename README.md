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
| Area checker | `npm run area -- --lat <lat> --lng <lng> --radius <km>` | `area.html` | [docs/area.md](docs/area.md) |
| Upload app | `npm run web` | `web/` app at localhost:8080 | [docs/commons-upload.md](docs/commons-upload.md) |

The image, names, and links checkers accept `--limit <n>` and `--iucn <code>` (e.g. `CR`, `EN`, `VU`) flags; the area checker takes `--lat`/`--lng`/`--radius` instead. The `--` after `npm run <tool>` is required so npm forwards the flags to the script.

```sh
npm run images -- --limit 500 --iucn CR   # 500 Critically Endangered taxa
npm run links -- --limit 1000 --iucn EN   # 1000 Endangered taxa
```

## iNaturalist → Commons upload app

Running the image checker also writes `web/data/taxa.json`. Then:

```sh
npm run web        # serve the web/ app at http://localhost:8080
```

The app lists the image-less taxa, and for each one shows its research-grade,
Commons-compatibly-licensed iNaturalist photos. Selecting a photo opens the Wikimedia
Commons upload form **pre-filled** with the file URL, license, filename, and description —
you review and submit it yourself (nothing is uploaded automatically). See
[docs/commons-upload.md](docs/commons-upload.md) and [web/README.md](web/README.md).

## License

ISC — see [LICENSE](LICENSE).
