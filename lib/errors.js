// @ts-check
// Base for the app's "this was not a defect, do not print a stack trace" error family
// (UsageError in lib/cli.js, DiscoveryError in lib/discover.js, TaxaIndexUnavailable in
// lib/getInatTaxaDb.js). Each kept its own shape — a code, details vs. a bare reason, an
// hints getter — because what a caller needs from them genuinely differs; only the part every one
// of them repeated as boilerplate (setting `name` to a string literal that can drift from the
// class name on a rename, and `expected = true`) is shared here.
export class AppError extends Error {
    /** @param {string} message @param {{expected?: boolean}} [opts] */
    constructor(message, { expected = true } = {}) {
        super(message);
        this.name = new.target.name;
        this.expected = expected;
    }
}
