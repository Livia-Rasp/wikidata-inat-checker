// Paging for the two table pages. Both render the same tall rows — a block of draft wikitext each —
// so both need the same answer to "there are more of these than fit on a screen": a page at a time,
// with the range said out loud rather than a count that quietly stops at a ceiling.

/** Rows per page. A hundred tall rows is already a long scroll; the API's 2000 ceiling would be a
 *  page nobody reaches the end of. */
export const PAGE_SIZE = 100;

/**
 * @param {{el: HTMLElement, onPage: (offset: number) => void, scrollTo?: HTMLElement|null}} opts
 */
export function createPager({ el, onPage, scrollTo = null }) {
    el.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target).closest('[data-offset]');
        if (!btn) return;
        onPage(Number(/** @type {HTMLElement} */ (btn).dataset.offset));
        // The pager sits under the table, so a click on Next otherwise leaves you at the bottom of
        // a page you have not read. Back to the top of the results, not of the document.
        scrollTo?.scrollIntoView({ block: 'start', behavior: 'auto' });
    });

    return {
        /** @param {{total: number, count: number, offset: number}} page */
        render({ total, count, offset }) {
            if (total <= count && offset === 0) { el.hidden = true; el.innerHTML = ''; return; }
            const page = Math.floor(offset / PAGE_SIZE) + 1;
            const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
            el.innerHTML = `
                <button type="button" class="pager-btn" data-offset="${Math.max(0, offset - PAGE_SIZE)}"
                        ${offset === 0 ? 'disabled' : ''}>← Previous</button>
                <span class="pager-where">Page ${page} of ${pages}</span>
                <button type="button" class="pager-btn" data-offset="${offset + PAGE_SIZE}"
                        ${offset + count >= total ? 'disabled' : ''}>Next →</button>`;
            el.hidden = false;
        },

        /**
         * The page to ask for when the one requested has run out — bookmarking page 4 of something
         * that has since shrunk, or skipping the last row of the last page. Null when the current
         * offset is fine.
         * @param {{total: number, count: number, offset: number}} page
         */
        fallbackOffset({ total, count, offset }) {
            if (count > 0 || total === 0 || offset === 0) return null;
            return (Math.ceil(total / PAGE_SIZE) - 1) * PAGE_SIZE;
        },
    };
}
