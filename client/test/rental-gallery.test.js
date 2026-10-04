'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateCatalog, selectGalleryMatch } = require('../src/rental-gallery');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZPq0AAAAASUVORK5CYII=', 'base64');
const baseProperty = {
  id: 'test-home', title: '测试房源（仅自动化用例）', city: '石家庄市', district: '桥西区',
  locations: ['维明南大街', '测试小区'], rent: 1500, bedrooms: 2, rentalType: 'entire',
  minLeaseMonths: 12, purpose: 'residential', available: true, features: ['电梯', '独立卫生间'], images: ['room.png'],
};
const baseDemand = {
  city: '石家庄', district: '桥西', locations: ['维明南大街'], budgetMin: null, budgetMax: 1800,
  bedrooms: [2], rentalType: 'entire', leaseMonthsMin: 12, leaseMonthsMax: 12,
  purpose: 'residential', moveIn: '', requirements: ['有电梯'], evidence: {}, missing: [],
};

async function fixture(t, properties = [baseProperty]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rental-gallery-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, 'gallery.json');
  await fs.writeFile(path.join(directory, 'room.png'), PNG);
  await fs.writeFile(catalogPath, JSON.stringify({ version: 1, properties }));
  return { directory, catalogPath };
}

test('local gallery matches all explicit requirements and returns the selected image provenance', async (t) => {
  const { directory, catalogPath } = await fixture(t);
  const match = await selectGalleryMatch({ demand: baseDemand, catalogPath });
  assert.equal(match.status, 'matched');
  assert.equal(match.source, 'local');
  assert.equal(match.property.id, 'test-home');
  assert.equal(match.imagePath, path.join(directory, 'room.png'));
  assert.ok(match.matchReasons.some((reason) => reason.includes('维明南大街')));
  assert.ok(match.matchReasons.some((reason) => reason.includes('1500')));
});

test('unknown demand does not acquire a made-up region or budget', async (t) => {
  const { catalogPath } = await fixture(t);
  assert.equal((await selectGalleryMatch({ demand: {}, catalogPath })).status, 'needs_more_info');
  assert.equal((await selectGalleryMatch({ demand: { city: '石家庄' }, catalogPath })).status, 'matched');
  assert.equal((await selectGalleryMatch({ demand: null, catalogPath })).status, 'needs_more_info');
});

test('conflicting explicit city, district, location, budget, bedroom and rental type all reject', async (t) => {
  const { catalogPath } = await fixture(t);
  for (const change of [
    { city: '成都' }, { district: '长安区' }, { locations: ['其他小区'] },
    { budgetMax: 1400 }, { budgetMin: 1600 }, { bedrooms: [1, 3] }, { rentalType: 'shared' },
  ]) {
    const result = await selectGalleryMatch({ demand: { ...baseDemand, ...change }, catalogPath });
    assert.equal(result.status, 'no_match', JSON.stringify(change));
    assert.equal(result.imagePath, undefined);
  }
});

test('commercial and explicit 1–3 month rentals never match even without a configured catalog', async () => {
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, purpose: 'commercial' } })).status, 'no_match');
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, leaseMonthsMin: 1, leaseMonthsMax: 3 } })).status, 'no_match');
});

test('lease intervals must share an eligible long-term option', async (t) => {
  const { catalogPath } = await fixture(t, [{ ...baseProperty, minLeaseMonths: 6, maxLeaseMonths: 12 }]);
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).status, 'matched');
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, leaseMonthsMin: 4, leaseMonthsMax: 5 }, catalogPath })).status, 'no_match');
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, leaseMonthsMin: 24, leaseMonthsMax: 24 }, catalogPath })).status, 'no_match');
});

test('unproven and opposite extra requirements are not treated as matches', async (t) => {
  const { catalogPath } = await fixture(t);
  for (const requirements of [['可养宠'], ['无电梯'], ['不要电梯'], ['有阳台']]) {
    const result = await selectGalleryMatch({ demand: { ...baseDemand, requirements }, catalogPath });
    assert.equal(result.status, 'no_match');
    assert.match(result.reason, /无法证明/);
  }
});

test('availability and move-in dates are verified without guessing natural language dates', async (t) => {
  const { catalogPath } = await fixture(t, [{ ...baseProperty, availableFrom: '2026-09-20' }]);
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, moveIn: '2026-09-21' }, catalogPath })).status, 'matched');
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, moveIn: '2026-09-10' }, catalogPath })).status, 'no_match');
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, moveIn: '月底' }, catalogPath })).status, 'no_match');
  const unavailable = await fixture(t, [{ ...baseProperty, available: false }]);
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath: unavailable.catalogPath })).status, 'no_match');
});

