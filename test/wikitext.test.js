// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWikitextContext, generateDraftWikitext } from '../lib/generateWikitext.js';

test('a run context starts empty and is the thing that spans batches', () => {
    const ctx = createWikitextContext();
    assert.deepEqual(ctx.ancestors, {});
    assert.equal(ctx.templates, null, 'the Commons template map is fetched once, lazily');
});

test('nothing is fetched for an empty batch, and progress goes where it is told', async () => {
    const lines = [];
    const ctx = createWikitextContext();

    // No network: with nothing available there is nothing to walk, which is also the case a
    // batch-wise discovery run hits often once the interesting taxa are used up.
    const out = await generateDraftWikitext({}, { context: ctx, log: (m) => lines.push(m) });

    assert.deepEqual(out, {});
    assert.match(lines[0], /skipping draft generation/);
    assert.equal(ctx.templates, null, 'and it did not reach for the template map either');
});

test('a pre-populated context is honoured rather than re-fetched', async () => {
    // Standing in for "an earlier batch already did this". If the template map were re-fetched
    // per call, a run of ten batches would pay 10-40 Commons requests ten times over.
    const templates = new Map([['Aves', 'include=Aves']]);
    const ctx = { ancestors: { Q123: { taxonName: 'Panthera leo' } }, templates };

    await generateDraftWikitext({}, { context: ctx, log: () => {} });

    assert.equal(ctx.templates, templates, 'the caller\'s map is kept, not replaced');
    assert.deepEqual(Object.keys(ctx.ancestors), ['Q123'], 'and the walked lineage survives');
});
