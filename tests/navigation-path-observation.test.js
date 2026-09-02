const assert = require('assert');
const { chromium } = require('playwright');
const { buildGeoSignalsV1, attachContactDestination_, buildStaticFallbackGeoSignalsPayload_ } = require('../index.js').__lightBudgetTestHooks;

async function observe(html, name, options = {}) {
  const page = await globalThis.__navigationPathBrowser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await buildGeoSignalsV1(page, `https://${name}.example.test/`, {
      balancedMode: false,
      shortFastMode: false,
      ...options
    });
  } finally {
    await page.close();
  }
}

(async () => {
  globalThis.__navigationPathBrowser = await chromium.launch({ headless: true });
  try {
    const absent = await observe('<main><a href="/news">News</a></main>', 'absent');
    const observation = absent.navigationPathObservationsV1;
    assert.strictEqual(observation.observationVersion, 'navigation_path_observation_v1');
    assert.strictEqual(observation.authority, 'geoSignalsV1_light_bridge_v1');
    assert.strictEqual(observation.inputObserved, true);
    assert.strictEqual(observation.observationLimited, false);
    ['contact', 'company', 'service'].forEach((kind) => {
      assert.strictEqual(observation.kinds[kind].classificationComplete, true);
      assert.strictEqual(observation.kinds[kind].matchedCount, 0);
    });
    assert.strictEqual(observation.kinds.contact.destinationState, 'observation_limited');
    assert.strictEqual(observation.kinds.contact.destinationObservationComplete, false);

    const destinationStates = [
      'observed_subpage_form', 'observed_contact_page', 'candidate_probe',
      'standard_path_probe', 'not_observed', 'observation_limited'
    ];
    destinationStates.forEach((source) => {
      const target = { navigationPathObservationsV1: JSON.parse(JSON.stringify(observation)), observed: {} };
      attachContactDestination_(target, { hasContactDestination: source === 'not_observed' ? false : null, source });
      assert.strictEqual(target.navigationPathObservationsV1.kinds.contact.destinationState, source);
      assert.strictEqual(
        target.navigationPathObservationsV1.kinds.contact.destinationObservationComplete,
        source !== 'observation_limited'
      );
    });

    const matches = await observe([
      '<a href="/contact">Contact</a>',
      '<a href="/company">Company</a>',
      '<a href="/company/about">About</a>',
      '<a href="/service">Service</a>',
      '<a href="/plan">Plan</a>'
    ].join(''), 'matches');
    const kinds = matches.navigationPathObservationsV1.kinds;
    assert.strictEqual(kinds.contact.matchedCount, 1);
    assert.strictEqual(kinds.company.matchedCount, 2);
    assert.strictEqual(kinds.service.matchedCount, 2);
    assert.strictEqual(matches.observed.links.navigationPathObservationsV1, matches.navigationPathObservationsV1);

    // Static fallback does not publish a rendered-DOM completion contract.
    const fallback = buildStaticFallbackGeoSignalsPayload_('https://fallback.example.test/', { success: false, signals: { parseSucceeded: false } });
    assert.strictEqual(fallback.geoSignalsV1.navigationPathObservationsV1, undefined);

    const limited = await observe('<a href="/contact">Contact</a>', 'short-fast-limited', { shortFastMode: true });
    assert.strictEqual(limited.navigationPathObservationsV1.inputObserved, false);
    assert.strictEqual(limited.navigationPathObservationsV1.observationLimited, true);
    assert.strictEqual(limited.navigationPathObservationsV1.kinds.contact.classificationComplete, false);

    console.log('navigation-path-observation: ok');
  } finally {
    await globalThis.__navigationPathBrowser.close();
    delete globalThis.__navigationPathBrowser;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
