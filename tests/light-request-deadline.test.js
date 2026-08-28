const assert = require('assert');
const {
  collectArticleSignalsFromPageLight_,
  collectSameOriginScriptSrcJsonLdSummaryLight,
  buildLightCoverageObservationPlan_,
  fetchSubpageHtmlLightUrls_,
  isSubpageHtmlLightObservationSufficient_,
  buildCoverageSignalsV1FromSubpageObservation_,
  buildGeoSignalsCoverageSignals_,
  createLightRequestBudget_,
  createLightAttempt_,
  cleanupLightAttempt_,
  getLightPageCreateTimeoutMs_,
  getLightDomFallbackTimeoutMs_,
  isLightTopGotoTimeoutError_,
  assessLightDomFallbackSentinel_,
  probeLightDomReadiness_,
  getLightNavigationRecoveryTimeoutMs_,
  recoverLightTopPageNavigation_,
  lightSetupRetryAdmission_,
  isLightNavigationProbeRetryableFailure_,
  lightNavigationProbeRetryAdmission_,
  recordLightCheckpoint_,
  markLightStageCheckpoint_,
  getLightBudgetRemainingMs_,
  buildLightRequestTiming_,
  runLightBudgetStage_,
  runLightSupplementalBudgetTask_,
  collectLightHydrationMetricsWithinBudget_,
  getLightSupplementalDiagnosticFlags_,
  collectLightPostCoverageSupplementals_,
  sendLightBudgetTimeout_,
  enqueueLightScrapeWithDeadline_,
  runLightScrapeWithSetupRetry_
} = require('../index.js').__lightBudgetTestHooks;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const budgetFor = (ms) => {
  const budget = createLightRequestBudget_(Date.now());
  budget.budgetMs = ms;
  budget.deadlineAt = budget.startedAt + ms;
  return budget;
};

async function expectStageTimeout(stage, operation) {
  const budget = budgetFor(30);
  await assert.rejects(
    () => runLightBudgetStage_(budget, stage, 60000, operation),
    (error) => error && error.code === 'LIGHT_REQUEST_BUDGET_EXHAUSTED' && error.lightBudgetStage === stage
  );
  assert.strictEqual(budget.timeoutStage, stage);
}

function responseSpy() {
  return {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.headersSent = true; this.body = body; return this; }
  };
}

function domCandidate(overrides = {}) {
  return Object.assign({
    url: 'https://sitakke.jp/',
    readyState: 'interactive',
    hasBody: true,
    bodyTextLength: 100,
    h1Count: 1,
    headingCount: 3,
    linkCount: 5,
    hasHeaderElement: true,
    hasNavElement: true,
    hasFooterElement: true,
    imgCount: 1,
    challengeOrError: false
  }, overrides);
}

