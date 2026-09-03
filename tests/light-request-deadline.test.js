const assert = require('assert');
const lightBudgetHooks = require('../index.js').__lightBudgetTestHooks;
const {
  collectArticleSignalsFromPageLight_,
  inferEcGeneralLinkPageType_,
  addEcGeneralLinkCandidatesFromLinks_,
  collectSameOriginScriptSrcJsonLdSummaryLight,
  buildLightCoverageObservationPlan_,
  parseSubpageJsonLdLightHtml,
  compactSubpageJsonLdObservation_,
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
  lightSetupRetryAdmission_,
  recordLightCheckpoint_,
  markLightStageCheckpoint_,
  getLightBudgetRemainingMs_,
  attachLightMainFrameNavigationTrace_,
  markLightMainFrameGotoTrace_,
  buildLightStaticFetchTrace_,
  buildLightRequestTiming_,
  runLightBudgetStage_,
  runLightSupplementalBudgetTask_,
  collectLightHydrationMetricsWithinBudget_,
  getLightSupplementalDiagnosticFlags_,
  collectLightPostCoverageSupplementals_,
  sendLightBudgetTimeout_,
  enqueueLightScrapeWithDeadline_,
  runLightScrapeWithSetupRetry_
} = lightBudgetHooks;

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

function navigationTracePage() {
  const handlers = {};
  const mainFrame = { url: () => 'https://example.test/' };
  return {
    on(name, handler) { handlers[name] = handler; },
    mainFrame: () => mainFrame,
    url: () => 'https://example.test/',
    isClosed: () => false,
    emit(name, value) { if (handlers[name]) handlers[name](value); },
    frame: mainFrame
  };
}

function mainDocumentRequest(page, options = {}) {
  return {
    resourceType: () => options.resourceType || 'document',
    isNavigationRequest: () => options.navigation !== false,
    frame: () => options.frame || page.frame,
    url: () => options.url || 'https://example.test/',
    method: () => options.method || 'GET',
    failure: () => ({ errorText: options.errorText || 'net::ERR_CONNECTION_TIMED_OUT' })
  };
}

