const assert = require('assert');
const { chromium } = require('playwright');
const hooks = require('../index.js').__lightBudgetTestHooks;

const {
  buildGeoSignalsV1,
  buildHeadObservations_,
  extractTopPageStaticSignalsFromHtml_,
  buildStaticFallbackGeoSignalsPayload_,
  mergeTopPageStaticSignalsIntoPayload_
} = hooks;

function gasBridgeEquivalent(observation) {
  if (!observation || observation.observed !== true) return null;
  return typeof observation.value === 'string' && observation.value.trim() !== '';
}

function assertHead(observation, expectedObserved, expectedValue) {
  assert.strictEqual(observation.observed, expectedObserved);
  assert.strictEqual(observation.value, expectedValue);
}

async function observeNormal(html, name, options = {}) {
  const page = await globalThis.__headObservationBrowser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await buildGeoSignalsV1(page, `https://${name}.example.test/`, options);
  } finally {
    await page.close();
  }
}

(async () => {
  // Common primitive: present, absent, empty, and unavailable stay distinct.
  const present = buildHeadObservations_({ title: ' Title ', metaDescription: ' Description ' }, {
    observationCompleted: true,
    source: 'fixture'
  });
  assertHead(present.title, true, 'Title');
  assertHead(present.metaDescription, true, 'Description');
  assert.strictEqual(gasBridgeEquivalent(present.title), true);
  assert.strictEqual(gasBridgeEquivalent(present.metaDescription), true);

  const absent = buildHeadObservations_({}, { observationCompleted: true, source: 'fixture' });
  assertHead(absent.title, true, null);
  assertHead(absent.metaDescription, true, null);
  assert.strictEqual(gasBridgeEquivalent(absent.title), false);
  assert.strictEqual(gasBridgeEquivalent(absent.metaDescription), false);

  const empty = buildHeadObservations_({ title: '   ', metaDescription: '' }, {
    observationCompleted: true,
    source: 'fixture'
  });
  assertHead(empty.title, true, null);
  assertHead(empty.metaDescription, true, null);
  assert.strictEqual(gasBridgeEquivalent(empty.title), false);
  assert.strictEqual(gasBridgeEquivalent(empty.metaDescription), false);

  const unavailable = buildHeadObservations_({}, { observationCompleted: false, source: 'fixture' });
  assertHead(unavailable.title, false, null);
  assertHead(unavailable.metaDescription, false, null);
  assert.strictEqual(gasBridgeEquivalent(unavailable.title), null);
  assert.strictEqual(gasBridgeEquivalent(unavailable.metaDescription), null);

  globalThis.__headObservationBrowser = await chromium.launch({ headless: true });
  try {
    // Normal light and completion-first share buildGeoSignalsV1.
    const normalPresent = await observeNormal(
      '<title>Normal title</title><meta name="description" content="Normal description"><main>Body</main>',
      'normal-present'
    );
    assertHead(normalPresent.observed.title, true, 'Normal title');
    assertHead(normalPresent.observed.metaDescription, true, 'Normal description');

    const sandenLike = await observeNormal(
      '<header>Header</header><nav>Navigation</nav><section>Body</section><footer>Footer</footer>',
      'sanden-like'
    );
    assertHead(sandenLike.observed.title, true, null);
    assertHead(sandenLike.observed.metaDescription, true, null);
    assert.strictEqual(gasBridgeEquivalent(sandenLike.observed.metaDescription), false);

    const emptyTags = await observeNormal(
      '<title> </title><meta name="description" content=""><main>Body</main>',
      'empty-head-tags'
    );
    assertHead(emptyTags.observed.title, true, null);
    assertHead(emptyTags.observed.metaDescription, true, null);

    const completionFirstSharedBuilder = await observeNormal(
      '<main>Completion-first body</main>',
      'completion-first-absent',
      { balancedMode: true, shortFastMode: false }
    );
    assertHead(completionFirstSharedBuilder.observed.title, true, null);
    assertHead(completionFirstSharedBuilder.observed.metaDescription, true, null);

    // The short-fast dedicated response passes its phase-success result into
    // the same helper; successful empty head probes are valid false signals.
    const shortFastCompleted = buildHeadObservations_({}, {
      observationCompleted: true,
      source: 'basic_dom_eval'
    });
    assertHead(shortFastCompleted.title, true, null);
    assertHead(shortFastCompleted.metaDescription, true, null);
  } finally {
    await globalThis.__headObservationBrowser.close();
    delete globalThis.__headObservationBrowser;
  }

  // Static HTML parse success reports a confirmed absence, while a failed
  // static fetch/parse remains unavailable.
  const staticSignals = extractTopPageStaticSignalsFromHtml_(
    'https://static.example.test/',
    'https://static.example.test/',
    200,
    '<html><head></head><body><main>Static body</main></body></html>'
  );
  assert.strictEqual(staticSignals.parseSucceeded, true);
  const staticPayload = buildStaticFallbackGeoSignalsPayload_('https://static.example.test/', {
    success: true,
    finalUrl: 'https://static.example.test/',
    signals: staticSignals
  });
  assertHead(staticPayload.geoSignalsV1.observed.title, true, null);
  assertHead(staticPayload.geoSignalsV1.observed.metaDescription, true, null);
  assert.strictEqual(gasBridgeEquivalent(staticPayload.geoSignalsV1.observed.metaDescription), false);

  const staticUnavailable = buildStaticFallbackGeoSignalsPayload_('https://static-failed.example.test/', {
    success: false,
    signals: { parseSucceeded: false }
  });
  assertHead(staticUnavailable.geoSignalsV1.observed.title, false, null);
  assertHead(staticUnavailable.geoSignalsV1.observed.metaDescription, false, null);

  // Merge preserves completed rendered-DOM absence over unavailable static
  // data, but adopts a completed static observation after DOM failure.
  const staticForMerge = {
    success: true,
    finalUrl: 'https://merge.example.test/',
    signals: Object.assign({}, staticSignals, { finalUrl: 'https://merge.example.test/' })
  };
  const protectedGeo = {
    observed: buildHeadObservations_({}, { observationCompleted: true, source: 'rendered_dom' }),
    headings: {}, landmarks: {}, coverage: { semanticElements: {} }, diagnostics: {}
  };
  mergeTopPageStaticSignalsIntoPayload_(protectedGeo, {}, staticForMerge);
  assertHead(protectedGeo.observed.title, true, null);
  assertHead(protectedGeo.observed.metaDescription, true, null);
  assert.strictEqual(protectedGeo.observed.metaDescription.source, 'rendered_dom');

  const adoptStaticGeo = {
    observed: buildHeadObservations_({}, { observationCompleted: false }),
    headings: {}, landmarks: {}, coverage: { semanticElements: {} }, diagnostics: {}
  };
  mergeTopPageStaticSignalsIntoPayload_(adoptStaticGeo, {}, staticForMerge);
  assertHead(adoptStaticGeo.observed.title, true, null);
  assertHead(adoptStaticGeo.observed.metaDescription, true, null);
  assert.strictEqual(adoptStaticGeo.observed.metaDescription.source, 'top_page_static_html_fetch');

  console.log('head-observation-contract: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
