// The uploaded-files list and the pending P18 picks, which used to be `winc-uploaded` and
// `winc-p18` in localStorage — per browser profile, invisible to the checkers, and gone with the
// profile. They now live in the findings database and are mirrored here.
//
// The mirror exists because rendering is synchronous: the gallery asks "is this photo already
// uploaded?" while building each card. So `load()` is awaited once per page, reads stay in memory,
// and writes go to the server and update the mirror on success.
import { getJson, postJson } from './api.js';

/** @type {Set<string>} destFile names */
const uploads = new Set();

/**
 * qid → pick. `findingId` and `taxonName` are resolved server-side against the database, so the
 * QuickStatements panel never has to look them up in the rows it happens to have rendered — which
 * is what makes paging the worklist safe.
 * @type {Record<string, {destFile: string, taxonName: string|null, findingId: number|null}>}
 */
let picks = {};

export const state = {
    /** Pull the server's view. Call once, before the first render. */
    async load() {
        const data = await getJson('api/uploads');
        uploads.clear();
        for (const u of data.uploads) uploads.add(u.destFile);
        picks = data.picks ?? {};
    },

    isUploaded(destFile) { return uploads.has(destFile); },
    uploadCount() { return uploads.size; },
    uploadList() { return [...uploads]; },
    /** The wrapped JSON shape the main page downloads. */
    exportObject() { return { exported: new Date().toISOString(), uploaded: this.uploadList() }; },

    pickFor(qid) { return picks[qid]; },
    allPicks() { return picks; },
    pickCount() { return Object.keys(picks).length; },

    /**
     * Record (or withdraw) an upload, and optionally make it this taxon's P18 pick.
     * @param {{destFile: string, qid?: string, photoId?: string, taxonName?: string,
     *          uploaded: boolean, p18?: boolean}} u
     */
    async setUpload(u) {
        const body = { ...u };
        if (!body.qid) delete body.qid;
        const res = await postJson('api/uploads', body);
        if (u.uploaded) uploads.add(u.destFile); else uploads.delete(u.destFile);
        picks = res.picks ?? picks;
    },
};
