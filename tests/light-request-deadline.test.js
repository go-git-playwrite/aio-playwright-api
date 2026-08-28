const assert = require('assert');
const {
  createLightRequestBudget_,
  recordLightCheckpoint_,
  markLightStageCheckpoint_,
  runLightBudgetStage_,
  sendLightBudgetTimeout_,
  enqueueLightScrapeWithDeadline_
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

(async () => {
  // A: normal setup stage keeps its result.
  const normalBudget = budgetFor(100);
  const normal = await runLightBudgetStage_(normalBudget, 'browser_launch', 60000, async () => ({ ok: true }));
  assert.deepStrictEqual(normal, { ok: true });

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
    completed: false
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

  console.log('light-request-deadline fixtures: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
