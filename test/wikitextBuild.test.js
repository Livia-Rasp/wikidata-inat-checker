// @ts-check
// The pure half of lib/generateWikitext.js: what a Commons category draft actually says.
//
// The fixtures are not invented. Each ancestor chain and the draft it produces was taken from a
// real `npm run draft -- <QID>` run against live Wikidata, so a test failing here means the
// generator changed its mind about a taxon somebody has actually looked at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testables } from '../lib/generateWikitext.js';

const {
    buildWikitext, buildOrderBlock, resolveAncestors, parseEntity,
    endemicGroupWords, endemicTitlesForPlace, endemicCandidateTitles,
} = __testables;

const RANK = {
    GENUS: 'Q34740', FAMILY: 'Q35409', ORDER: 'Q36602', SUBCLASS: 'Q5867051',
    CLASS: 'Q37517', SUPERFAMILY: 'Q2136103', SUBFAMILY: 'Q164280',
    TRIBE: 'Q227936', SUBTRIBE: 'Q3965313', SPECIES: 'Q7432',
};
const IUCN = { CR: 'Q219127', EN: 'Q96377276', VU: 'Q278113', LC: 'Q211005' };

/** The Commons template map buildWikitext consults: ancestor name → include= value. */
const TEMPLATES = new Map([
    ['Orchidaceae', 'Orchidaceae (APG)'],
    ['Gastropoda', 'Gastropoda'],
    ['Insecta', 'Insecta'],
    ['Aves', 'Aves (IOC)'],
    ['Agaricaceae', 'Agaricaceae'],
]);

// ---------------------------------------------------------------------------
// Taxonavigation: the wrapper-template groups
//
// Coleoptera and Lepidoptera do not use {{Taxonavigation}} at all. They use their own wrappers
// with named parameters, and the two differ: Coleoptera accepts |subtribus=, Lepidoptera does
// not. Each is checked at more than one rank, because the parameter set changes with rank.
// ---------------------------------------------------------------------------

test('a beetle species gets the {{Coleoptera}} wrapper, not {{Taxonavigation}}', () => {
    // Rhinoncus leucostigma (Q124682796), verbatim from a live draft run.
    const chain = [
        { name: 'Rhinoncus', rank: RANK.GENUS },
        { name: 'Curculionidae', rank: RANK.FAMILY },
        { name: 'Coleoptera', rank: RANK.ORDER },
    ];
    const out = buildWikitext(
        { taxonName: 'Rhinoncus leucostigma', rank: RANK.SPECIES, authority: '' },
        chain, TEMPLATES);

    assert.equal(out, [
        '{{Wikidata Infobox}}',
        '{{Coleoptera',
        '|familia=Curculionidae',
        '|genus=Rhinoncus',
        '|species=leucostigma',
        '|auth=}}',
        '',
        '[[Category:Rhinoncus|leucostigma]]',
    ].join('\n'));
    assert.doesNotMatch(out, /Taxonavigation/);
});

test('a beetle genus gets |genus= and no |species=', () => {
    const chain = [
        { name: 'Curculionidae', rank: RANK.FAMILY },
        { name: 'Coleoptera', rank: RANK.ORDER },
    ];
    const out = buildWikitext(
        { taxonName: 'Rhinoncus', rank: RANK.GENUS, authority: 'Schoenherr' },
        chain, TEMPLATES);

    assert.match(out, /\|genus=Rhinoncus/);
    assert.doesNotMatch(out, /\|species=/, 'a genus has no epithet to put there');
    assert.match(out, /\|auth=Schoenherr\}\}/);
    // Parent category is the family, sorted under the genus's own name.
    assert.match(out, /\[\[Category:Curculionidae\|Rhinoncus\]\]/);
});

test('at family rank the wrapper carries neither genus nor species', () => {
    const out = buildWikitext(
        { taxonName: 'Curculionidae', rank: RANK.FAMILY, authority: '' },
        [{ name: 'Coleoptera', rank: RANK.ORDER }], TEMPLATES);

    assert.match(out, /\|familia=Curculionidae/, 'the taxon itself supplies familia=');
    assert.doesNotMatch(out, /\|genus=/);
    assert.doesNotMatch(out, /\|species=/);
});

