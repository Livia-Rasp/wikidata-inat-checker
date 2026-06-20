// Builds a Wikimedia Commons Special:Upload URL pre-filled to import a single
// iNaturalist photo. Adapted from get_commons_url() in lubianat/inat2wiki-module
// (parse_observation.py); see web/README.md for attribution.
//
// This does NOT upload anything — it just opens the Commons upload form with every
// field populated, leaving the final review and "Upload" click to the user.
//
// Naming/location enrichment (description names, location text, {{Taken on}} country,
// geographic + author categories) is computed by the caller (gallery.js + enrich.js) and
// passed in; this module stays pure string assembly so it's easy to test.

// iNat license codes Commons accepts → the Commons license template name.
export const LICENSE_MAP = {
    'cc-by': 'cc-by-4.0',
    'cc-by-sa': 'cc-by-sa-4.0',
    'cc0': 'Cc-zero',
};

// Maintenance category for files uploaded via this tool. Intentionally NOT emitted yet
// (§7.1): the tool isn't public. Re-enable on publication and backfill old files from the
// "uploaded files" list. Kept here so re-enabling is a one-line change.
export const TRACKING_CATEGORY = 'Media uploaded with wikidata-inat-checker';

const UPLOAD_PAGE = 'https://commons.wikimedia.org/wiki/Special:Upload';

/** Observer display name, falling back to the login when no real name is set. */
function authorName(user) {
    return user?.name && user.name.trim() !== '' ? user.name : (user?.login_exact || user?.login || 'unknown');
}

/**
 * Build the file-page wikitext. Inputs beyond the raw observation/photo:
 *  - taxonName       target taxon (Wikidata) — used for filename + species category
 *  - location        "County, State, Country" text (may be ""), from resolved place hierarchy
 *  - country         admin-0 country name (may be "") for {{Taken on|…|location=}}
 *  - extraCategories array of extra Commons category names (geo + author), may be empty
 */
export function buildDescription({ observation, photo, taxonName, location = '', country = '', extraCategories = [] }) {
    // Description names come from the observation's *identified* taxon (§7.3), wrapped in {{en}}.
    const sci = observation.taxon?.name || taxonName;
    const common = observation.taxon?.preferred_common_name;
    const namePart = common ? `${common} (''${sci}'')` : `''${sci}''`;
    const inPart = location ? ` in ${location}` : '';
    const description = `{{en|${namePart}${inPart}}}`;

    // Date via {{Taken on}}, categorised by country when known (§7.4).
    const date = observation.observed_on || '';
    const dateField = date
        ? `{{Taken on|${date}${country ? `|location=${country}` : ''}}}`
        : '';

    // {{Location}} only for open geoprivacy (don't leak obscured coordinates).
    let locationTpl = '';
    const coords = observation.geojson?.coordinates;
    if (coords && observation.taxon_geoprivacy === 'open') {
        const [lon, lat] = coords;
        locationTpl = `\n{{Location|${lat}|${lon}|source:iNaturalist}}`;
    }

    const author = authorName(observation.user);
    const userId = observation.user?.id ?? '';

    const categories = [taxonName, ...extraCategories]
        .filter(Boolean)
        .map((c) => `[[Category:${c}]]`)
        .join('\n');

    return `{{Information
|description= ${description}
|date=${dateField}
|source=https://www.inaturalist.org/photos/${photo.id}
|author=[https://www.inaturalist.org/users/${userId} ${author}]
|permission=
|other versions=
}}${locationTpl}

{{iNaturalist|${observation.id}}}

{{INaturalistreview}}
${categories}`;
}

/** The destination filename, `Taxon - Author - <photoId>.<ext>`. */
export function buildDestFile({ observation, photo, taxonName }) {
    const ext = photo.url.replace('square', 'original').split('.').pop().split('?')[0];
    return `${taxonName} - ${authorName(observation.user)} - ${photo.id}.${ext}`;
}

/**
 * Build the full Special:Upload URL for a photo, or null if its license is not
 * Commons-compatible. `photo` is one entry of observation.photos[].
 */
export function buildUploadUrl(opts) {
    const { observation, photo } = opts;
    const license = LICENSE_MAP[photo.license_code];
    if (!license) return null;

    const photoUrl = photo.url.replace('square', 'original');
    const params = new URLSearchParams({
        wpUploadDescription: buildDescription(opts),
        wpLicense: license,
        wpDestFile: buildDestFile(opts),
        wpSourceType: 'url',
        wpUploadFileURL: photoUrl,
    });
    return `${UPLOAD_PAGE}?${params}`;
}
