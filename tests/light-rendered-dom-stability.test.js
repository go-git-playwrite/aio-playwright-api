const assert = require('assert');
const hooks = require('../index.js').__lightBudgetTestHooks;

const {
  buildRenderedDomObservationV1_,
  shouldRetryLightRenderedDomObservation_,
  lightRenderedDomRetryAdmission_,
  createLightRequestBudget_,
  LIGHT_RENDERED_DOM_RETRY_MIN_REMAINING_MS,
  createLightAttempt_,
  runLightScrapeWithSetupRetry_,
  buildArticleSignalsFromJsonLdAndMeta_,
  buildFreshnessOperationSignalsFromArticleSignals_
} = hooks;

function geo(overrides = {}) {
  const base = {
    observed: {
      body: { textLength: 240, sample: 'Short but complete static page.' },
      links: { internalLinksSample: [] },
      primaryContentObserved: true,
      headingCollectionObserved: true
    },
    headings: { h1Count: 0, headingObservationLimited: false, source: 'dom' },
    coverage: { semanticElements: { semanticElementsObserved: true, hasMainElement: false } }
  };
  return Object.assign(base, overrides);
}

const completeSimple = buildRenderedDomObservationV1_(geo(), { navigationCompleted: true });
assert.strictEqual(completeSimple.observationVersion, 'rendered_dom_observation_v1');
assert.strictEqual(completeSimple.observationLimited, false);
assert.strictEqual(completeSimple.articleCandidateClassificationCompleted, true);
assert.strictEqual(shouldRetryLightRenderedDomObservation_(completeSimple, { lightMode: true }), false);

const shell = buildRenderedDomObservationV1_(geo({
  observed: {
    body: { textLength: 380, sample: 'Search Menu' },
    links: { internalLinksSample: [] },
    primaryContentObserved: false,
    headingCollectionObserved: true
  },
  headings: { h1Count: 1, headingObservationLimited: true, source: 'not_observed' }
}), { navigationCompleted: true });
assert.strictEqual(shell.primaryContentObserved, false);
assert.strictEqual(shell.articleCandidateClassificationCompleted, false);
assert.strictEqual(shell.observationLimited, true);
assert.strictEqual(shouldRetryLightRenderedDomObservation_(shell, { lightMode: true }), true);
assert.strictEqual(shouldRetryLightRenderedDomObservation_(shell, { lightMode: true, shortFastMode: true }), false);
assert.strictEqual(shouldRetryLightRenderedDomObservation_(shell, { lightMode: true, staticFallback: true }), false);
assert.strictEqual(shouldRetryLightRenderedDomObservation_(shell, { lightMode: true, retryAttempted: true }), false);
const retryBudget = createLightRequestBudget_(Date.now());
retryBudget.deadlineAt = Date.now() + LIGHT_RENDERED_DOM_RETRY_MIN_REMAINING_MS + 1000;
assert.strictEqual(lightRenderedDomRetryAdmission_(retryBudget, { cleanupComplete: true }, shell).allowed, true);
retryBudget.deadlineAt = Date.now() + 1;
assert.strictEqual(lightRenderedDomRetryAdmission_(retryBudget, { cleanupComplete: true }, shell).allowed, false);

const retryRich = buildRenderedDomObservationV1_(geo({
  articleSignals: { checked: true }
}), { navigationCompleted: true, retryAttempted: true, retrySucceeded: true });
assert.strictEqual(retryRich.retryAttempted, true);
assert.strictEqual(retryRich.retrySucceeded, true);
assert.strictEqual(retryRich.observationLimited, false);

const retryShell = buildRenderedDomObservationV1_(geo({
  observed: {
    body: { textLength: 100, sample: 'Menu' },
    links: { internalLinksSample: [] },
    primaryContentObserved: false,
    headingCollectionObserved: true
  }
}), { navigationCompleted: true, retryAttempted: true, retrySucceeded: false });
assert.strictEqual(retryShell.observationLimited, true);
assert.strictEqual(retryShell.articleCandidateClassificationCompleted, false);
assert.strictEqual(retryShell.retrySucceeded, false);

const visibleDate = buildArticleSignalsFromJsonLdAndMeta_([], {}, 'https://example.test/post/1/', [{
  kind: 'visible', value: '2026.09.03', articleContext: true, headerNearH1: true,
  dateSignal: true, labelled: true, excluded: false, source: 'article_header_visible_date'
}]);
assert.strictEqual(buildFreshnessOperationSignalsFromArticleSignals_(visibleDate, 'currentArticleSignals').latestDate, '2026-09-03');

(async () => {
  const budget = createLightRequestBudget_(Date.now());
  budget.deadlineAt = Date.now() + LIGHT_RENDERED_DOM_RETRY_MIN_REMAINING_MS + 1000;
  let calls = 0;
  const response = { headersSent: false };
  await runLightScrapeWithSetupRetry_(null, response, budget, async ({ attemptIndex }) => {
    calls += 1;
    if (attemptIndex === 1) {
      const error = new Error('incomplete shell');
      error.code = 'LIGHT_RENDERED_DOM_INCOMPLETE';
      error.lightBudgetStage = 'rendered_dom_observation';
      error.lightAttempt = createLightAttempt_(budget);
      error.renderedDomObservation = shell;
      throw error;
    }
    response.headersSent = true;
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(budget.resilience.retryPerformed, true);
  console.log('light rendered DOM stability fixtures passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
