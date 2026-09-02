const assert = require('assert');
const { chromium } = require('playwright');
const { buildGeoSignalsV1 } = require('../index.js').__lightBudgetTestHooks;

function semanticElementsFor(signals) {
  return signals && signals.coverage && signals.coverage.semanticElements;
}

function assertGateShape(semanticElements) {
  assert(semanticElements && typeof semanticElements === 'object');
  assert.strictEqual(typeof semanticElements.hasMainElement, 'boolean');
}

async function observe(html, name) {
  const page = await globalThis.__semanticElementsTestBrowser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await buildGeoSignalsV1(page, `https://${name}.example.test/`, {
      balancedMode: false,
      shortFastMode: false
    });
  } finally {
    await page.close();
  }
}

(async () => {
  globalThis.__semanticElementsTestBrowser = await chromium.launch({ headless: true });
  try {
    const withMain = await observe(`
      <header>Header</header><nav>Navigation</nav><main><section>Main content</section></main><footer>Footer</footer>
    `, 'with-main');
    const withMainSemantic = semanticElementsFor(withMain);
    assertGateShape(withMainSemantic);
    assert.strictEqual(withMainSemantic.hasMainElement, true);

    // Sanden-equivalent DOM: semantic layout is observed successfully, but
    // it has no main element.  That is a valid false observation.
    const sandenLike = await observe(`
      <header>Header</header><nav>Navigation</nav><section>Content</section><footer>Footer</footer>
    `, 'sanden-like');
    const sandenSemantic = semanticElementsFor(sandenLike);
    assertGateShape(sandenSemantic);
    assert.strictEqual(sandenSemantic.hasMainElement, false);
    assert.strictEqual(sandenSemantic.hasHeaderElement, true);
    assert.strictEqual(sandenSemantic.hasNavElement, true);
    assert.strictEqual(sandenSemantic.hasFooterElement, true);
    assert.strictEqual(sandenSemantic.headerCount, 1);
    assert.strictEqual(sandenSemantic.navCount, 1);
    assert.strictEqual(sandenSemantic.footerCount, 1);
    assert.strictEqual(sandenSemantic.semanticElementsObserved, true);
    assert.strictEqual(sandenSemantic.source, 'rendered_dom_light');

    console.log('semantic-elements-light: ok');
  } finally {
    await globalThis.__semanticElementsTestBrowser.close();
    delete globalThis.__semanticElementsTestBrowser;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