function probePage(sequence, options = {}) {
  const values = Array.isArray(sequence) ? sequence.slice() : [];
  let last = values.length ? values[values.length - 1] : domCandidate();
  return {
    isClosed: () => options.closed === true,
    evaluate: async () => {
      const next = values.length ? values.shift() : last;
      last = next;
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

(async () => {
  // Completion-first retains a hard safety boundary, while a simulated
  // 90-second Render response still has room to return under the 150-second
  // request budget.
  const completionBudget = budgetFor(150000);
  completionBudget.startedAt = Date.now() - 90000;
  completionBudget.deadlineAt = completionBudget.startedAt + 150000;
  assert(getLightBudgetRemainingMs_(completionBudget) >= 59000);
  assert.deepStrictEqual(
    await runLightBudgetStage_(completionBudget, 'browser_launch', 30000, async () => ({ ok: true })),
    { ok: true }
  );

  // A: normal setup stage keeps its result.
  const normalBudget = budgetFor(100);
  const normal = await runLightBudgetStage_(normalBudget, 'browser_launch', 60000, async () => ({ ok: true }));
  assert.deepStrictEqual(normal, { ok: true });

  // Coverage prioritizes real reachability evidence over media/article pages.
  const coverageCandidates = [
    { url: 'https://sitakke.jp/post/18503/', pageType: 'article', score: 100, source: 'article' },
    { url: 'https://sitakke.jp/contact/', pageType: 'contact', score: 10, source: 'nav' },
    { url: 'https://sitakke.jp/company/', pageType: 'about', score: 10, source: 'nav' },
    { url: 'https://sitakke.jp/service/', pageType: 'service', score: 10, source: 'nav' }
  ];
  const coveragePlan = buildLightCoverageObservationPlan_(coverageCandidates, { siteMode: 'media', maxObserve: 2 });
  assert.deepStrictEqual(coveragePlan.candidates.map(item => item.url), [
    'https://sitakke.jp/company/',
    'https://sitakke.jp/contact/'
  ]);
  const siteModePlan = (siteMode, candidates) => buildLightCoverageObservationPlan_(candidates, { siteMode, maxObserve: 2 })
    .candidates.map(item => item.pageType);
  assert.deepStrictEqual(siteModePlan('corporate', coverageCandidates), ['about', 'service']);
  assert.deepStrictEqual(siteModePlan('service', coverageCandidates), ['service', 'about']);
  assert.deepStrictEqual(siteModePlan('ec', [
    { url: 'https://shop.example.test/products/a/', pageType: 'product', score: 10, source: 'nav' },
    { url: 'https://shop.example.test/category/a/', pageType: 'category', score: 10, source: 'nav' },
    { url: 'https://shop.example.test/company/', pageType: 'about', score: 10, source: 'nav' },
    { url: 'https://shop.example.test/contact/', pageType: 'contact', score: 10, source: 'nav' }
  ]), ['product', 'about']);

  const htmlResponse = (url, html) => ({
    ok: true,
    status: 200,
    url,
    redirected: false,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => html
  });
  const slowCompanyFastContactBudget = budgetFor(140);
  slowCompanyFastContactBudget.deadlineAt = Date.now() + 110;
  const fetchOrder = [];
  const priorityHtml = await fetchSubpageHtmlLightUrls_(coveragePlan.candidates.map(item => item.url), {
    lightBudget: slowCompanyFastContactBudget,
    htmlFetchTimeoutMs: 30,
    reserveMs: 20,
    minimumMs: 5,
    reserveLaterCandidates: true,
    fetchImpl: (url, options) => {
      fetchOrder.push(url);
      if (/\/company\//.test(url)) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return Promise.resolve(htmlResponse(url, `<html><head><title>Contact</title></head><body><h1>Contact</h1><a href="/">Home</a><p>${'Contact information. '.repeat(24)}</p></body></html>`));
    }
  });
  assert.deepStrictEqual(fetchOrder, ['https://sitakke.jp/company/', 'https://sitakke.jp/contact/']);
  assert.strictEqual(priorityHtml.pages[0].ok, false);
  assert.strictEqual(priorityHtml.pages[0].errorStage, 'timeout');
  assert.strictEqual(priorityHtml.pages[1].ok, true);
  assert.strictEqual(isSubpageHtmlLightObservationSufficient_(priorityHtml.pages[1]), true);

  // The full HTML pass completes both priority candidates before the caller
  // computes Playwright fallback candidates.  An insufficient company page
  // therefore cannot preempt the contact HTML attempt.
  const insufficientHtmlOrder = [];
  const insufficientThenContact = await fetchSubpageHtmlLightUrls_(coveragePlan.candidates.map(item => item.url), {
    lightBudget: budgetFor(48000),
    htmlFetchTimeoutMs: 30,
    reserveMs: 20,
    minimumMs: 5,
    reserveLaterCandidates: true,
    fetchImpl: async (url) => {
      insufficientHtmlOrder.push(url);
      const content = /\/company\//.test(url)
        ? '<html><head><title>Company</title></head><body><h1>Company</h1><p>short</p></body></html>'
        : `<html><head><title>Contact</title></head><body><h1>Contact</h1><a href="/">Home</a><p>${'Contact information. '.repeat(24)}</p></body></html>`;
      return htmlResponse(url, content);
    }
  });
  assert.deepStrictEqual(insufficientHtmlOrder, ['https://sitakke.jp/company/', 'https://sitakke.jp/contact/']);
  assert.strictEqual(isSubpageHtmlLightObservationSufficient_(insufficientThenContact.pages[0]), false);
  assert.strictEqual(isSubpageHtmlLightObservationSufficient_(insufficientThenContact.pages[1]), true);

  // Candidate-level budget exhaustion is never inflated into an observed page,
  // but is surfaced explicitly on the coverage result and trace contract.
  const exhaustedCoverageBudget = budgetFor(100);
  exhaustedCoverageBudget.deadlineAt = Date.now() + 20;
  const exhaustedHtml = await fetchSubpageHtmlLightUrls_(coveragePlan.candidates.map(item => item.url), {
    lightBudget: exhaustedCoverageBudget,
    htmlFetchTimeoutMs: 30,
    reserveMs: 20,
    minimumMs: 5,
    reserveLaterCandidates: true,
    fetchImpl: async () => { throw new Error('must not fetch'); }
  });
  assert(exhaustedHtml.pages.every(page => page.ok === false && page.errorStage === 'budget'));
  const exhaustedCoverageSignals = buildGeoSignalsCoverageSignals_(buildCoverageSignalsV1FromSubpageObservation_({
    topUrl: 'https://sitakke.jp/',
    origin: 'https://sitakke.jp',
    siteMode: 'media',
    candidates: coveragePlan.candidates,
    observations: exhaustedHtml.pages,
    coverageRuntime: { observationLimited: true, budgetLimitedCandidateCount: 2, timedOutCandidateCount: 0 }
  }));
  assert.strictEqual(exhaustedCoverageSignals.observedSubpageCount, 0);
  assert.strictEqual(exhaustedCoverageSignals.observationLimited, true);
  assert.strictEqual(exhaustedCoverageSignals.budgetLimitedCandidateCount, 2);

  const timedOutCoverageSignals = buildGeoSignalsCoverageSignals_(buildCoverageSignalsV1FromSubpageObservation_({
    topUrl: 'https://sitakke.jp/', origin: 'https://sitakke.jp', siteMode: 'media',
    candidates: coveragePlan.candidates,
    observations: [{ url: 'https://sitakke.jp/company/', ok: false, errorStage: 'timeout' }],
    coverageRuntime: { observationLimited: true, budgetLimitedCandidateCount: 0, timedOutCandidateCount: 1 }
  }));
  assert.strictEqual(timedOutCoverageSignals.observedSubpageCount, 0);
  assert.strictEqual(timedOutCoverageSignals.observationLimited, true);
  assert.strictEqual(timedOutCoverageSignals.timedOutCandidateCount, 1);
  const httpFailedCoverageSignals = buildGeoSignalsCoverageSignals_(buildCoverageSignalsV1FromSubpageObservation_({
    topUrl: 'https://sitakke.jp/', origin: 'https://sitakke.jp', siteMode: 'media',
    candidates: coveragePlan.candidates,
    observations: [{ url: 'https://sitakke.jp/company/', ok: false, status: 404, errorStage: 'fetch' }],
    coverageRuntime: { observationLimited: false, budgetLimitedCandidateCount: 0, timedOutCandidateCount: 0 }
  }));
  assert.strictEqual(httpFailedCoverageSignals.observedSubpageCount, 0);
  assert.strictEqual(httpFailedCoverageSignals.observationLimited, false);
  assert.strictEqual(httpFailedCoverageSignals.budgetLimitedCandidateCount, 0);
  assert.strictEqual(httpFailedCoverageSignals.timedOutCandidateCount, 0);
  const limitedTraceBudget = budgetFor(48000);
  limitedTraceBudget.coverageTrace = {
    started: true,
    skippedDueToBudget: false,
    completed: true,
    observationLimited: true,
    budgetLimitedCandidateCount: 2
  };
  assert.deepStrictEqual(buildLightRequestTiming_(limitedTraceBudget, limitedTraceBudget.startedAt).coverageTrace, limitedTraceBudget.coverageTrace);

  // Supplemental enrichment is bounded as a whole, not only at an individual
  // network request. Its timeout is a skip and leaves the core budget usable.
  const supplementalBudget = budgetFor(48000);
  const supplemental = await runLightSupplementalBudgetTask_(
    supplementalBudget,
    'same_origin_script_scan',
    30,
    async () => ({ organizationProfile: { telephone: null }, hasJsonLd: false })
  );
  assert.strictEqual(supplemental.state, 'completed');
  assert.strictEqual(supplemental.value.hasJsonLd, false);
  assert.deepStrictEqual(getLightSupplementalDiagnosticFlags_(supplemental), {
    skippedDueToBudget: false,
    timedOut: false
  });

  const scriptScanPage = (source) => ({
    url: () => 'https://sitakke.jp/',
    evaluate: async () => source === 'script_src_discovery' ? new Promise(() => {}) : ['https://sitakke.jp/app.js'],
    content: async () => source === 'page_content' ? new Promise(() => {}) : '<script src="/app.js"></script>',
    request: {
      get: async () => source === 'script_request'
        ? new Promise(() => {})
        : ({ headers: () => ({}), text: async () => source === 'script_response_text' ? new Promise(() => {}) : '' })
    }
  });
  for (const source of ['script_src_discovery', 'page_content', 'script_request', 'script_response_text']) {
    const boundedBudget = budgetFor(48000);
    const timedOut = await runLightSupplementalBudgetTask_(
      boundedBudget,
      'same_origin_script_scan',
      5,
      () => collectSameOriginScriptSrcJsonLdSummaryLight(scriptScanPage(source), 'https://sitakke.jp/', {
        maxScripts: 1,
        requestTimeoutMs: 500
      })
    );
    assert.strictEqual(timedOut.state, 'timed_out', source);
    assert(boundedBudget.skipped.includes('same_origin_script_scan'), source);
    assert(getLightBudgetRemainingMs_(boundedBudget) > 40000, source);
    assert.deepStrictEqual(getLightSupplementalDiagnosticFlags_(timedOut), {
      skippedDueToBudget: false,
      timedOut: true
    }, source);
  }

  const insufficientSupplementalBudget = budgetFor(48000);
  insufficientSupplementalBudget.deadlineAt = Date.now() + 500;
  let supplementalStarted = false;
  const skippedSupplemental = await runLightSupplementalBudgetTask_(
    insufficientSupplementalBudget,
    'same_origin_script_scan',
    2500,
    async () => { supplementalStarted = true; return { ignored: true }; },
    { reserveMs: 1000, minimumMs: 750 }
  );
  assert.strictEqual(skippedSupplemental.state, 'skipped_due_to_budget');
  assert.strictEqual(supplementalStarted, false);
  assert(insufficientSupplementalBudget.skipped.includes('same_origin_script_scan'));
  assert.deepStrictEqual(getLightSupplementalDiagnosticFlags_(skippedSupplemental), {
    skippedDueToBudget: true,
    timedOut: false
  });

  const articleBudget = budgetFor(48000);
  const articleTimeout = await runLightSupplementalBudgetTask_(
    articleBudget,
    'article_signals',
    5,
    () => collectArticleSignalsFromPageLight_({ evaluate: () => new Promise(() => {}) }, 'https://sitakke.jp/')
  );
  assert.strictEqual(articleTimeout.state, 'timed_out');
  assert.deepStrictEqual(getLightSupplementalDiagnosticFlags_(articleTimeout), {
    skippedDueToBudget: false,
    timedOut: true
  });
  const articleNoBudget = budgetFor(48000);
  articleNoBudget.deadlineAt = Date.now() + 100;
  const articleSkipped = await runLightSupplementalBudgetTask_(
    articleNoBudget,
    'article_signals',
    1500,
    async () => ({ checked: true }),
    { reserveMs: 1000, minimumMs: 500 }
  );
  assert.strictEqual(articleSkipped.state, 'skipped_due_to_budget');
  assert.deepStrictEqual(getLightSupplementalDiagnosticFlags_(articleSkipped), {
    skippedDueToBudget: true,
    timedOut: false
  });

  // Post-coverage enrichment preserves the response/cleanup reserve. At the
  // observed ~5s remainder, both enrichments remain unobserved rather than
  // delaying the already-complete core response.
  const postCoverageSkipBudget = budgetFor(48000);
  postCoverageSkipBudget.deadlineAt = Date.now() + 4900;
  let postCoverageFetchStarted = false;
  let postCoverageEvaluateStarted = false;
  const postCoverageSkipped = await collectLightPostCoverageSupplementals_({
    request: { get: async () => { postCoverageFetchStarted = true; throw new Error('must not run'); } },
    evaluate: async () => { postCoverageEvaluateStarted = true; throw new Error('must not run'); }
  }, 'https://sitakke.jp/', {
    lightBudget: postCoverageSkipBudget,
    shouldCollectProductSpec: true,
    hasProductJsonLd: false
  });
  assert.strictEqual(postCoverageSkipBudget.activeStage, 'post_coverage_supplemental');
  assert.strictEqual(postCoverageFetchStarted, false);
  assert.strictEqual(postCoverageEvaluateStarted, false);
  assert.strictEqual(postCoverageSkipped.sitemapDiscovery.exists, null);
  assert.deepStrictEqual(postCoverageSkipped.sitemapFlags, { skippedDueToBudget: true, timedOut: false });
  assert.strictEqual(postCoverageSkipped.productSpecComparisonSignals, null);
  assert.deepStrictEqual(postCoverageSkipped.productSpecFlags, { skippedDueToBudget: true, timedOut: false });

  const sitemapResponse = (status, text = '', contentType = 'text/plain') => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    headers: () => ({ 'content-type': contentType }),
    text: async () => text
  });
  const sitemapRequests = [];
  const normalPostCoverage = await collectLightPostCoverageSupplementals_({
    request: {
      get: async (url) => {
        sitemapRequests.push(url);
        return /robots\.txt$/.test(url)
          ? sitemapResponse(404)
          : sitemapResponse(200, '<urlset></urlset>', 'application/xml');
      }
    },
    evaluate: async () => ({ observed: true, specLikeTablesCount: 1, comparisonLikeTablesCount: 0, specDlCount: 0, comparisonCueCount: 0, evidenceSources: [] })
  }, 'https://sitakke.jp/', {
    lightBudget: budgetFor(48000),
    shouldCollectProductSpec: true,
    hasProductJsonLd: false
  });
  assert.deepStrictEqual(sitemapRequests, ['https://sitakke.jp/robots.txt', 'https://sitakke.jp/sitemap.xml']);
  assert.strictEqual(normalPostCoverage.sitemapDiscovery.exists, true);
  assert.deepStrictEqual(normalPostCoverage.sitemapFlags, { skippedDueToBudget: false, timedOut: false });
  assert.strictEqual(normalPostCoverage.productSpecComparisonSignals.hasStructuredProductInfo, true);
  assert.deepStrictEqual(normalPostCoverage.productSpecFlags, { skippedDueToBudget: false, timedOut: false });

  const notFoundSitemapRequests = [];
  const sitemapNotFound = await collectLightPostCoverageSupplementals_({
    request: {
      get: async (url) => {
        notFoundSitemapRequests.push(url);
        return sitemapResponse(404);
      }
    },
    evaluate: async () => ({ observed: true, specLikeTablesCount: 0, comparisonLikeTablesCount: 0, specDlCount: 0, comparisonCueCount: 0, evidenceSources: [] })
  }, 'https://sitakke.jp/', {
    lightBudget: budgetFor(48000),
    shouldCollectProductSpec: false,
    hasProductJsonLd: false
  });
  assert.strictEqual(notFoundSitemapRequests.length, 6);
  assert.strictEqual(sitemapNotFound.sitemapDiscovery.exists, false);
  assert.deepStrictEqual(sitemapNotFound.sitemapFlags, { skippedDueToBudget: false, timedOut: false });

  const sitemapHangBudget = budgetFor(48000);
  const sitemapTimedOut = await collectLightPostCoverageSupplementals_({
    request: {
      get: async (url) => /robots\.txt$/.test(url)
        ? sitemapResponse(404)
        : new Promise(() => {})
    },
    evaluate: async () => ({ observed: true, specLikeTablesCount: 0, comparisonLikeTablesCount: 0, specDlCount: 0, comparisonCueCount: 0, evidenceSources: [] })
  }, 'https://sitakke.jp/', {
    lightBudget: sitemapHangBudget,
    shouldCollectProductSpec: false,
    hasProductJsonLd: false
  });
  assert.strictEqual(sitemapTimedOut.sitemapDiscovery.exists, null);
  assert.deepStrictEqual(sitemapTimedOut.sitemapFlags, { skippedDueToBudget: false, timedOut: true });

  const productHangBudget = budgetFor(48000);
  const productTimedOut = await collectLightPostCoverageSupplementals_({
    request: { get: async () => sitemapResponse(404) },
    evaluate: async () => new Promise(() => {})
  }, 'https://sitakke.jp/', {
    lightBudget: productHangBudget,
    shouldCollectProductSpec: true,
    hasProductJsonLd: false
  });
  assert.strictEqual(productTimedOut.productSpecComparisonSignals, null);
  assert.deepStrictEqual(productTimedOut.productSpecFlags, { skippedDueToBudget: false, timedOut: true });

  // Page creation allows a transient 5.4s setup delay when the global budget
  // is healthy, but retains the 5s response/cleanup reserve.
  const pageCreateBudget = budgetFor(150000);
  assert.strictEqual(getLightPageCreateTimeoutMs_(pageCreateBudget), 15000);
  pageCreateBudget.deadlineAt = Date.now() + 4200;
  assert.strictEqual(getLightPageCreateTimeoutMs_(pageCreateBudget), 0);

  // A-C/H: only a Playwright goto TimeoutError is eligible, and a stable DOM
  // candidate accepts zero/false observations as valid results.
  assert.strictEqual(isLightTopGotoTimeoutError_({ name: 'TimeoutError', message: 'page.goto: Timeout 25000ms exceeded' }), true);
  assert.strictEqual(isLightTopGotoTimeoutError_({ name: 'Error', message: 'navigation failed' }), false);
  assert.strictEqual(assessLightDomFallbackSentinel_(domCandidate({
    bodyTextLength: 0, h1Count: 0, headingCount: 0, linkCount: 0,
    hasHeaderElement: false, hasNavElement: false, hasFooterElement: false, imgCount: 0
  }), 'https://sitakke.jp/').accepted, true);
  let probeClock = 0;
  const probeOptions = { maxMs: 20, pollMs: 2, now: () => probeClock, wait: async ms => { probeClock += ms; } };
  const delayedDom = await probeLightDomReadiness_(probePage([
    new Error('Execution context was destroyed, most likely because of a navigation'),
    domCandidate(),
    domCandidate()
  ]), 'https://sitakke.jp/', budgetFor(48000), probeOptions);
  assert.strictEqual(delayedDom.accepted, true);
  assert.strictEqual(delayedDom.reason, 'sentinel_ready');
  probeClock = 0;
  const immediateDom = await probeLightDomReadiness_(probePage([domCandidate(), domCandidate()]), 'https://sitakke.jp/', budgetFor(48000), probeOptions);
  assert.strictEqual(immediateDom.accepted, true);

  // D-G/I-K: the bounded probe refuses unavailable, unsafe, malformed, and
  // budget-exhausted documents without making a fresh-browser retry eligible.
  probeClock = 0;
  const unavailableDom = await probeLightDomReadiness_(probePage([new Error('Execution context was destroyed')]), 'https://sitakke.jp/', budgetFor(48000), probeOptions);
  assert.strictEqual(unavailableDom.accepted, false);
  assert.strictEqual(unavailableDom.reason, 'navigation_in_progress');
  for (const candidate of [
    domCandidate({ url: 'about:blank' }),
    domCandidate({ url: 'https://example.com/' }),
    domCandidate({ hasBody: false }),
    domCandidate({ challengeOrError: true })
  ]) {
    probeClock = 0;
    const rejected = await probeLightDomReadiness_(probePage([candidate]), 'https://sitakke.jp/', budgetFor(48000), probeOptions);
    assert.strictEqual(rejected.accepted, false);
  }
  probeClock = 0;
  const closedDom = await probeLightDomReadiness_(probePage([], { closed: true }), 'https://sitakke.jp/', budgetFor(48000), probeOptions);
  assert.strictEqual(closedDom.reason, 'page_closed');
  const disconnectedDom = await probeLightDomReadiness_(probePage([domCandidate()]), 'https://sitakke.jp/', budgetFor(48000), Object.assign({}, probeOptions, {
    attempt: { browser: { isConnected: () => false } }
  }));
  assert.strictEqual(disconnectedDom.reason, 'browser_disconnected');
  const shortFallbackBudget = budgetFor(48000);
  shortFallbackBudget.deadlineAt = Date.now() + 100;
  assert.strictEqual(getLightDomFallbackTimeoutMs_(shortFallbackBudget), 0);
  const noBudgetDom = await probeLightDomReadiness_(probePage([]), 'https://sitakke.jp/', shortFallbackBudget, { now: Date.now, wait: async () => {} });
  assert.strictEqual(noBudgetDom.reason, 'insufficient_remaining');
  const deadlineProbeBudget = budgetFor(48000);
  deadlineProbeBudget.activeStage = 'top_page_dom_fallback';
  deadlineProbeBudget.timedOut = true;
  const deadlineDom = await probeLightDomReadiness_(probePage([]), 'https://sitakke.jp/', deadlineProbeBudget, probeOptions);
  assert.strictEqual(deadlineDom.reason, 'overall_deadline');
  assert.strictEqual(deadlineProbeBudget.activeStage, 'top_page_dom_fallback');
  const evaluateTimeoutDom = await probeLightDomReadiness_({
    isClosed: () => false,
    evaluate: () => new Promise(() => {})
  }, 'https://sitakke.jp/', budgetFor(48000), { maxMs: 5, pollMs: 1 });
  assert.strictEqual(evaluateTimeoutDom.reason, 'probe_evaluate_timeout');

  // A-D/F-G/I: a timed-out goto may wait on the same live Page once, then
  // reuse the production probe. This is not a fresh-browser retry.
  const recoveryAttempt = { browser: { isConnected: () => true } };
  const recoveredPage = {
    isClosed: () => false,
    url: () => 'https://www.irischitose.co.jp/',
    waitForLoadState: async (state) => { assert.strictEqual(state, 'domcontentloaded'); }
  };
  const recoveryBudget = budgetFor(150000);
  const recovered = await recoverLightTopPageNavigation_(recoveredPage, recoveryBudget, recoveryAttempt);
  assert.deepStrictEqual({ attempted: recovered.attempted, accepted: recovered.accepted, timedOut: recovered.timedOut, reason: recovered.reason }, {
    attempted: true, accepted: true, timedOut: false, reason: 'domcontentloaded'
  });
  const recoveredDom = await probeLightDomReadiness_(probePage([domCandidate(), domCandidate()]), 'https://sitakke.jp/', recoveryBudget, probeOptions);
  assert.strictEqual(recoveredDom.accepted, true);
  const noSecondRecovery = await recoverLightTopPageNavigation_(recoveredPage, recoveryBudget, recoveryAttempt);
  assert.strictEqual(noSecondRecovery.reason, 'already_attempted');

  const recoveryTimeoutBudget = budgetFor(150000);
  recoveryTimeoutBudget.deadlineAt = Date.now() + 41025; // 25ms after the 41s recovery reserve
  assert(getLightNavigationRecoveryTimeoutMs_(recoveryTimeoutBudget) > 0);
  const timedOutRecovery = await recoverLightTopPageNavigation_({
    isClosed: () => false,
    url: () => 'https://www.irischitose.co.jp/',
    waitForLoadState: () => new Promise(() => {})
  }, recoveryTimeoutBudget, recoveryAttempt);
  assert.strictEqual(timedOutRecovery.attempted, true);
  assert.strictEqual(timedOutRecovery.timedOut, true);
  const timedOutThenReady = await probeLightDomReadiness_(probePage([domCandidate(), domCandidate()]), 'https://sitakke.jp/', recoveryTimeoutBudget, probeOptions);
  assert.strictEqual(timedOutThenReady.accepted, true);
  const timedOutThenUnavailable = await probeLightDomReadiness_({
    isClosed: () => false,
    evaluate: () => new Promise(() => {})
  }, 'https://sitakke.jp/', recoveryTimeoutBudget, { maxMs: 5, pollMs: 1 });
  assert.strictEqual(timedOutThenUnavailable.reason, 'probe_evaluate_timeout');

  const disconnectedRecovery = await recoverLightTopPageNavigation_(recoveredPage, budgetFor(150000), { browser: { isConnected: () => false } });
  assert.strictEqual(disconnectedRecovery.attempted, false);
  assert.strictEqual(disconnectedRecovery.reason, 'browser_disconnected');
  const closedRecovery = await recoverLightTopPageNavigation_({ isClosed: () => true }, budgetFor(150000), recoveryAttempt);
  assert.strictEqual(closedRecovery.attempted, false);
  assert.strictEqual(closedRecovery.reason, 'page_closed');
  const insufficientRecoveryBudget = budgetFor(150000);
  insufficientRecoveryBudget.deadlineAt = Date.now() + 41000;
  const insufficientRecovery = await recoverLightTopPageNavigation_(recoveredPage, insufficientRecoveryBudget, recoveryAttempt);
  assert.strictEqual(insufficientRecovery.attempted, false);
  assert.strictEqual(insufficientRecovery.reason, 'insufficient_remaining');
  const aboutBlankRecovery = await recoverLightTopPageNavigation_({
    isClosed: () => false,
    url: () => 'about:blank',
    waitForLoadState: async () => {}
  }, budgetFor(150000), recoveryAttempt);
  assert.strictEqual(aboutBlankRecovery.attempted, true);
  assert.strictEqual((await probeLightDomReadiness_(probePage([domCandidate(), domCandidate()]), 'https://sitakke.jp/', budgetFor(150000), probeOptions)).accepted, true);
  const temporaryCrossOriginRecovery = await recoverLightTopPageNavigation_({
    isClosed: () => false,
    url: () => 'https://unexpected.example/',
    waitForLoadState: async () => {}
  }, budgetFor(150000), recoveryAttempt);
  assert.strictEqual(temporaryCrossOriginRecovery.attempted, true);
  const finalCrossOrigin = await probeLightDomReadiness_(probePage([
    domCandidate({ url: 'https://unexpected.example/' })
  ]), 'https://sitakke.jp/', budgetFor(150000), probeOptions);
  assert.strictEqual(finalCrossOrigin.accepted, false);
  assert.strictEqual(finalCrossOrigin.reason, 'origin_mismatch');
  const browserErrorRecovery = await recoverLightTopPageNavigation_({
    isClosed: () => false,
    url: () => 'chrome-error://chromewebdata/',
    waitForLoadState: async () => { throw new Error('must not wait'); }
  }, budgetFor(150000), recoveryAttempt);
  assert.strictEqual(browserErrorRecovery.attempted, false);
  assert.strictEqual(browserErrorRecovery.reason, 'browser_error_document');

  // Completion-first hydration is bounded as a whole (including evaluate),
  // yet a usable DOM lets the light path continue after the helper times out.
  let hydrationEvaluateCount = 0;
  const hydrationPage = {
    isClosed: () => false,
    evaluate: async () => {
      hydrationEvaluateCount += 1;
      if (hydrationEvaluateCount === 1) return new Promise(() => {});
      return domCandidate();
    }
  };
  const hydrationBudget = budgetFor(15000);
  const hydration = await collectLightHydrationMetricsWithinBudget_(
    hydrationPage,
    'https://sitakke.jp/',
    hydrationBudget,
    { waitMs: 20, maxMs: 20, pollMs: 1 }
  );
  assert.strictEqual(hydration.state, 'timed_out');
  assert.strictEqual(hydration.domReady, true);

  // CP1-CP4: the compact checkpoints preserve ordering and isolate each gap.
  const checkpointBudget = budgetFor(200);
  checkpointBudget.activeStage = 'page_create';
  recordLightCheckpoint_(checkpointBudget, 'page_create_complete');
  await sleep(8); // fixture: defaults configuration delay
  checkpointBudget.activeStage = 'page_defaults_configured';
  recordLightCheckpoint_(checkpointBudget, 'page_defaults_configured');
  await sleep(8); // fixture: init-script delay
  checkpointBudget.activeStage = 'init_script';
  recordLightCheckpoint_(checkpointBudget, 'init_script_complete');
  await sleep(8); // fixture: post-init delay
  checkpointBudget.activeStage = 'top_page_goto';
  recordLightCheckpoint_(checkpointBudget, 'before_top_page_goto_budget_check');
  const checkpoints = checkpointBudget.checkpoints;
  assert.deepStrictEqual(Object.keys(checkpoints), [
    'page_create_complete',
    'page_defaults_configured',
    'init_script_complete',
    'before_top_page_goto_budget_check'
  ]);
  assert(checkpoints.page_defaults_configured.elapsedMs > checkpoints.page_create_complete.elapsedMs);
  assert(checkpoints.init_script_complete.elapsedMs > checkpoints.page_defaults_configured.elapsedMs);
  assert(checkpoints.before_top_page_goto_budget_check.elapsedMs > checkpoints.init_script_complete.elapsedMs);

  // Post-goto checkpoints use the same request-scoped trace and preserve stage order.
  const postGotoBudget = budgetFor(200);
  markLightStageCheckpoint_(postGotoBudget, 'top_page_goto', 'top_page_goto_start');
  await sleep(2);
  recordLightCheckpoint_(postGotoBudget, 'top_page_goto_end');
  postGotoBudget.activeStage = 'hydration';
  await sleep(2);
  recordLightCheckpoint_(postGotoBudget, 'hydration_end');
  markLightStageCheckpoint_(postGotoBudget, 'build_geo_signals', 'build_geo_signals_start');
  await sleep(2);
  recordLightCheckpoint_(postGotoBudget, 'build_geo_signals_end');
  markLightStageCheckpoint_(postGotoBudget, 'coverage', 'coverage_start');
  postGotoBudget.coverageTrace.started = true;
  await sleep(2);
  postGotoBudget.coverageTrace.completed = true;
  recordLightCheckpoint_(postGotoBudget, 'coverage_end');
  assert.deepStrictEqual(Object.keys(postGotoBudget.checkpoints), [
    'top_page_goto_start',
    'top_page_goto_end',
    'hydration_end',
    'build_geo_signals_start',
    'build_geo_signals_end',
    'coverage_start',
    'coverage_end'
  ]);
  assert.strictEqual(postGotoBudget.activeStage, 'coverage');
  assert.strictEqual(postGotoBudget.coverageTrace.completed, true);

  // B-E: each setup stage is bounded and reports the actual stage.
  await expectStageTimeout('browser_launch', () => sleep(60));
  await expectStageTimeout('browser_context', () => sleep(60));
  await expectStageTimeout('page_create', () => sleep(60));
  await expectStageTimeout('init_script', () => sleep(60));

  // The setup-stage failure contract is the same explicit 504 returned by /scrape.
  const launchResponse = responseSpy();
  const launchBudget = budgetFor(30);
  launchBudget.activeStage = 'browser_launch';
  sendLightBudgetTimeout_(launchResponse, launchBudget, Date.now(), 'browser_launch');
  assert.strictEqual(launchResponse.statusCode, 504);
  assert.strictEqual(launchResponse.body.stage, 'browser_launch');
  assert.strictEqual(launchResponse.body.diagnostics.browserLaunchMs, 0);

  // D-E: an error response retains reached checkpoints under the same request ID.
  const traceResponse = responseSpy();
  sendLightBudgetTimeout_(traceResponse, checkpointBudget, Date.now(), 'top_page_goto');
  const trace = traceResponse.body.diagnostics.lightStageGapsV1;
  assert.strictEqual(trace.requestId, checkpointBudget.requestId);
  assert.strictEqual(trace.checkpoints.before_top_page_goto_budget_check.activeStage, 'top_page_goto');
  assert(traceResponse.body.diagnostics.skippedDueToBudget.includes('top_page_goto'));

  const gotoDeadlineResponse = responseSpy();
  const gotoDeadlineBudget = budgetFor(200);
  markLightStageCheckpoint_(gotoDeadlineBudget, 'top_page_goto', 'top_page_goto_start');
  sendLightBudgetTimeout_(gotoDeadlineResponse, gotoDeadlineBudget, Date.now(), gotoDeadlineBudget.activeStage);
  assert.strictEqual(gotoDeadlineResponse.body.stage, 'top_page_goto');
  assert(gotoDeadlineResponse.body.diagnostics.lightStageGapsV1.checkpoints.top_page_goto_start);
  assert.strictEqual(gotoDeadlineResponse.body.diagnostics.lightStageGapsV1.checkpoints.top_page_goto_end, undefined);

  // Post-goto deadline diagnostics retain only reached checkpoints, current stage,
  // existing geo phase timings, and coverage start/skip state.
  const buildDeadlineResponse = responseSpy();
  const buildDeadlineBudget = budgetFor(200);
  markLightStageCheckpoint_(buildDeadlineBudget, 'build_geo_signals', 'build_geo_signals_start');
  buildDeadlineBudget.geoPhaseTimings = {
    gotoMs: 12000,
    basicDomMs: 31,
    structuredDataMs: null,
    linksMs: 4,
    multimodalMs: 3,
    totalMs: null
  };
  sendLightBudgetTimeout_(buildDeadlineResponse, buildDeadlineBudget, Date.now(), buildDeadlineBudget.activeStage);
  assert.strictEqual(buildDeadlineResponse.body.stage, 'build_geo_signals');
  assert(buildDeadlineResponse.body.diagnostics.lightStageGapsV1.checkpoints.build_geo_signals_start);
  assert.strictEqual(buildDeadlineResponse.body.diagnostics.lightStageGapsV1.checkpoints.build_geo_signals_end, undefined);
  assert.strictEqual(buildDeadlineResponse.body.diagnostics.geoPhaseTimings.basicDomMs, 31);

  const coverageSkipResponse = responseSpy();
  const coverageSkipBudget = budgetFor(200);
  markLightStageCheckpoint_(coverageSkipBudget, 'coverage', 'coverage_start');
  coverageSkipBudget.coverageTrace.started = true;
  coverageSkipBudget.coverageTrace.skippedDueToBudget = true;
  sendLightBudgetTimeout_(coverageSkipResponse, coverageSkipBudget, Date.now(), coverageSkipBudget.activeStage);
  assert.strictEqual(coverageSkipResponse.body.stage, 'coverage');
  assert(coverageSkipResponse.body.diagnostics.lightStageGapsV1.checkpoints.coverage_start);
  assert.strictEqual(coverageSkipResponse.body.diagnostics.lightStageGapsV1.checkpoints.coverage_end, undefined);
  assert.deepStrictEqual(coverageSkipResponse.body.diagnostics.coverageTrace, {
    started: true,
    skippedDueToBudget: true,
    completed: false,
    observationLimited: false,
    budgetLimitedCandidateCount: 0
  });

  // F: an expired queued task returns 504 before the task body can run.
  let queuedTask = null;
  let scrapeStarted = false;
  const fakeQueue = { add(task) { queuedTask = task; return new Promise(() => {}); } };
  const queueBudget = budgetFor(30);
  const queueResponse = responseSpy();
  enqueueLightScrapeWithDeadline_(fakeQueue, {}, queueResponse, queueBudget, async () => { scrapeStarted = true; });
  await sleep(45);
  assert.strictEqual(queueResponse.statusCode, 504);
  assert.strictEqual(queueResponse.body.stage, 'queue_wait');
  await queuedTask();
  assert.strictEqual(scrapeStarted, false);

  // G: a late Playwright resource is closed even though its setup promise resolved after timeout.
  let closed = 0;
  const cleanupBudget = budgetFor(30);
  await assert.rejects(() => runLightBudgetStage_(cleanupBudget, 'browser_launch', 60000,
    () => sleep(60).then(() => ({ close: async () => { closed += 1; } })),
    { onLateResolve: async (browser) => browser.close() }
  ));
  await sleep(45);
  assert.strictEqual(closed, 1);

  // Setup-only retry: a fresh second attempt follows a completed cleanup.
  const retryBudget = budgetFor(150000);
  const retryResponse = responseSpy();
  let attempts = 0;
  let firstClosed = 0;
  let firstAttemptId = '';
  let secondAttemptId = '';
  await runLightScrapeWithSetupRetry_(null, retryResponse, retryBudget, async () => {
    attempts += 1;
    const attempt = createLightAttempt_(retryBudget);
    if (attempts === 1) {
      firstAttemptId = attempt.id;
      attempt.page = { close: async () => { firstClosed += 1; } };
      const error = new Error('page create transient failure');
      error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
      error.lightBudgetStage = 'page_create';
      error.lightAttempt = attempt;
      throw error;
    }
    secondAttemptId = attempt.id;
    retryResponse.status(200).json({ ok: true, freshAttempt: attempt.id });
  });
  assert.strictEqual(attempts, 2);
  assert.strictEqual(firstClosed, 1);
  assert.notStrictEqual(firstAttemptId, secondAttemptId);
  assert.strictEqual(retryResponse.statusCode, 200);
  assert.strictEqual(retryBudget.resilience.retryPerformed, true);
  assert.strictEqual(retryBudget.resilience.firstFailureStage, 'page_create');

  // A cleanup barrier failure, a late failure, insufficient budget, and a
  // post-goto failure are not admitted to retry.
  const successfulCleanupBudget = budgetFor(150000);
  const successfulCleanupAttempt = createLightAttempt_(successfulCleanupBudget);
  successfulCleanupAttempt.page = { close: async () => {} };
  successfulCleanupAttempt.context = { close: async () => {} };
  successfulCleanupAttempt.browser = { close: async () => {} };
  const successfulCleanup = await cleanupLightAttempt_(successfulCleanupAttempt, 'fixture');
  assert.strictEqual(successfulCleanup.completed, true);
  assert.strictEqual(successfulCleanupAttempt.cleanupComplete, true);
  assert.strictEqual(lightSetupRetryAdmission_(successfulCleanupBudget, successfulCleanupAttempt, 'page_create').allowed, true);

  // Any individual close exception blocks retry; a resource must never be
  // treated as cleaned merely because its close error was absorbed.
  for (const resourceName of ['page', 'context', 'browser']) {
    const budget = budgetFor(150000);
    const attempt = createLightAttempt_(budget);
    attempt[resourceName] = { close: async () => { throw new Error(`${resourceName}_close_failed`); } };
    const cleanup = await cleanupLightAttempt_(attempt, 'fixture');
    assert.strictEqual(cleanup.completed, false, resourceName);
    assert.strictEqual(attempt.cleanupComplete, false, resourceName);
    assert.strictEqual(lightSetupRetryAdmission_(budget, attempt, 'page_create').reason, 'cleanup_incomplete', resourceName);
  }

  // Per-resource timeout and the aggregate cleanup-barrier timeout both block retry.
  const closeTimeoutBudget = budgetFor(150000);
  const closeTimeoutAttempt = createLightAttempt_(closeTimeoutBudget);
  closeTimeoutAttempt.page = { close: () => sleep(40) };
  await cleanupLightAttempt_(closeTimeoutAttempt, 'fixture', { timeoutMs: 40, resourceTimeoutMs: 5 });
  assert.strictEqual(closeTimeoutAttempt.cleanupComplete, false);
  assert.strictEqual(lightSetupRetryAdmission_(closeTimeoutBudget, closeTimeoutAttempt, 'page_create').reason, 'cleanup_incomplete');

  const barrierTimeoutBudget = budgetFor(150000);
  const barrierTimeoutAttempt = createLightAttempt_(barrierTimeoutBudget);
  barrierTimeoutAttempt.page = { close: () => sleep(40) };
  await cleanupLightAttempt_(barrierTimeoutAttempt, 'fixture', { timeoutMs: 5, resourceTimeoutMs: 40 });
  assert.strictEqual(barrierTimeoutAttempt.cancelled, true);
  assert.strictEqual(barrierTimeoutAttempt.controller.signal.aborted, true);
  assert.strictEqual(barrierTimeoutAttempt.cleanupComplete, false);
  assert.strictEqual(lightSetupRetryAdmission_(barrierTimeoutBudget, barrierTimeoutAttempt, 'page_create').reason, 'cleanup_incomplete');

  // The production retry runner observes cleanupComplete and does not begin a
  // second attempt when the first attempt's resource close fails.
  const cleanupFailureResponse = responseSpy();
  const cleanupFailureBudget = budgetFor(150000);
  let cleanupFailureAttempts = 0;
  await runLightScrapeWithSetupRetry_(null, cleanupFailureResponse, cleanupFailureBudget, async () => {
    cleanupFailureAttempts += 1;
    const attempt = createLightAttempt_(cleanupFailureBudget);
    attempt.page = { close: async () => { throw new Error('close_failed'); } };
    const error = new Error('page create transient failure');
    error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
    error.lightBudgetStage = 'page_create';
    error.lightAttempt = attempt;
    throw error;
  });
  assert.strictEqual(cleanupFailureAttempts, 1);
  assert.strictEqual(cleanupFailureResponse.statusCode, 504);
  assert.strictEqual(cleanupFailureBudget.resilience.retryPerformed, false);
  assert.strictEqual(cleanupFailureBudget.resilience.retryAdmission, 'cleanup_incomplete');

  const lateBudget = budgetFor(150000);
  lateBudget.startedAt = Date.now() - 18001;
  lateBudget.deadlineAt = lateBudget.startedAt + 150000;
  const lateAttempt = createLightAttempt_(lateBudget);
  lateAttempt.cleanupComplete = true;
  assert.strictEqual(lightSetupRetryAdmission_(lateBudget, lateAttempt, 'page_create').allowed, true);

  const shortBudget = budgetFor(74000);
  const shortAttempt = createLightAttempt_(shortBudget);
  shortAttempt.cleanupComplete = true;
  assert.strictEqual(lightSetupRetryAdmission_(shortBudget, shortAttempt, 'page_create').reason, 'insufficient_remaining');
  assert.strictEqual(lightSetupRetryAdmission_(retryBudget, { cleanupComplete: true }, 'build_geo_signals').reason, 'non_setup_stage');

  const secondFailureBudget = budgetFor(150000);
  const secondFailureResponse = responseSpy();
  let failures = 0;
  await runLightScrapeWithSetupRetry_(null, secondFailureResponse, secondFailureBudget, async () => {
    failures += 1;
    const attempt = createLightAttempt_(secondFailureBudget);
    const error = new Error('transient setup failure');
    error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
    error.lightBudgetStage = 'page_create';
    error.lightAttempt = attempt;
    throw error;
  });
  assert.strictEqual(failures, 2);
  assert.strictEqual(secondFailureResponse.statusCode, 504);
  assert.strictEqual(secondFailureBudget.resilience.secondAttemptStage, 'page_create');

  // Navigation-probe retry is narrower than setup retry: only a timed-out
  // goto whose same-page recovery reached DCL and whose probe evaluate hung.
  const navigationRetryBudget = budgetFor(70000);
  navigationRetryBudget.gotoFallback.gotoTimedOut = true;
  navigationRetryBudget.navigationRecovery = { attempted: true, accepted: true, waitMs: 6, timedOut: false, reason: 'domcontentloaded' };
  const navigationRetryResponse = responseSpy();
  let navigationAttempts = 0;
  let firstNavigationAttemptId = '';
  let secondNavigationAttemptId = '';
  let firstNavigationResponseSent = null;
  await runLightScrapeWithSetupRetry_(null, navigationRetryResponse, navigationRetryBudget, async () => {
    navigationAttempts += 1;
    const attempt = createLightAttempt_(navigationRetryBudget);
    if (navigationAttempts === 1) {
      firstNavigationAttemptId = attempt.id;
      attempt.page = { close: async () => {} };
      firstNavigationResponseSent = navigationRetryResponse.headersSent;
      const error = new Error('probe evaluate timed out');
      error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
      error.lightBudgetStage = 'top_page_dom_fallback';
      error.lightFailureReason = 'probe_evaluate_timeout';
      error.lightAttempt = attempt;
      throw error;
    }
    secondNavigationAttemptId = attempt.id;
    navigationRetryResponse.status(200).json({ ok: true, freshAttempt: attempt.id });
  });
  assert.strictEqual(navigationAttempts, 2);
  assert.strictEqual(firstNavigationResponseSent, false);
  assert.notStrictEqual(firstNavigationAttemptId, secondNavigationAttemptId);
  assert.strictEqual(navigationRetryResponse.statusCode, 200);
  assert.strictEqual(navigationRetryBudget.resilience.retryPerformed, true);
  assert.strictEqual(navigationRetryBudget.resilience.retryKind, 'navigation_probe');
  assert.strictEqual(navigationRetryBudget.resilience.firstFailureStage, 'top_page_dom_fallback');
  assert.strictEqual(navigationRetryBudget.resilience.firstFailureReason, 'probe_evaluate_timeout');
  assert.strictEqual(navigationRetryBudget.resilience.retryAdmission, 'navigation_probe_retry_admitted');

  const navigationAdmissionAttempt = createLightAttempt_(budgetFor(70000));
  navigationAdmissionAttempt.cleanupComplete = true;
  const navigationAdmissionBudget = budgetFor(70000);
  navigationAdmissionBudget.gotoFallback.gotoTimedOut = true;
  navigationAdmissionBudget.navigationRecovery = { attempted: true, accepted: true };
  assert.strictEqual(isLightNavigationProbeRetryableFailure_(navigationAdmissionBudget, 'top_page_dom_fallback', 'probe_evaluate_timeout'), true);
  assert.strictEqual(lightNavigationProbeRetryAdmission_(navigationAdmissionBudget, navigationAdmissionAttempt, 'top_page_dom_fallback', 'probe_evaluate_timeout').allowed, true);
  for (const reason of ['origin_mismatch', 'challenge_or_error_page', 'browser_error_document', 'sentinel_number_missing']) {
    assert.strictEqual(isLightNavigationProbeRetryableFailure_(navigationAdmissionBudget, 'top_page_dom_fallback', reason), false, reason);
  }
  const shortNavigationBudget = budgetFor(59000);
  shortNavigationBudget.gotoFallback.gotoTimedOut = true;
  shortNavigationBudget.navigationRecovery = { attempted: true, accepted: true };
  const shortNavigationAttempt = createLightAttempt_(shortNavigationBudget);
  shortNavigationAttempt.cleanupComplete = true;
  assert.strictEqual(lightNavigationProbeRetryAdmission_(shortNavigationBudget, shortNavigationAttempt, 'top_page_dom_fallback', 'probe_evaluate_timeout').reason, 'insufficient_remaining');

  const navigationCleanupFailureResponse = responseSpy();
  const navigationCleanupFailureBudget = budgetFor(70000);
  navigationCleanupFailureBudget.gotoFallback.gotoTimedOut = true;
  navigationCleanupFailureBudget.navigationRecovery = { attempted: true, accepted: true };
  let navigationCleanupFailureAttempts = 0;
  await runLightScrapeWithSetupRetry_(null, navigationCleanupFailureResponse, navigationCleanupFailureBudget, async () => {
    navigationCleanupFailureAttempts += 1;
    const attempt = createLightAttempt_(navigationCleanupFailureBudget);
    attempt.page = { close: async () => { throw new Error('close_failed'); } };
    const error = new Error('probe evaluate timed out');
    error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
    error.lightBudgetStage = 'top_page_dom_fallback';
    error.lightFailureReason = 'probe_evaluate_timeout';
    error.lightAttempt = attempt;
    throw error;
  });
  assert.strictEqual(navigationCleanupFailureAttempts, 1);
  assert.strictEqual(navigationCleanupFailureResponse.statusCode, 504);
  assert.strictEqual(navigationCleanupFailureBudget.resilience.retryPerformed, false);
  assert.strictEqual(navigationCleanupFailureBudget.resilience.retryAdmission, 'cleanup_incomplete');

  const navigationSecondFailureBudget = budgetFor(70000);
  navigationSecondFailureBudget.gotoFallback.gotoTimedOut = true;
  navigationSecondFailureBudget.navigationRecovery = { attempted: true, accepted: true };
  const navigationSecondFailureResponse = responseSpy();
  let navigationFailures = 0;
  await runLightScrapeWithSetupRetry_(null, navigationSecondFailureResponse, navigationSecondFailureBudget, async () => {
    navigationFailures += 1;
    const attempt = createLightAttempt_(navigationSecondFailureBudget);
    const error = new Error('probe evaluate timed out');
    error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
    error.lightBudgetStage = 'top_page_dom_fallback';
    error.lightFailureReason = 'probe_evaluate_timeout';
    error.lightAttempt = attempt;
    throw error;
  });
  assert.strictEqual(navigationFailures, 2);
  assert.strictEqual(navigationSecondFailureResponse.statusCode, 504);
  assert.strictEqual(navigationSecondFailureBudget.resilience.secondAttemptStage, 'top_page_dom_fallback');

  console.log('light-request-deadline fixtures: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
