import fs from 'fs';

export function loadCache(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

export function saveCache(file, cache) {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
}
