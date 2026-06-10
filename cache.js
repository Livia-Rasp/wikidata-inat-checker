// @ts-check
import fs from 'fs';

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
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
}
