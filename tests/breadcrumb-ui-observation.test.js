const assert = require('assert');
const { chromium } = require('playwright');
const { buildGeoSignalsV1 } = require('../index.js').__lightBudgetTestHooks;

async function observe(html, name) {
  const page = await globalThis.__breadcrumbUiBrowser.newPage();
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

function breadcrumb(signals) {
  return signals && signals.coverage;
}

(async () => {
  globalThis.__breadcrumbUiBrowser = await chromium.launch({ headless: true });
  try {
    // A. Explicit aria/class detection remains authoritative.
    const explicit = await observe('<nav aria-label="breadcrumb"><ol><li>Home</li></ol></nav>', 'explicit');
    assert.strictEqual(breadcrumb(explicit).hasBreadcrumbUi, true);
    assert.strictEqual(breadcrumb(explicit).breadcrumbUiSource, 'explicit_selector');

    // B. Majisemi-shaped structural list with a CSS-only separator.
    const structural = await observe(`
      <style>.bread li + li::before { content: '>'; }</style>
      <main><div class="bread"><ul>
        <li><span property="itemListElement" typeof="ListItem"><a property="item" href="/" class="home"><span property="name">ホーム</span></a><meta property="position" content="1"></span></li>
        <li><span property="itemListElement" typeof="ListItem"><span property="name" class="post current-item">現在ページ</span><meta property="position" content="2"></span></li>
      </ul></div></main>
    `, 'structural');
    assert.strictEqual(breadcrumb(structural).hasBreadcrumbUi, true);
    assert.strictEqual(breadcrumb(structural).breadcrumbUiSource, 'structural_breadcrumb');

    // D. Header hamburger/global nav with home icon and multiple links is not a breadcrumb.
    const headerGlobal = await observe(`
      <header><nav class="header__gnav"><ul>
        <li><a href="/" class="home"><svg aria-hidden="true"></svg></a></li>
        <li><a href="/thoughts">Thoughts</a></li><li><a href="/strengths">Strengths</a></li>
      </ul></nav></header>
    `, 'header-global');
    assert.strictEqual(breadcrumb(headerGlobal).hasBreadcrumbUi, false);

    // E. A regular global nav remains excluded even when it has a Home link.
    const globalNav = await observe('<nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>', 'global-nav');
    assert.strictEqual(breadcrumb(globalNav).hasBreadcrumbUi, false);

    // F. A two-item content list has neither current-page semantics nor microdata.
    const plainList = await observe('<main><ul><li><a href="/">Home</a></li><li>News</li></ul></main>', 'plain-list');
    assert.strictEqual(breadcrumb(plainList).hasBreadcrumbUi, false);

    // F. Home plus ordinary links has no non-link marked current item.
    const homeLinks = await observe('<main><ul><li><a href="/" class="home">Home</a></li><li><a href="/news">News</a></li><li><a href="/about">About</a></li></ul></main>', 'home-links');
    assert.strictEqual(breadcrumb(homeLinks).hasBreadcrumbUi, false);

    // G. A current-item class alone is insufficient without a separate cue.
    const currentOnly = await observe('<main><ul><li><a href="/section">Section</a></li><li class="current-item">Current</li></ul></main>', 'current-only');
    assert.strictEqual(breadcrumb(currentOnly).hasBreadcrumbUi, false);

    // H. RDFa-like attributes alone are insufficient without a marked current item.
    const incompleteRdfa = await observe(`
      <main><ul>
        <li><span property="itemListElement" typeof="ListItem"><a property="item" href="/"><span property="name">Home</span></a><meta property="position" content="1"></span></li>
        <li><span property="itemListElement" typeof="ListItem"><span property="name">Current</span><meta property="position" content="2"></span></li>
      </ul></main>
    `, 'incomplete-rdfa');
    assert.strictEqual(breadcrumb(incompleteRdfa).hasBreadcrumbUi, false);

    console.log('breadcrumb-ui-observation: ok');
  } finally {
    await globalThis.__breadcrumbUiBrowser.close();
    delete globalThis.__breadcrumbUiBrowser;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
