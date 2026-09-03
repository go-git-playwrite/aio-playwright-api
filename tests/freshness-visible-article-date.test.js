const assert = require('assert');
const hooks = require('../index.js').__lightBudgetTestHooks;

const {
  buildArticleSignalsFromJsonLdAndMeta_,
  buildFreshnessOperationSignalsFromArticleSignals_,
  parseSubpageJsonLdLightHtml,
  normalizeArticleVisibleDate_,
  selectMediaFreshnessArticleCandidates_,
  LIGHT_MEDIA_FRESHNESS_ARTICLE_MAX_COUNT
} = hooks;

const visibleHeaderDate = (value = '2022.12.11') => [{
  kind: 'visible', value, articleContext: true, headerNearH1: true,
  dateSignal: true, labelled: false, excluded: false,
  source: 'article_header_visible_date'
}];

// Sitakke-equivalent structure: article detail header, date-class signal,
// category link and H1 are represented by the strict context facts above.
const sitakke = buildArticleSignalsFromJsonLdAndMeta_([], {}, 'https://example.test/post/1/', visibleHeaderDate());
assert.strictEqual(sitakke.checked, true);
assert.strictEqual(sitakke.visibleDate, '2022-12-11');
assert.strictEqual(sitakke.visibleDateType, 'published_or_modified_unknown');
assert.strictEqual(sitakke.visibleDateConfidence, 'medium');
assert.strictEqual(sitakke.summary.hasVisibleDate, true);
const sitakkeFreshness = buildFreshnessOperationSignalsFromArticleSignals_(sitakke, 'currentArticleSignals');
assert.strictEqual(sitakkeFreshness.latestDate, '2022-12-11');
assert.strictEqual(sitakkeFreshness.hasNewsDateEvidence, true);
assert.strictEqual(sitakkeFreshness.hasDatePublished, false);
assert.strictEqual(sitakkeFreshness.hasDateModified, false);
const sitakkeDom = parseSubpageJsonLdLightHtml('https://example.test/post/1/', 'https://example.test/post/1/', 200, `
  <div class="article-detail"><div class="article-detail__head"><div><p class="date">2022.12.11</p><a>カテゴリ</a></div><h1>記事タイトル</h1></div><div class="article-detail__body">本文</div></div>
`, 'media');
assert.strictEqual(sitakkeDom.articleSignals.visibleDate, '2022-12-11');
assert.strictEqual(sitakkeDom.articleSignals.visibleDateType, 'published_or_modified_unknown');

['2026.09.03', '2026/09/03', '2026-09-03', '2026年9月3日', '2026. 9. 3', '2026-09-03T12:00:00Z'].forEach(value => {
  assert.strictEqual(normalizeArticleVisibleDate_(value), '2026-09-03', value);
});
assert.strictEqual(normalizeArticleVisibleDate_('2026-02-30'), null);

const strong = buildArticleSignalsFromJsonLdAndMeta_([
  { '@type': 'Article', dateModified: '2024-05-06', datePublished: '2023-01-02' }
], {}, 'https://example.test/post/2/', visibleHeaderDate());
const strongFreshness = buildFreshnessOperationSignalsFromArticleSignals_(strong, 'currentArticleSignals');
assert.strictEqual(strongFreshness.latestDate, '2024-05-06');
assert.strictEqual(strongFreshness.datePublished, '2023-01-02');
assert.strictEqual(strongFreshness.dateModified, '2024-05-06');
const jsonLdBeforeMeta = buildArticleSignalsFromJsonLdAndMeta_([
  { '@type': 'Article', datePublished: '2024-01-02' }
], { modifiedTime: '2025-01-02' }, 'https://example.test/post/priority/', visibleHeaderDate());
assert.strictEqual(buildFreshnessOperationSignalsFromArticleSignals_(jsonLdBeforeMeta, 'currentArticleSignals').latestDate, '2024-01-02');

const modifiedTime = buildArticleSignalsFromJsonLdAndMeta_([], {}, 'https://example.test/post/3/', [{
  kind: 'time', value: '2026-09-03T12:00:00Z', articleContext: true, headerNearH1: true,
  dateSignal: true, labelled: true, modified: true, excluded: false, source: 'article_time_datetime'
}]);
assert.strictEqual(modifiedTime.visibleDate, '2026-09-03');
assert.strictEqual(modifiedTime.visibleDateType, 'modified');
assert.strictEqual(modifiedTime.visibleDateConfidence, 'high');
assert.strictEqual(buildFreshnessOperationSignalsFromArticleSignals_(modifiedTime, 'currentArticleSignals').dateModified, '2026-09-03');
const unknownTime = buildArticleSignalsFromJsonLdAndMeta_([], {}, 'https://example.test/post/4/', [{
  kind: 'time', value: '2026-09-03', articleContext: true, headerNearH1: true,
  dateSignal: true, labelled: false, excluded: false, source: 'article_time_datetime'
}]);
assert.strictEqual(unknownTime.visibleDateType, 'published_or_modified_unknown');
assert.strictEqual(unknownTime.summary.hasPublishedDate, false);
assert.strictEqual(unknownTime.summary.hasModifiedDate, false);

['event', 'related', 'footer', 'nav'].forEach(source => {
  const rejected = buildArticleSignalsFromJsonLdAndMeta_([], {}, 'https://example.test/', [{
    kind: 'visible', value: '2026.09.03', articleContext: source !== 'footer' && source !== 'nav', headerNearH1: true,
    dateSignal: true, excluded: true, source
  }]);
  assert.strictEqual(rejected.visibleDate, null, source);
});

const selected = selectMediaFreshnessArticleCandidates_([
  { href: 'https://example.test/company', semanticArticle: false, heading: true },
  { href: 'https://example.test/post/1', semanticArticle: true, cardLike: true, heading: true, dateSignal: true },
  { href: 'https://example.test/post/1', semanticArticle: true, cardLike: true, heading: true, dateSignal: true },
  { href: 'https://example.test/post/2', semanticArticle: true, cardLike: true, heading: true, image: true },
  { href: 'https://example.test/post/3', semanticArticle: true, cardLike: true, heading: true, inNavigation: true },
  { href: 'https://external.test/post/4', semanticArticle: true, cardLike: true, heading: true }
], 'https://example.test');
assert.strictEqual(selected.length, 2);
assert.strictEqual(selected[0].url, 'https://example.test/post/1');
assert(selected.length <= LIGHT_MEDIA_FRESHNESS_ARTICLE_MAX_COUNT);

console.log('freshness visible article date fixtures passed');