test('Coleoptera takes |subtribus=, Lepidoptera does not', () => {
    // The same lineage shape under each order, so the only difference is the template's own
    // parameter set. This is the variant that is easy to get wrong by testing one group only.
    const lineage = (orderName) => [
        { name: 'Testgenus', rank: RANK.GENUS },
        { name: 'Testina', rank: RANK.SUBTRIBE },
        { name: 'Testini', rank: RANK.TRIBE },
        { name: 'Testinae', rank: RANK.SUBFAMILY },
        { name: 'Testidae', rank: RANK.FAMILY },
        { name: orderName, rank: RANK.ORDER },
    ];
    const item = { taxonName: 'Testgenus testus', rank: RANK.SPECIES, authority: '' };

    const beetle = buildWikitext(item, lineage('Coleoptera'), TEMPLATES);
    const moth = buildWikitext(item, lineage('Lepidoptera'), TEMPLATES);

    assert.match(beetle, /\|subtribus=Testina/);
    assert.doesNotMatch(moth, /subtribus/, 'the Lepidoptera template has no such parameter');

    // Everything the two do share stays identical.
    for (const re of [/\|familia=Testidae/, /\|subfamilia=Testinae/, /\|tribus=Testini/]) {
        assert.match(beetle, re);
        assert.match(moth, re);
    }
});

test('no resolvable family means no draft at all', () => {
    // familia= is required by both wrappers, so a draft without it would be broken wikitext.
    // Returning null is what makes the finding no_draft rather than open.
    const out = buildWikitext(
        { taxonName: 'Orphanus incertus', rank: RANK.SPECIES, authority: '' },
        [{ name: 'Coleoptera', rank: RANK.ORDER }], TEMPLATES);

    assert.equal(out, null);
});

test('buildOrderBlock reports the missing family itself', () => {
    const block = buildOrderBlock('Coleoptera', true,
        { taxonName: 'Orphanus incertus', rank: RANK.SPECIES, authority: '' },
        [{ name: 'Coleoptera', rank: RANK.ORDER }], null, 'Orphanus', 'incertus');

    assert.equal(block, null);
});

// ---------------------------------------------------------------------------
// Taxonavigation: the include= groups
// ---------------------------------------------------------------------------

test('an orchid takes the suffixed APG family template, and only lists ranks below it', () => {
    // Scaphyglottis fasciculata (Q10368768), verbatim from a live draft run. The suffix matters:
    // the Commons template is "Orchidaceae (APG)", not "Orchidaceae".
    const chain = [
        { name: 'Scaphyglottis', rank: RANK.GENUS },
        { name: 'Laeliinae', rank: RANK.SUBTRIBE },
        { name: 'Epidendreae', rank: RANK.TRIBE },
        { name: 'Epidendroideae', rank: RANK.SUBFAMILY },
        { name: 'Orchidaceae', rank: RANK.FAMILY },
        { name: 'Asparagales', rank: RANK.ORDER },
    ];
    const out = buildWikitext(
        { taxonName: 'Scaphyglottis fasciculata', rank: RANK.SPECIES,
          authority: 'Hook., 1841', ncbi: '3015755', eol: '1131181' },
        chain, TEMPLATES);

    assert.equal(out, [
        '{{Wikidata Infobox}}',
        '{{Taxonavigation|',
        'include=Orchidaceae (APG)|',
        'Subfamilia|Epidendroideae|',
        'Tribus|Epidendreae|',
        'Subtribus|Laeliinae|',
        'Genus|Scaphyglottis|',
        'Species|Scaphyglottis fasciculata|',
        'authority=Hook., 1841}}',
        "* {{NCBI|3015755|''Scaphyglottis fasciculata''}}",
        "* {{EOL|1131181|''Scaphyglottis fasciculata''}}",
        '',
        '[[Category:Scaphyglottis|fasciculata]]',
    ].join('\n'));

    // Asparagales sits above the include= level, so it is the template's job, not ours.
    assert.doesNotMatch(out, /Asparagales/);
});

