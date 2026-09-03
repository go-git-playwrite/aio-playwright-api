const assert = require('assert');
const hooks = require('../index.js').__lightBudgetTestHooks;

const detailUrl = 'https://example.test/products/detail/1';
const strongHtml = `<!doctype html><html><body>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","description":"${'商品説明'.repeat(100)}","offers":{"@type":"Offer","price":1428,"priceCurrency":"JPY"}}</script>
  <div class="ec-productRole__description">${'購入判断に必要な商品説明です。'.repeat(30)}</div>
</body></html>`;
const emptyDetailHtml = '<!doctype html><html><body><h1>商品詳細</h1></body></html>';
const nonProductHtml = '<!doctype html><html><body><div class="ec-productRole__description">説明</div></body></html>';

const strong = hooks.parseSubpageJsonLdLightHtml(detailUrl, detailUrl, 200, strongHtml, 'ec');
assert.strictEqual(strong.hasProductOffering, true);
assert.strictEqual(strong.productOfferingObservationComplete, true);
assert.strictEqual(strong.productDescriptionObservationComplete, true);
assert.ok(strong.productDescriptionLength >= 300);

const empty = hooks.parseSubpageJsonLdLightHtml(detailUrl, detailUrl, 200, emptyDetailHtml, 'ec');
assert.strictEqual(empty.hasProductOffering, false);
assert.strictEqual(empty.productOfferingObservationComplete, true);
assert.strictEqual(empty.productDescriptionObservationComplete, true);
assert.strictEqual(empty.productDescriptionLength, 0);

const nonProduct = hooks.parseSubpageJsonLdLightHtml('https://example.test/help/about', 'https://example.test/help/about', 200, nonProductHtml, 'ec');
assert.deepStrictEqual(
  {
    offering: nonProduct.hasProductOffering,
    offeringComplete: nonProduct.productOfferingObservationComplete,
    descriptionLength: nonProduct.productDescriptionLength,
    descriptionComplete: nonProduct.productDescriptionObservationComplete
  },
  { offering: null, offeringComplete: false, descriptionLength: null, descriptionComplete: false }
);

const coverage = hooks.buildCoverageSignalsV1FromSubpageObservation_({
  siteMode: 'ec', candidates: [{ url: detailUrl, pageType: 'product' }], observations: [strong], coverageRuntime: {}
});
assert.strictEqual(coverage.hasObservedProductOffering, true);
assert.strictEqual(coverage.productOfferingObservationComplete, true);
assert.strictEqual(coverage.productDescriptionObservationComplete, true);
assert.strictEqual(coverage.productDescriptionLength, strong.productDescriptionLength);

const failed = hooks.buildCoverageSignalsV1FromSubpageObservation_({
  siteMode: 'ec', candidates: [{ url: detailUrl, pageType: 'product' }], observations: [{ url: detailUrl, ok: false }], coverageRuntime: {}
});
assert.strictEqual(failed.hasObservedProductOffering, null);
assert.strictEqual(failed.productOfferingObservationComplete, false);
assert.strictEqual(failed.productDescriptionLength, null);
assert.strictEqual(failed.productDescriptionObservationComplete, false);

console.log('ec product offering observation fixtures: ok');
