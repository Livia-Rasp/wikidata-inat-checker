# Leaflet 1.9.4, vendored

Used by `web/area.html` for the location/radius picker (slice 6). Vendored rather than loaded from
a CDN `<script>` tag so the server's CSP `script-src`/`style-src` never has to widen for a third
party — only `img-src` needs the OSM tile hosts, since the library itself is same-origin. See
`docs/threat-model.md`.

- **Version:** 1.9.4 (pinned; check https://leafletjs.com/download.html before bumping)
- **Source:** `https://unpkg.com/leaflet@1.9.4/dist/{leaflet.js,leaflet.css}` and
  `https://unpkg.com/leaflet@1.9.4/dist/images/{marker-icon.png,marker-icon-2x.png,
  marker-shadow.png,layers.png,layers-2x.png}`
- **Vendored:** 2026-08-23
- **License:** BSD-2-Clause (Leaflet itself; not a dependency of this repo's own package, so
  `renovate.json5` does not track it — bump by hand, the same way these files were fetched)

`leaflet.css` references the marker/shadow/layers images by a relative `images/` path — keep them
alongside it. `leaflet.js` is loaded as a plain `<script>` (a UMD build, not an ES module) before
`web/js/area.js`'s own module script, so it can expose the global `L` the module script uses.
