// The vendored copy of Leaflet (web/vendor/leaflet/leaflet.js) loads as a classic <script> tag in
// web/area.html, exposing a global L that web/js/area.js consumes without importing it. `any` is
// deliberate: it's a bare global from a vendored copy, not an npm dependency, and not worth
// pulling in @types/leaflet for one untyped global.
declare const L: any;