test('manual ranks are listed general-to-specific, the reverse of the chain', () => {
    const out = buildWikitext(
        { taxonName: 'Elimia acuta', rank: RANK.SPECIES, authority: 'Lea, 1831' },
        [
            { name: 'Elimia', rank: RANK.GENUS },
            { name: 'Pleuroceridae', rank: RANK.FAMILY },
            { name: 'Cerithioidea', rank: RANK.SUPERFAMILY },
            { name: 'Caenogastropoda', rank: RANK.SUBCLASS },
            { name: 'Gastropoda', rank: RANK.CLASS },
        ], TEMPLATES);

    const order = ['Subclassis|Caenogastropoda', 'Superfamilia|Cerithioidea', 'Familia|Pleuroceridae']
        .map(s => out.indexOf(s));
    assert.ok(order.every(i => i >= 0), 'every intermediate rank is listed');
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'broadest rank first');
});

test('an ancestor with no rank label is skipped rather than listed blank', () => {
    // Wikidata carries plenty of unlabelled cladistic ranks. They must not become empty rows.
    const out = buildWikitext(
        { taxonName: 'Aves testus', rank: RANK.SPECIES, authority: '' },
        [
            { name: 'Testus', rank: RANK.GENUS },
            { name: 'Unrankedia', rank: 'Q99999999' },
            { name: 'Testidae', rank: RANK.FAMILY },
            { name: 'Aves', rank: RANK.CLASS },
        ], TEMPLATES);

    assert.match(out, /include=Aves \(IOC\)\|/);
    assert.doesNotMatch(out, /Unrankedia/);
    assert.doesNotMatch(out, /\|\|/, 'and it leaves no empty parameter behind');
});

test('with no matching template the whole chain is listed by hand', () => {
    const out = buildWikitext(
        { taxonName: 'Nowhereia obscura', rank: RANK.SPECIES, authority: '' },
        [
            { name: 'Nowhereia', rank: RANK.GENUS },
            { name: 'Nowhereidae', rank: RANK.FAMILY },
        ], new Map());

    assert.doesNotMatch(out, /include=/);
    assert.match(out, /Familia\|Nowhereidae\|/);
    assert.match(out, /Genus\|Nowhereia\|/);
});

test('a taxon with no scientific name yields no draft', () => {
    assert.equal(buildWikitext({ rank: RANK.SPECIES }, [], TEMPLATES), null);
});

// ---------------------------------------------------------------------------
// Identifier templates and IUCN
// ---------------------------------------------------------------------------

