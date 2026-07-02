// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTaxonName, doneScript, renderReportPage } from '../report/htmlShared.js';

test('extractTaxonName reads the binomial from a Taxonavigation draft', () => {
    const wikitext = `{{Taxonavigation|
Genus|Panthera|
Species|Panthera onca|
authority=(Linnaeus, 1758)}}`;
    assert.equal(extractTaxonName(wikitext), 'Panthera onca');
});

test('extractTaxonName reads the highest positional rank when there is no species', () => {
    assert.equal(extractTaxonName('{{Taxonavigation|\nFamilia|Orchidaceae|\nauthority=}}'), 'Orchidaceae');
});

test('extractTaxonName handles the Coleoptera/Lepidoptera named-param form', () => {
    assert.equal(extractTaxonName('{{Coleoptera\n|genus=Cornicandovia\n|species=foo\n|auth=}}'), 'Cornicandovia foo');
    assert.equal(extractTaxonName('{{Coleoptera\n|genus=Cornicandovia\n|auth=}}'), 'Cornicandovia');
});

test('extractTaxonName returns null when no name can be found', () => {
    assert.equal(extractTaxonName('{{Wikidata Infobox}}\nno taxon here'), null);
});

test('doneScript namespaces localStorage keys per report segment', () => {
    const drafts = doneScript();                                   // segment ''
    assert.match(drafts, /localStorage\.setItem\('done-' \+ qid/);
    assert.match(drafts, /localStorage\.getItem\('hide-done'\)/);
    assert.doesNotMatch(drafts, /updateAggregate/);                // no aggregate panel

    const links = doneScript({ segment: 'links', aggregate: true });
    assert.match(links, /'done-links-' \+ qid/);
    assert.match(links, /'hide-done-links'/);
    assert.match(links, /function updateAggregate/);               // aggregate panel present
    assert.match(links, /function copyAggregate/);
});

test('renderReportPage assembles a full document with the copy helper and page script', () => {
    const html = renderReportPage({
        title: 'My Report',
        heading: 'My Report &mdash; 1 item',
        intro: 'do the thing',
        css: '    body { color: #222; }',
        thead: '      <tr><th>Col</th></tr>',
        rows: '    <tr id="row-Q1"><td>x</td></tr>',
        script: doneScript(),
    });
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.match(html, /<title>My Report<\/title>/);
    assert.match(html, /<h1>My Report &mdash; 1 item<\/h1>/);
    assert.match(html, /function copy\(el\)/);      // shared COPY_SCRIPT is injected
    assert.match(html, /row-Q1/);                   // rows are placed in the tbody
    assert.doesNotMatch(html, /aggregate-container/); // no aggregate unless requested
});

test('renderReportPage includes the aggregate panel and trailing markup when asked', () => {
    const html = renderReportPage({
        title: 't', heading: 'h', intro: 'i', css: '', thead: '', rows: '',
        aggregate: true, trailing: '\n  <h2>Conflicts</h2>', script: doneScript({ segment: 'links', aggregate: true }),
    });
    assert.match(html, /id="aggregate-container"/);
    assert.match(html, /<h2>Conflicts<\/h2>/);
});
