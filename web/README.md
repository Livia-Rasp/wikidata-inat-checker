# iNaturalist → Commons upload app

A small, backend-free web app for the [wikidata-inat-checker](../) project. It lists the
image-less Wikidata taxa found by the image checker (`web/data/taxa.json`), shows each
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
Commons** on a photo.

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