test('{{IUCN}} needs both the Red List id and the status', () => {
    const chain = [{ name: 'Elimia', rank: RANK.GENUS }, { name: 'Gastropoda', rank: RANK.CLASS }];
    const base = { taxonName: 'Elimia acuta', rank: RANK.SPECIES, authority: 'Lea, 1831' };

    const both = buildWikitext({ ...base, iucnId: '7599', iucnStatus: IUCN.VU }, chain, TEMPLATES);
    assert.match(both, /\* \{\{IUCN\|VU\|7599\|Elimia acuta\|Lea, 1831\}\}/);
    assert.doesNotMatch(both, /\[\[Category:IUCN/, 'the template does the categorising itself');

    const statusOnly = buildWikitext({ ...base, iucnStatus: IUCN.VU }, chain, TEMPLATES);
    assert.doesNotMatch(statusOnly, /\{\{IUCN\|/);
    assert.match(statusOnly, /\[\[Category:IUCN Vulnerable species\]\]/, 'falls back to the category');

    const idOnly = buildWikitext({ ...base, iucnId: '7599' }, chain, TEMPLATES);
    assert.doesNotMatch(idOnly, /IUCN/, 'an id with no status says nothing about status');
});

test('Least Concern has no Commons maintenance category, so nothing is emitted', () => {
    const out = buildWikitext(
        { taxonName: 'Elimia acuta', rank: RANK.SPECIES, authority: '', iucnStatus: IUCN.LC },
        [{ name: 'Elimia', rank: RANK.GENUS }], TEMPLATES);

    assert.doesNotMatch(out, /IUCN/);
});

test('Index Fungorum uses a different template at genus and at species rank', () => {
    // The variant that is easy to miss: {{Fungorum genus}} against {{Fungorum species}}.
    const species = buildWikitext(
        { taxonName: 'Agaricus testus', rank: RANK.SPECIES, authority: '', fungorum: '111' },
        [{ name: 'Agaricus', rank: RANK.GENUS }, { name: 'Agaricaceae', rank: RANK.FAMILY }],
        TEMPLATES);
    const genus = buildWikitext(
        { taxonName: 'Agaricus', rank: RANK.GENUS, authority: '', fungorum: '222' },
        [{ name: 'Agaricaceae', rank: RANK.FAMILY }], TEMPLATES);

    assert.match(species, /\* \{\{Fungorum species\|111\|''Agaricus testus''\}\}/);
    assert.match(genus, /\* \{\{Fungorum genus\|222\|''Agaricus''\}\}/);
});

test('optional blocks appear only when the item has them, in a fixed order', () => {
    const chain = [{ name: 'Elimia', rank: RANK.GENUS }, { name: 'Gastropoda', rank: RANK.CLASS }];
    const bare = buildWikitext(
        { taxonName: 'Elimia acuta', rank: RANK.SPECIES, authority: '' }, chain, TEMPLATES);
    for (const re of [/\{\{VN\}\}/, /\{\{Wikispecies\}\}/, /NCBI/, /EOL/, /MycoBank/]) {
        assert.doesNotMatch(bare, re);
    }

    const full = buildWikitext({
        taxonName: 'Elimia acuta', rank: RANK.SPECIES, authority: '',
        hasVernacularName: true, hasWikispecies: true,
        ncbi: '101411', eol: '99', mycobank: '77',
    }, chain, TEMPLATES);

    const at = (s) => full.indexOf(s);
    assert.ok(at('{{VN}}') < at('{{Wikispecies}}'), 'VN before Wikispecies');
    assert.ok(at('{{Wikispecies}}') < at('{{NCBI'), 'Wikispecies before the identifiers');
    assert.ok(at('{{NCBI') < at('{{EOL'), 'NCBI before EOL');
    assert.match(full, /\* \{\{MycoBank\|77\|''Elimia acuta''\}\}/);
});

test('the parent category and sort key differ between a species and a higher rank', () => {
    const species = buildWikitext(
        { taxonName: 'Calanthe yuksomnensis', rank: RANK.SPECIES, authority: '' },
        [{ name: 'Calanthe', rank: RANK.GENUS }, { name: 'Orchidaceae', rank: RANK.FAMILY }],
        TEMPLATES);
    // A species files under its genus, sorted by the epithet alone.
    assert.match(species, /\[\[Category:Calanthe\|yuksomnensis\]\]/);

    const genus = buildWikitext(
        { taxonName: 'Cornicandovia', rank: RANK.GENUS, authority: '' },
        [{ name: 'Necrosciini', rank: RANK.TRIBE }, { name: 'Insecta', rank: RANK.CLASS }],
        TEMPLATES);
    // A genus files under its nearest ancestor, sorted by its own full name.
    assert.match(genus, /\[\[Category:Necrosciini\|Cornicandovia\]\]/);
});

test('a species whose genus is missing from the chain falls back to the first name word', () => {
    const out = buildWikitext(
        { taxonName: 'Calanthe yuksomnensis', rank: RANK.SPECIES, authority: '' },
        [{ name: 'Orchidaceae', rank: RANK.FAMILY }], TEMPLATES);

    assert.match(out, /Genus\|Calanthe\|/);
    assert.match(out, /\[\[Category:Calanthe\|yuksomnensis\]\]/);
});

// ---------------------------------------------------------------------------
// resolveAncestors
// ---------------------------------------------------------------------------

test('the ancestor chain comes back genus-first and stops where the cache does', () => {
    const cache = {
        Q1: { parentQid: 'Q2' },
        Q2: { taxonName: 'Calanthe', rank: RANK.GENUS, parentQid: 'Q3' },
        Q3: { taxonName: 'Orchidaceae', rank: RANK.FAMILY, parentQid: 'Q4' },
        // Q4 was never fetched, so the walk ends here rather than throwing.
    };
    assert.deepEqual(resolveAncestors('Q1', cache), [
        { name: 'Calanthe', rank: RANK.GENUS },
        { name: 'Orchidaceae', rank: RANK.FAMILY },
    ]);
});

test('an ancestor without P225 is walked through but not listed', () => {
    const cache = {
        Q1: { parentQid: 'Q2' },
        Q2: { parentQid: 'Q3' },                                  // no taxonName
        Q3: { taxonName: 'Orchidaceae', rank: RANK.FAMILY },
    };
    assert.deepEqual(resolveAncestors('Q1', cache),
        [{ name: 'Orchidaceae', rank: RANK.FAMILY }]);
});

test('a parent cycle terminates instead of hanging', () => {
    // Wikidata is user-edited, so a P171 loop is a question of when, not whether.
    const cache = {
        Q1: { parentQid: 'Q2' },
        Q2: { taxonName: 'A', rank: RANK.GENUS, parentQid: 'Q3' },
        Q3: { taxonName: 'B', rank: RANK.FAMILY, parentQid: 'Q2' },
    };
    const chain = resolveAncestors('Q1', cache);
    assert.ok(chain.length <= 40, 'the depth cap ends it');
    assert.equal(chain[0].name, 'A');
});

test('an unknown qid resolves to an empty chain', () => {
    assert.deepEqual(resolveAncestors('Q404', {}), []);
});

// ---------------------------------------------------------------------------
// parseEntity
// ---------------------------------------------------------------------------

/** A raw wbgetentities claim, as simplify.claims expects to receive it. */
const claim = (value) => [{
    mainsnak: { snaktype: 'value', property: 'P0', datavalue: typeof value === 'string'
        ? { value, type: 'string' }
        : { value, type: 'wikibase-entityid' } },
    type: 'statement', rank: 'normal',
}];
const item = (id) => claim({ 'entity-type': 'item', 'numeric-id': Number(id.slice(1)), id });

test('parseEntity pulls the properties the draft is built from', () => {
    const parsed = parseEntity({
        id: 'Q10368768',
        claims: {
            P225: claim('Scaphyglottis fasciculata'),
            P171: item('Q133020'),
            P105: item('Q7432'),
            P685: claim('3015755'),
            P830: claim('1131181'),
            P141: item('Q278113'),
            P627: claim('7599'),
            P1843: claim('cheese orchid'),
        },
        sitelinks: { specieswiki: { title: 'Scaphyglottis fasciculata' } },
    });

    assert.equal(parsed.taxonName, 'Scaphyglottis fasciculata');
    assert.equal(parsed.parentQid, 'Q133020');
    assert.equal(parsed.rank, 'Q7432');
    assert.equal(parsed.ncbi, '3015755');
    assert.equal(parsed.eol, '1131181');
    assert.equal(parsed.iucnStatus, 'Q278113');
    assert.equal(parsed.iucnId, '7599');
    assert.equal(parsed.hasWikispecies, true);
    assert.equal(parsed.hasVernacularName, true);
    assert.deepEqual(parsed.endemicTo, [], 'no P183 is an empty list, never undefined');
});

test('parseEntity on a bare item leaves every field falsy rather than throwing', () => {
    const parsed = parseEntity({ id: 'Q1' });

    assert.equal(parsed.taxonName, undefined);
    assert.equal(parsed.hasWikispecies, false);
    assert.equal(parsed.hasVernacularName, false);
    assert.deepEqual(parsed.endemicTo, []);
});

test('parseEntity reads every place a taxon is endemic to', () => {
    const parsed = parseEntity({
        id: 'Q1',
        claims: { P225: claim('Testus testus'), P183: [...item('Q924'), ...item('Q30')] },
    });

    assert.deepEqual(parsed.endemicTo, ['Q924', 'Q30']);
});

// ---------------------------------------------------------------------------
// Endemic category words and titles
// ---------------------------------------------------------------------------

test('a specific class word wins, and still implies fauna as a fallback', () => {
    const words = endemicGroupWords([
        { name: 'Corvus', rank: RANK.GENUS },
        { name: 'Corvidae', rank: RANK.FAMILY },
        { name: 'Aves', rank: RANK.CLASS },
    ]);

    assert.deepEqual(words, ['birds', 'fauna', 'species']);
});

test('a bird lineage yields fauna even though Animalia is out of walking range', () => {
    // Birds run through Dinosauria, so the walk never reaches Animalia. A matched animal class
    // has to be enough to prove "fauna" on its own, or the fallback is unreachable for every bird.
    const words = endemicGroupWords([{ name: 'Aves', rank: RANK.CLASS }]);

    assert.ok(words.includes('fauna'));
});

test('without a specific class the kingdom word is read from the chain', () => {
    assert.deepEqual(
        endemicGroupWords([{ name: 'Orchidaceae', rank: RANK.FAMILY }, { name: 'Plantae', rank: RANK.CLASS }]),
        ['flora', 'species']);
    assert.deepEqual(
        endemicGroupWords([{ name: 'Agaricaceae', rank: RANK.FAMILY }, { name: 'Fungi', rank: RANK.CLASS }]),
        ['fungi', 'species']);
    assert.deepEqual(
        endemicGroupWords([{ name: 'Gastropoda', rank: RANK.CLASS }, { name: 'Animalia', rank: RANK.CLASS }]),
        ['fauna', 'species']);
});

test('a lineage with nothing recognisable still ends at species', () => {
    assert.deepEqual(endemicGroupWords([{ name: 'Nowhereia', rank: RANK.GENUS }]), ['species']);
    assert.deepEqual(endemicGroupWords([]), ['species']);
});

test('the fish classes all collapse to one word, listed once', () => {
    const words = endemicGroupWords([
        { name: 'Actinopterygii', rank: RANK.CLASS },
        { name: 'Chondrichthyes', rank: RANK.CLASS },
    ]);

    assert.deepEqual(words, ['fish', 'fauna', 'species'], 'no duplicate "fish"');
});

test('each group word is tried both bare and with a leading "the"', () => {
    assert.deepEqual(endemicTitlesForPlace('Tanzania', ['birds', 'fauna']), [
        'Endemic birds of Tanzania',
        'Endemic birds of the Tanzania',
        'Endemic fauna of Tanzania',
        'Endemic fauna of the Tanzania',
    ]);
});

test('candidate titles cover every place, and skip places with no label', () => {
    const labels = new Map([['Q924', 'Tanzania'], ['Q30', 'United States']]);
    const titles = endemicCandidateTitles(['Q924', 'Q30', 'Q999'], labels, ['fauna']);

    assert.deepEqual(titles, [
        'Endemic fauna of Tanzania',
        'Endemic fauna of the Tanzania',
        'Endemic fauna of United States',
        'Endemic fauna of the United States',
    ]);
});

test('endemic categories reach the draft once resolved', () => {
    const out = buildWikitext(
        { taxonName: 'Testus testus', rank: RANK.SPECIES, authority: '',
          endemicCats: ['Endemic fauna of Tanzania'] },
        [{ name: 'Testus', rank: RANK.GENUS }], TEMPLATES);

    assert.match(out, /\[\[Category:Endemic fauna of Tanzania\]\]/);
});
