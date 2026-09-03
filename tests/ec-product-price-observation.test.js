const assert = require('assert');
const hooks = require('../index.js').__lightBudgetTestHooks;

const offerHtml = `<!doctype html><html><body><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","offers":{"@type":"Offer","price":1428,"priceCurrency":"JPY","availability":"https://schema.org/InStock"}}</script><span>卸・販売価格（税込）：会員のみ公開</span><nav>nav</nav></body></html>`;
const memberHtml = '<!doctype html><html><body><span>卸・販売価格（税込）：会員のみ公開</span></body></html>';
const noneHtml = '<!doctype html><html><body><h1>商品詳細</h1></body></html>';

const offer = hooks.parseSubpageJsonLdLightHtml('https://example.test/products/detail/1', 'https://example.test/products/detail/1', 200, offerHtml, 'ec');
const member = hooks.parseSubpageJsonLdLightHtml('https://example.test/products/detail/2', 'https://example.test/products/detail/2', 200, memberHtml, 'ec');
const none = hooks.parseSubpageJsonLdLightHtml('https://example.test/products/detail/3', 'https://example.test/products/detail/3', 200, noneHtml, 'ec');
const list = hooks.parseSubpageJsonLdLightHtml('https://example.test/products/list', 'https://example.test/products/list', 200, memberHtml, 'ec');

assert.deepStrictEqual(
  { value: offer.hasProductPrice, complete: offer.productPriceObservationComplete, source: offer.productPriceSignalSource },
  { value: true, complete: true, source: 'offer_price' }
);
assert.deepStrictEqual(
  { value: member.hasProductPrice, complete: member.productPriceObservationComplete, source: member.productPriceSignalSource },
  { value: true, complete: true, source: 'member_price_notice' }
);
assert.deepStrictEqual(
  { value: none.hasProductPrice, complete: none.productPriceObservationComplete },
  { value: false, complete: true }
);
assert.deepStrictEqual(
  { value: list.hasProductPrice, complete: list.productPriceObservationComplete },
  { value: null, complete: false }
);

const candidates = [
  { url: 'https://example.test/products/list', pageType: 'product', score: 100 },
  { url: 'https://example.test/category/a', pageType: 'category', score: 90 },
  { url: 'https://example.test/products/detail/1', pageType: 'product', score: 1 },
  { url: 'https://example.test/help/about', pageType: 'faq', score: 80 }
];
const ecPlan = hooks.buildLightCoverageObservationPlan_(candidates, { siteMode: 'ec', maxObserve: 2 });
const saasPlan = hooks.buildLightCoverageObservationPlan_(candidates, { siteMode: 'saas', maxObserve: 2 });
assert.strictEqual(ecPlan.candidates[0].url, 'https://example.test/products/detail/1');
assert.strictEqual(ecPlan.candidates.length, 2);
assert.notStrictEqual(saasPlan.candidates[0].url, 'https://example.test/products/detail/1');
const noDetailPlan = hooks.buildLightCoverageObservationPlan_(candidates.filter(item => !/detail/.test(item.url)), { siteMode: 'ec', maxObserve: 2 });
assert.strictEqual(noDetailPlan.candidates[0].url, 'https://example.test/products/list');
['corporate', 'media', 'saas'].forEach(siteMode => {
  const plan = hooks.buildLightCoverageObservationPlan_(candidates, { siteMode, maxObserve: 2 });
  assert.notStrictEqual(plan.candidates[0].url, 'https://example.test/products/detail/1');
});

const coverage = hooks.buildCoverageSignalsV1FromSubpageObservation_({
  siteMode: 'ec', candidates: [candidates[2]], observations: [offer], coverageRuntime: {}
});
assert.strictEqual(coverage.hasObservedProductPrice, true);
assert.strictEqual(coverage.productPriceObservationComplete, true);
assert.strictEqual(coverage.productPriceObservationCompletedPageCount, 1);
assert.strictEqual(coverage.observedProductPricePageCount, 1);
assert.strictEqual(coverage.representativePages[0].hasProductPrice, true);

const unknown = hooks.buildCoverageSignalsV1FromSubpageObservation_({
  siteMode: 'ec', candidates: [candidates[2]], observations: [{ url: candidates[2].url, ok: false }], coverageRuntime: {}
});
assert.strictEqual(unknown.hasObservedProductPrice, null);
assert.strictEqual(unknown.productPriceObservationComplete, false);

console.log('ec product price observation fixtures: ok');