test('missing and empty catalogs report configuration/no-match, malformed catalogs report failure', async (t) => {
  const { directory, catalogPath } = await fixture(t, []);
  assert.equal((await selectGalleryMatch({ demand: baseDemand })).status, 'not_configured');
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath: path.join(directory, 'missing.json') })).status, 'not_configured');
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).status, 'no_match');
  await fs.writeFile(catalogPath, '{invalid');
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).status, 'failed');
  await fs.writeFile(catalogPath, JSON.stringify({ version: 1, properties: [{ ...baseProperty, rent: '1500' }] }));
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).status, 'failed');
});

test('bad or missing images never cause an arbitrary image fallback', async (t) => {
  const { directory, catalogPath } = await fixture(t, [{ ...baseProperty, images: ['missing.png', 'fake.jpg', 'https://example.invalid/a.jpg'] }]);
  await fs.writeFile(path.join(directory, 'fake.jpg'), 'not a photograph despite the extension');
  const result = await selectGalleryMatch({ demand: baseDemand, catalogPath });
  assert.equal(result.status, 'no_match');
  assert.equal(result.imagePath, undefined);
  assert.match(result.reason, /有效本地图片/);
});

test('selects the first valid image from the matched property, including an absolute path', async (t) => {
  const { directory, catalogPath } = await fixture(t);
  const imagePath = path.join(directory, 'room.png');
  await fs.writeFile(catalogPath, JSON.stringify({ version: 1, properties: [{ ...baseProperty, images: ['missing.jpg', imagePath] }] }));
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).imagePath, imagePath);
});

test('oversized image is not selected', async (t) => {
  const { directory, catalogPath } = await fixture(t, [{ ...baseProperty, images: ['too-big.png'] }]);
  const image = await fs.open(path.join(directory, 'too-big.png'), 'w');
  await image.write(PNG);
  await image.truncate(20 * 1024 * 1024 + 1);
  await image.close();
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).status, 'no_match');
});

test('multiple valid properties use deterministic location/price/ID ordering', async (t) => {
  const { catalogPath } = await fixture(t, [
    { ...baseProperty, id: 'z', rent: 1600 },
    { ...baseProperty, id: 'b', rent: 1500 },
    { ...baseProperty, id: 'a', rent: 1500 },
  ]);
  assert.equal((await selectGalleryMatch({ demand: baseDemand, catalogPath })).property.id, 'a');
});

test('a same-name district in multiple cities requires the user city to be known', async (t) => {
  const { catalogPath } = await fixture(t, [
    { ...baseProperty, id: 'shijiazhuang' },
    { ...baseProperty, id: 'zhangjiakou', city: '张家口市', rent: 5000 },
  ]);
  assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, city: '' }, catalogPath })).status, 'needs_more_info');
});

test('validator returns a clean future-API-compatible catalog and rejects invalid shapes', () => {
  const normalized = validateCatalog({ version: 1, properties: [{ ...baseProperty, features: undefined, locations: undefined, unexpected: 'ignored' }] });
  assert.deepEqual(normalized.properties[0].features, []);
  assert.equal(normalized.properties[0].unexpected, undefined);
  for (const properties of [
    [{ ...baseProperty, available: 'true' }],
    [{ ...baseProperty, purpose: 'commercial' }],
    [{ ...baseProperty, bedrooms: -1 }],
    [{ ...baseProperty, minLeaseMonths: 12, maxLeaseMonths: 6 }],
    [{ ...baseProperty, availableFrom: '2026-02-30' }],
    [{ ...baseProperty, images: 'room.png' }],
    [baseProperty, baseProperty],
  ]) assert.throws(() => validateCatalog({ version: 1, properties }));
});

test('invalid demand values pause matching instead of widening the query', async (t) => {
  const { catalogPath } = await fixture(t);
  for (const change of [{ budgetMax: '1800' }, { budgetMin: 2000, budgetMax: 1000 }, { bedrooms: ['2'] }, { leaseMonthsMin: 12, leaseMonthsMax: 6 }]) {
    assert.equal((await selectGalleryMatch({ demand: { ...baseDemand, ...change }, catalogPath })).status, 'needs_more_info');
  }
});
