// Builds a Wikimedia Commons Special:Upload URL pre-filled to import a single
// iNaturalist photo. Adapted from get_commons_url() in lubianat/inat2wiki-module
// (parse_observation.py); see web/README.md for attribution.
//
// This does NOT upload anything — it just opens the Commons upload form with every
// field populated, leaving the final review and "Upload" click to the user.

// iNat license codes Commons accepts → the Commons license template name.
export const LICENSE_MAP = {
    'cc-by': 'cc-by-4.0',
    'cc-by-sa': 'cc-by-sa-4.0',
    'cc0': 'Cc-zero',
};

// Maintenance category stamped on every file uploaded through this tool.
export const TRACKING_CATEGORY = 'Media uploaded with wikidata-inat-checker';

const UPLOAD_PAGE = 'https://commons.wikimedia.org/wiki/Special:Upload';

/** Observer display name, falling back to the login when no real name is set. */
function authorName(user) {
    return user?.name && user.name.trim() !== '' ? user.name : (user?.login_exact || user?.login || 'unknown');
}

/**
 * Build the file-page wikitext: an {{Information}} block, an optional {{Location}}
 * (only when geoprivacy is open), the {{iNaturalist}} + {{INaturalistreview}}
 * templates, and the tracking + taxon categories.
 */
export function buildDescription({ observation, photo, taxonName }) {
    const date = observation.observed_on || '';
    const place = observation.place_guess;
    const description = place
        ? `${taxonName}, ${place}, ${date} (iNaturalist).`
        : `${taxonName}, ${date} (iNaturalist).`;

    let location = '';
    const coords = observation.geojson?.coordinates;
    if (coords && observation.taxon_geoprivacy === 'open') {
        const [lon, lat] = coords;
        location = `\n{{Location|${lat}|${lon}|source:iNaturalist}}`;
    }

    const author = authorName(observation.user);
    const userId = observation.user?.id ?? '';

    return `{{Information
|description= ${description}
|date=${date}
|source=https://www.inaturalist.org/photos/${photo.id}
|author=[https://www.inaturalist.org/users/${userId} ${author}]
|permission=
|other versions=
}}${location}

{{iNaturalist|${observation.id}}}

{{INaturalistreview}}
[[Category:${TRACKING_CATEGORY}]]
[[Category:${taxonName}]]`;
}

/**
 * Build the full Special:Upload URL for a photo, or null if its license is not
 * Commons-compatible. `photo` is one entry of observation.photos[].
 */
export function buildUploadUrl({ observation, photo, taxonName }) {
    const license = LICENSE_MAP[photo.license_code];
    if (!license) return null;

    const photoUrl = photo.url.replace('square', 'original');
    const ext = photoUrl.split('.').pop().split('?')[0];
    const author = authorName(observation.user);
    const destFile = `${taxonName} - ${author} - ${photo.id}.${ext}`;

    const params = new URLSearchParams({
        wpUploadDescription: buildDescription({ observation, photo, taxonName }),
        wpLicense: license,
        wpDestFile: destFile,
        wpSourceType: 'url',
        wpUploadFileURL: photoUrl,
    });
    return `${UPLOAD_PAGE}?${params}`;
}
