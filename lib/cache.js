// @ts-check
import fs from 'fs';
import { ensureParentDir } from './paths.js';

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
export function loadCache(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * @param {string} file
 * @param {Record<string, string>} cache
 */
export function saveCache(file, cache) {
    fs.writeFileSync(ensureParentDir(file), JSON.stringify(cache, null, 2), 'utf8');
}
