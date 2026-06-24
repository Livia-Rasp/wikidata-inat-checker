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
| Category draft | `npm run draft -- <QID> [<QID> …]` | draft printed to stdout | [docs/images.md](docs/images.md#generating-a-single-category-draft) |
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
Commons upload form **pre-filled** with the file URL, license, filename, and a detailed
description — you review and submit it yourself (nothing is uploaded automatically).

The generated file description aims to be comprehensive but not overloaded:

- an `{{en|<English common name> (''Scientific name'') in County, State, Country}}`
  description, taken from the observation's identified taxon and its location;
- a `{{Taken on|<date>|location=<Country>}}` date (so the file is categorised by date and
  country);
- **geographic taxon categories** when they exist on Commons (e.g. `Picidae of Texas`,
  `Odonata of Argentina`);
- an **author category** when the photographer has one (discovered via Commons'
  `{{Inaturalist user}}` template and Wikidata's iNaturalist-user-ID property).

A **Mark as uploaded** checkbox on each photo records what you've uploaded (kept in your
browser); the main page's **Download uploaded list** button exports that list as JSON. All
the category/location lookups are cached locally so repeats are fast.

Picking **Use as Wikidata image (P18)** on the uploaded photo queues the two remaining
Wikidata edits — the image (P18) and the Commons-category sitelink — into a
**QuickStatements** panel on the main page, so you can apply them to many items in one batch;
copying clears them so each edit runs only once.

See [docs/commons-upload.md](docs/commons-upload.md) and [web/README.md](web/README.md).

## License

ISC — see [LICENSE](LICENSE).
