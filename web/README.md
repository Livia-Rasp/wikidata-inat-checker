# iNaturalist → Commons upload app

A small, build-step-free web app for the [wikidata-inat-checker](../) project. It lists the
image-less Wikidata taxa found by the image checker (served by `server/` from the findings
database, `GET /api/findings`), shows each
taxon's research-grade, Commons-compatibly-licensed iNaturalist photos, and opens the
Wikimedia Commons upload form **pre-filled** for any photo you pick. Nothing is uploaded
automatically — you review and submit the form yourself.

## Running

From the repository root:

```sh
node checkImages.js   # produces web/data/taxa.json
npm run web           # serves this folder at http://localhost:8080
```

Open <http://localhost:8080/>, then use **View photos** on a taxon and **Upload to
Commons** on a photo. Tick **Use as Wikidata image (P18)** on the photo you uploaded to
queue the item's image + Commons-category sitelink in the main view's **QuickStatements**
panel, then **Copy & clear** to apply them in a batch (see
[docs/commons-upload.md](../docs/commons-upload.md#adding-p18--category-in-batches)).

## Credits & attribution

The iNaturalist→Commons upload logic in this app — the `Special:Upload` prefill URL and the
file-page wikitext (`js/commonsUpload.js`) — is **adapted from
[inat2wiki](https://github.com/lubianat/inat2wiki) by Tiago Lubiana
([@lubianat](https://github.com/lubianat))**, specifically the `get_commons_url()` function
in [inat2wiki-module](https://github.com/lubianat/inat2wiki-module), which is released into
the public domain under the Unlicense. inat2wiki in turn credits
[kaldari](https://github.com/kaldari)'s *iNaturalist2Commons* for the original
Commons-import approach.

The port from the original Python into this project's JavaScript was carried out with the
assistance of **Claude (Anthropic)**, used to analyze the upstream source and adapt the
relevant logic into this codebase. Many thanks to Tiago for the original work that made this
feature possible.

### Data sources

Geographic categories are reverse-geocoded with the **[OpenStreetMap](https://www.openstreetmap.org/)
[Nominatim](https://nominatim.org/) service** to reach the county/municipality level. Map data
© OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright).
The app caches results and throttles requests to respect Nominatim's
[usage policy](https://operations.osmfoundation.org/policies/nominatim/) (max ~1 request/second).