(async () => {
  // Main-frame trace records only document/navigation lifecycle events and
  // never participates in navigation control flow.
  const navigationTraceBudget = budgetFor(150000);
  const navigationPage = navigationTracePage();
  const navigationTrace = attachLightMainFrameNavigationTrace_(navigationPage, navigationTraceBudget);
  const tracedRequest = mainDocumentRequest(navigationPage);
  navigationPage.emit('request', tracedRequest);
  navigationPage.emit('response', {
    request: () => tracedRequest,
    url: () => 'https://example.test/',
    status: () => 200
  });
  navigationPage.emit('framenavigated', navigationPage.frame);
  navigationPage.emit('domcontentloaded');
  navigationPage.emit('load');
  markLightMainFrameGotoTrace_(navigationTraceBudget, navigationPage, { gotoStartMs: 0, gotoOutcome: 'success', gotoMs: 12, gotoResponsePresent: true });
  assert.strictEqual(navigationTrace.requests.length, 1);
  assert.strictEqual(navigationTrace.responses[0].status, 200);
  assert.strictEqual(navigationTrace.frameNavigations.length, 1);
  assert.notStrictEqual(navigationTrace.domContentLoadedMs, null);
  assert.notStrictEqual(navigationTrace.loadMs, null);
  assert.strictEqual(navigationTrace.traceError, false);

  // A failed document request is distinguishable from a request that simply
  // has not produced a response or DCL by the time goto times out.
  const failedTraceBudget = budgetFor(150000);
  const failedTracePage = navigationTracePage();
  const failedTrace = attachLightMainFrameNavigationTrace_(failedTracePage, failedTraceBudget);
  const failedRequest = mainDocumentRequest(failedTracePage, { errorText: 'net::ERR_CONNECTION_TIMED_OUT' });
  failedTracePage.emit('request', failedRequest);
  failedTracePage.emit('requestfailed', failedRequest);
  markLightMainFrameGotoTrace_(failedTraceBudget, failedTracePage, { gotoStartMs: 0, gotoOutcome: 'timeout', gotoMs: 60000, gotoResponsePresent: false });
  assert.strictEqual(failedTrace.failures[0].errorText, 'net::ERR_CONNECTION_TIMED_OUT');
  assert.strictEqual(failedTrace.responsePresent, false);
  assert.strictEqual(failedTrace.domContentLoadedMs, null);

  const responseWithoutDclBudget = budgetFor(150000);
  const responseWithoutDclPage = navigationTracePage();
  const responseWithoutDclTrace = attachLightMainFrameNavigationTrace_(responseWithoutDclPage, responseWithoutDclBudget);
  const responseWithoutDclRequest = mainDocumentRequest(responseWithoutDclPage);
  responseWithoutDclPage.emit('request', responseWithoutDclRequest);
  responseWithoutDclPage.emit('response', {
    request: () => responseWithoutDclRequest,
    url: () => 'https://example.test/',
    status: () => 200
  });
  assert.strictEqual(responseWithoutDclTrace.responsePresent, true);
  assert.strictEqual(responseWithoutDclTrace.domContentLoadedMs, null);

  const noRequestTraceBudget = budgetFor(150000);
  const noRequestTracePage = navigationTracePage();
  const noRequestTrace = attachLightMainFrameNavigationTrace_(noRequestTracePage, noRequestTraceBudget);
  markLightMainFrameGotoTrace_(noRequestTraceBudget, noRequestTracePage, { gotoStartMs: 0, gotoOutcome: 'timeout', gotoMs: 60000, gotoResponsePresent: false });
  assert.strictEqual(noRequestTrace.requests.length, 0);
  assert.strictEqual(noRequestTrace.responses.length, 0);
  assert.strictEqual(noRequestTrace.domContentLoadedMs, null);

  // Subframe and non-document resources are excluded from the trace.
  const ignoredTraceBudget = budgetFor(150000);
  const ignoredTracePage = navigationTracePage();
  const ignoredTrace = attachLightMainFrameNavigationTrace_(ignoredTracePage, ignoredTraceBudget);
  ignoredTracePage.emit('request', mainDocumentRequest(ignoredTracePage, { resourceType: 'image' }));
  ignoredTracePage.emit('request', mainDocumentRequest(ignoredTracePage, { frame: { url: () => 'https://example.test/frame' } }));
  assert.strictEqual(ignoredTrace.requests.length, 0);

  // Listener setup failure remains trace-only and cannot stop scraping.
  const brokenTraceBudget = budgetFor(150000);
  const brokenTrace = attachLightMainFrameNavigationTrace_({ on: () => { throw new Error('listener unavailable'); } }, brokenTraceBudget);
  assert.strictEqual(brokenTrace.traceError, true);

  const staticTrace = buildLightStaticFetchTrace_({ success: true, status: 200, elapsedMs: 1900, bodyBytes: 80701, redirectCount: 0, redirectCountKnown: true, finalUrl: 'https://example.test/' }, 'https://example.test/');
  assert.deepStrictEqual(staticTrace, { success: true, status: 200, elapsedMs: 1900, bodyBytes: 80701, redirectCount: 0, finalOriginMatches: true });
  navigationTraceBudget.topPageStaticFetchTraceV1 = Object.assign({ requestId: navigationTraceBudget.requestId }, staticTrace);
  const tracedTiming = buildLightRequestTiming_(navigationTraceBudget, navigationTraceBudget.startedAt);
  assert.strictEqual(tracedTiming.mainFrameNavigationTraceV1.requestId, navigationTraceBudget.requestId);
  assert.strictEqual(tracedTiming.topPageStaticFetchTraceV1.requestId, navigationTraceBudget.requestId);

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

  const ecLinks = [
    { href: 'https://shop.example.test/products/', text: '商品一覧' },
    { href: 'https://shop.example.test/category/tea/', text: '商品カテゴリ' },
    { href: 'https://shop.example.test/user_data/guide', text: 'ご利用ガイド' },
    { href: 'https://shop.example.test/help/about', text: '会社概要' },
    { href: 'https://shop.example.test/contact', text: 'お問い合わせ' },
    { href: 'https://shop.example.test/help/tradelaw', text: '特定商取引法に基づく表記' }
  ].concat(Array.from({ length: 50 }, (_, index) => ({ href: `https://shop.example.test/campaign/${index}`, text: `キャンペーン ${index}` })));
  const ecCandidateMap = new Map();
  const ecAdded = addEcGeneralLinkCandidatesFromLinks_(ecLinks, 'https://shop.example.test', ecCandidateMap, {}, 'ec');
  assert.strictEqual(ecAdded.length, 6);
  assert.deepStrictEqual(Array.from(ecCandidateMap.values()).map(item => item.pageType), ['product', 'category', 'faq', 'about', 'contact', 'legal']);
  assert.deepStrictEqual(
    buildLightCoverageObservationPlan_(Array.from(ecCandidateMap.values()), { siteMode: 'ec', maxObserve: 2 }).candidates.map(item => item.pageType),
    ['product', 'about']
  );
  const corporateCandidateMap = new Map();
  assert.strictEqual(addEcGeneralLinkCandidatesFromLinks_(ecLinks, 'https://shop.example.test', corporateCandidateMap, {}, 'corporate').length, 0);
  assert.strictEqual(corporateCandidateMap.size, 0);
  const mediaCandidateMap = new Map();
  assert.strictEqual(addEcGeneralLinkCandidatesFromLinks_(ecLinks, 'https://shop.example.test', mediaCandidateMap, {}, 'media').length, 0);
  assert.strictEqual(mediaCandidateMap.size, 0);
  const semanticEcCandidateMap = new Map([[
    'https://shop.example.test/products',
    { url: 'https://shop.example.test/products', label: '商品一覧', pageType: '', source: 'nav', sources: ['nav'], score: 70 }
  ]]);
  assert.strictEqual(addEcGeneralLinkCandidatesFromLinks_(ecLinks.slice(0, 1), 'https://shop.example.test', semanticEcCandidateMap, {}, 'ec').length, 0);
  assert.strictEqual(semanticEcCandidateMap.size, 1);
  assert.deepStrictEqual(semanticEcCandidateMap.get('https://shop.example.test/products').sources.sort(), ['ecGeneralLink', 'nav']);

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

  // Subpage nav is derived from the HTML already fetched for coverage; no
  // additional request is necessary. A completed negative remains distinct
  // from a failed or timed-out observation.
  const subpageWithNav = parseSubpageJsonLdLightHtml(
    'https://shop.example.test/products/list',
    'https://shop.example.test/products/list',
    200,
    '<html><head><title>Products</title></head><body><nav><a href="/">Home</a></nav><h1>Products</h1></body></html>',
    'ec'
  );
  const subpageWithoutNav = parseSubpageJsonLdLightHtml(
    'https://shop.example.test/help/about',
    'https://shop.example.test/help/about',
    200,
    '<html><head><title>About</title></head><body><main><h1>About</h1></main></body></html>',
    'ec'
  );
  assert.strictEqual(subpageWithNav.hasNavElement, true);
  assert.strictEqual(subpageWithNav.navObservationComplete, true);
  assert.strictEqual(subpageWithoutNav.hasNavElement, false);
  assert.strictEqual(subpageWithoutNav.navObservationComplete, true);

  // Compact persistence must preserve all three nav states. Coverage signals
  // are built from this compact form rather than from the raw parser result.
  const compactNavTrue = compactSubpageJsonLdObservation_(subpageWithNav);
  const compactNavFalse = compactSubpageJsonLdObservation_(subpageWithoutNav);
  const compactNavUnknown = compactSubpageJsonLdObservation_(Object.assign({}, subpageWithNav, {
    hasNavElement: null,
    navObservationComplete: null
  }));
  assert.strictEqual(compactNavTrue.hasNavElement, true);
  assert.strictEqual(compactNavTrue.navObservationComplete, true);
  assert.strictEqual(compactNavFalse.hasNavElement, false);
  assert.strictEqual(compactNavFalse.navObservationComplete, true);
  assert.strictEqual(compactNavUnknown.hasNavElement, null);
  assert.strictEqual(compactNavUnknown.navObservationComplete, null);

  const compactNavFalseSignals = buildCoverageSignalsV1FromSubpageObservation_({
    observations: [compactNavFalse],
    coverageRuntime: { observationLimited: false, budgetLimitedCandidateCount: 0, timedOutCandidateCount: 0 }
  });
  const compactNavUnknownSignals = buildCoverageSignalsV1FromSubpageObservation_({
    observations: [compactNavUnknown],
    coverageRuntime: { observationLimited: false, budgetLimitedCandidateCount: 0, timedOutCandidateCount: 0 }
  });
  assert.strictEqual(compactNavFalseSignals.navObservationCompletedPageCount, 1);
  assert.strictEqual(compactNavFalseSignals.observedNavPageCount, 0);
  assert.strictEqual(compactNavUnknownSignals.navObservationCompletedPageCount, 0);
  assert.strictEqual(compactNavUnknownSignals.observedNavPageCount, 0);

  const kenkoNavCoverageSignals = buildGeoSignalsCoverageSignals_(buildCoverageSignalsV1FromSubpageObservation_({
    topUrl: 'https://www1.kenko064.com/',
    origin: 'https://www1.kenko064.com',
    siteMode: 'ec',
    candidates: [
      { url: 'https://www1.kenko064.com/products/list', pageType: 'product', source: 'ecGeneralLink' },
      { url: 'https://www1.kenko064.com/help/about', pageType: 'about', source: 'ecGeneralLink' }
    ],
    observations: [
      compactSubpageJsonLdObservation_(Object.assign({}, subpageWithNav, { url: 'https://www1.kenko064.com/products/list', finalUrl: 'https://www1.kenko064.com/products/list' })),
      compactSubpageJsonLdObservation_(Object.assign({}, subpageWithNav, { url: 'https://www1.kenko064.com/help/about', finalUrl: 'https://www1.kenko064.com/help/about' }))
    ],
    coverageRuntime: { observationLimited: false, budgetLimitedCandidateCount: 0, timedOutCandidateCount: 0 }
  }));
  assert.strictEqual(kenkoNavCoverageSignals.navObservationAttemptedPageCount, 2);
  assert.strictEqual(kenkoNavCoverageSignals.navObservationCompletedPageCount, 2);
  assert.strictEqual(kenkoNavCoverageSignals.observedNavPageCount, 2);
  assert.strictEqual(kenkoNavCoverageSignals.navObservationComplete, true);
  assert(kenkoNavCoverageSignals.representativePages.every(page => page.hasNavElement === true));
  assert.strictEqual(timedOutCoverageSignals.navObservationComplete, false);
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
  assert.strictEqual(Object.prototype.hasOwnProperty.call(lightBudgetHooks, 'recoverLightTopPageNavigation_'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(lightBudgetHooks, 'isLightNavigationProbeRetryableFailure_'), false);

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
  let firstBrowserClosed = 0;
  let firstAttemptId = '';
  let secondAttemptId = '';
  await runLightScrapeWithSetupRetry_(null, retryResponse, retryBudget, async () => {
    attempts += 1;
    const attempt = createLightAttempt_(retryBudget);
    if (attempts === 1) {
      firstAttemptId = attempt.id;
      attempt.page = { isClosed: () => false };
      attempt.context = { close: async () => {} };
      attempt.browser = { isConnected: () => true, close: async () => { firstBrowserClosed += 1; } };
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
  assert.strictEqual(firstBrowserClosed, 1);
  assert.notStrictEqual(firstAttemptId, secondAttemptId);
  assert.strictEqual(retryResponse.statusCode, 200);
  assert.strictEqual(retryBudget.resilience.retryPerformed, true);
  assert.strictEqual(retryBudget.resilience.firstFailureStage, 'page_create');

  // Retry cleanup follows the resource hierarchy: context then browser. A
  // parent close is authoritative for its Page; the browser is authoritative
  // for first-attempt isolation before a fresh retry.
  const successfulCleanupBudget = budgetFor(150000);
  const successfulCleanupAttempt = createLightAttempt_(successfulCleanupBudget);
  let pageCloseCalled = 0;
  successfulCleanupAttempt.page = { isClosed: () => false, close: async () => { pageCloseCalled += 1; } };
  successfulCleanupAttempt.context = { close: async () => {} };
  successfulCleanupAttempt.browser = { isConnected: () => true, close: async () => {} };
  const successfulCleanup = await cleanupLightAttempt_(successfulCleanupAttempt, 'fixture');
  assert.strictEqual(successfulCleanup.completed, true);
  assert.strictEqual(successfulCleanupAttempt.cleanupComplete, true);
  assert.strictEqual(successfulCleanup.diagnostics.page, 'closed_by_parent');
  assert.strictEqual(successfulCleanup.diagnostics.context, 'closed');
  assert.strictEqual(successfulCleanup.diagnostics.browser, 'closed');
  assert.strictEqual(pageCloseCalled, 0);
  assert.strictEqual(lightSetupRetryAdmission_(successfulCleanupBudget, successfulCleanupAttempt, 'page_create').allowed, true);

  const alreadyClosedAttempt = createLightAttempt_(budgetFor(150000));
  alreadyClosedAttempt.page = { isClosed: () => true, close: async () => { throw new Error('must_not_close_page'); } };
  alreadyClosedAttempt.context = { close: async () => {} };
  alreadyClosedAttempt.browser = { isConnected: () => true, close: async () => {} };
  const alreadyClosedCleanup = await cleanupLightAttempt_(alreadyClosedAttempt, 'fixture');
  assert.strictEqual(alreadyClosedCleanup.completed, true);
  assert.strictEqual(alreadyClosedCleanup.diagnostics.page, 'already_closed');

  let disconnected = true;
  const disconnectedBrowserAttempt = createLightAttempt_(budgetFor(150000));
  disconnectedBrowserAttempt.browser = {
    isConnected: () => disconnected,
    close: async () => { disconnected = false; throw new Error('browser_close_raced_with_disconnect'); }
  };
  const disconnectedBrowserCleanup = await cleanupLightAttempt_(disconnectedBrowserAttempt, 'fixture');
  assert.strictEqual(disconnectedBrowserCleanup.completed, true);
  assert.strictEqual(disconnectedBrowserCleanup.diagnostics.browser, 'disconnected');

  const liveBrowserFailureBudget = budgetFor(150000);
  const liveBrowserFailureAttempt = createLightAttempt_(liveBrowserFailureBudget);
  liveBrowserFailureAttempt.browser = { isConnected: () => true, close: async () => { throw new Error('browser_close_failed'); } };
  const liveBrowserFailureCleanup = await cleanupLightAttempt_(liveBrowserFailureAttempt, 'fixture');
  assert.strictEqual(liveBrowserFailureCleanup.completed, false);
  assert.strictEqual(liveBrowserFailureCleanup.diagnostics.browser, 'error');
  assert.strictEqual(lightSetupRetryAdmission_(liveBrowserFailureBudget, liveBrowserFailureAttempt, 'page_create').reason, 'cleanup_incomplete');

  // Per-resource timeout and the aggregate cleanup-barrier timeout both block retry.
  const closeTimeoutBudget = budgetFor(150000);
  const closeTimeoutAttempt = createLightAttempt_(closeTimeoutBudget);
  closeTimeoutAttempt.browser = { isConnected: () => true, close: () => sleep(40) };
  await cleanupLightAttempt_(closeTimeoutAttempt, 'fixture', { timeoutMs: 40, resourceTimeoutMs: 5 });
  assert.strictEqual(closeTimeoutAttempt.cleanupComplete, false);
  assert.strictEqual(closeTimeoutAttempt.cleanupDiagnostics.browser, 'timeout');
  assert.strictEqual(lightSetupRetryAdmission_(closeTimeoutBudget, closeTimeoutAttempt, 'page_create').reason, 'cleanup_incomplete');

  const barrierTimeoutBudget = budgetFor(150000);
  const barrierTimeoutAttempt = createLightAttempt_(barrierTimeoutBudget);
  barrierTimeoutAttempt.context = { close: async () => {} };
  barrierTimeoutAttempt.browser = { isConnected: () => true, close: () => sleep(40) };
  await cleanupLightAttempt_(barrierTimeoutAttempt, 'fixture', { timeoutMs: 5, resourceTimeoutMs: 40 });
  assert.strictEqual(barrierTimeoutAttempt.cancelled, true);
  assert.strictEqual(barrierTimeoutAttempt.controller.signal.aborted, true);
  assert.strictEqual(barrierTimeoutAttempt.cleanupComplete, false);
  assert.strictEqual(barrierTimeoutAttempt.cleanupDiagnostics.barrierTimedOut, true);
  assert.strictEqual(lightSetupRetryAdmission_(barrierTimeoutBudget, barrierTimeoutAttempt, 'page_create').reason, 'cleanup_incomplete');

  // The production retry runner observes cleanupComplete and does not begin a
  // second attempt when the first attempt's resource close fails.
  const cleanupFailureResponse = responseSpy();
  const cleanupFailureBudget = budgetFor(150000);
  let cleanupFailureAttempts = 0;
  await runLightScrapeWithSetupRetry_(null, cleanupFailureResponse, cleanupFailureBudget, async () => {
    cleanupFailureAttempts += 1;
    const attempt = createLightAttempt_(cleanupFailureBudget);
    attempt.browser = { isConnected: () => true, close: async () => { throw new Error('close_failed'); } };
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

  // A DOM fallback failure remains terminal; only the four setup stages may
  // create the fresh second attempt.
  const fallbackFailureBudget = budgetFor(150000);
  const fallbackFailureResponse = responseSpy();
  let fallbackFailureAttempts = 0;
  await runLightScrapeWithSetupRetry_(null, fallbackFailureResponse, fallbackFailureBudget, async () => {
    fallbackFailureAttempts += 1;
    const attempt = createLightAttempt_(fallbackFailureBudget);
    const error = new Error('probe evaluate timed out');
    error.code = 'LIGHT_REQUEST_BUDGET_EXHAUSTED';
    error.lightBudgetStage = 'top_page_dom_fallback';
    error.lightAttempt = attempt;
    throw error;
  });
  assert.strictEqual(fallbackFailureAttempts, 1);
  assert.strictEqual(fallbackFailureResponse.statusCode, 504);
  assert.strictEqual(fallbackFailureBudget.resilience.retryPerformed, false);
  assert.strictEqual(fallbackFailureBudget.resilience.retryAdmission, 'non_setup_stage');

  console.log('light-request-deadline fixtures: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
