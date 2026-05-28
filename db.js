import { JsonDB, Config } from 'node-json-db';

export const db = new JsonDB(new Config("inattWDPhotoCache", false, true, ';'));

export const dbPath = {
    done:           (taxonId) => `;done;${taxonId}`,
    available:      (wdUri)   => `;available;${wdUri}`,
    inatTaxonId:    (wdUri)   => `;inatTaxonId;${wdUri}`,
    draft:          (wdUri)   => `;drafts;${wdUri}`,
    allAvailable:   ';available',
    allDrafts:      ';drafts',
    allInatTaxonIds:';inatTaxonId',
};
