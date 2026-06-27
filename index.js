// index.js — scrape-v5-bundle+cache (phones/addresses + sameAs, foundingDate=STRICT DOM/HTML)
// 目的: DOMが空でも JS/JSON から電話・住所・sameAs を抽出。
//       設立日は「誤検出防止のため」DOM/HTML構造からのみ抽出（非必須）。

// === scoring config (ADD) ===
const { GoogleGenerativeAI } = require('@google/generative-ai');
const WEIGHTS5 = {
  dataStructure: 35,       // データ構造
  expressionClarity: 20,   // 表現の明確さ
  coverage: 20,            // 情報網羅性
  documentStructure: 15,   // 文書構造
  trust: 10                // 信頼性
};
const USE_REAL_SCORE = process.env.USE_REAL_SCORE !== 'false';

function clamp100(n){ const x = Number(n); return Math.max(0, Math.min(100, isFinite(x)?Math.round(x):0)); }
function weightedOverall5(ax){
  const sum = (WEIGHTS5.dataStructure    * clamp100(ax.dataStructure))
            + (WEIGHTS5.expressionClarity* clamp100(ax.expressionClarity))
            + (WEIGHTS5.coverage         * clamp100(ax.coverage))
            + (WEIGHTS5.documentStructure* clamp100(ax.documentStructure))
            + (WEIGHTS5.trust            * clamp100(ax.trust));
  return Math.round(sum / 100);
}

// === scorer (FIX v2: structured prompt + rationales + confidence) ===
async function scoreWithGemini5axes({ url, scrape }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

  // 安全ガード
  const ix = Number(scrape.innerTextLen || 0);
  const jc = Array.isArray(scrape.jsonld) ? scrape.jsonld.length : 0;
  const sig = scrape.signals || {};
  const s = {
    h1: sig.h1 || 0,
    h2: sig.h2 || 0,
    lists: sig.lists || 0,
    tables: sig.tables || 0,
    links: sig.links || 0,
    hasTel: !!sig.hasTel,
    hasAddress: !!sig.hasAddress,
    jsonldTypes: Array.isArray(sig.jsonldTypes) ? sig.jsonldTypes : []
  };

  // モデルへの厳密プロンプト
  const prompt = `
You are an auditor scoring a website's AI-readiness across 5 axes. 
Use ONLY the provided numeric/boolean signals; do not invent missing data.
Return STRICT JSON matching this schema:

{
 "axes5": {
   "dataStructure": 0-100,
   "expressionClarity": 0-100,
   "coverage": 0-100,
   "documentStructure": 0-100,
   "trust": 0-100
 },
 "rationales": {
   "dataStructure": [ "<<=50 chars each" ],
   "expressionClarity": [ "<=50" ],
   "coverage": [ "<=50" ],
   "documentStructure": [ "<=50" ],
   "trust": [ "<=50" ]
 }
}

Scoring policy (Japanese site):
- dataStructure (35): JSON-LD presence/types, machine-identifiable facts (tel/address).
- expressionClarity (20): clear nouns, concise content (use innerTextLen proxy and lists).
- coverage (20): breadth/depth proxies (innerTextLen, links).
- documentStructure (15): h1/h2 counts, lists, tables.
- trust (10): tel/address presence, policy/contact hints.

Signals:
- hydrated: ${scrape.hydrated}
- innerTextLen: ${ix}
- jsonldCount: ${jc}
- jsonldTypes: ${JSON.stringify(s.jsonldTypes)}
- h1: ${s.h1}, h2: ${s.h2}, lists: ${s.lists}, tables: ${s.tables}, links: ${s.links}
- hasTel: ${s.hasTel}, hasAddress: ${s.hasAddress}

Rules:
- Output integers 0–100 only.
- Provide at most 2 rationale bullets per axis, each <= 50 chars.
- No prose outside JSON.
`.trim();

  let axes5;
  let rationales = {
    dataStructure: [], expressionClarity: [], coverage: [], documentStructure: [], trust: []
  };

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    axes5 = parsed.axes5;
    rationales = parsed.rationales || rationales;
  } catch (_) {
    // フォールバック：信号に基づく簡易ルール
    const ds = (jc > 0 || s.hasTel || s.hasAddress) ? 70 : 40;
    const dc = Math.min(90, 30 + s.h1*10 + s.h2*5 + s.lists*5 + s.tables*5);
    const ec = Math.min(90, 40 + Math.floor(ix/100) + s.lists*3);
    const cov = Math.min(90, 40 + Math.floor(ix/80) + Math.floor(s.links/10));
    const tr  = (s.hasTel || s.hasAddress) ? 75 : 50;
    axes5 = {
      dataStructure: clamp100(ds),
      expressionClarity: clamp100(ec),
      coverage: clamp100(cov),
      documentStructure: clamp100(dc),
      trust: clamp100(tr)
    };
    rationales = {
      dataStructure: jc>0 ? ["JSON-LDあり"] : ["JSON-LD無し","本文に電話/住所="+(s.hasTel||s.hasAddress)],
      expressionClarity: [ "本文長:"+ix, "箇条書き:"+s.lists ],
      coverage: [ "本文長:"+ix, "リンク数:"+s.links ],
      documentStructure: [ "h1:"+s.h1+" h2:"+s.h2, "リスト/表:"+s.lists+"/"+s.tables ],
      trust: [ "電話:"+s.hasTel, "住所:"+s.hasAddress ]
    };
  }

  // overall（重み 35/20/20/15/10）
  const overall = weightedOverall5(axes5);

  // 簡易 confidence（0-1）：材料が多い & JSON-LD あり & hydrated で上がる
  const confBase = Math.max(0, Math.min(1, (ix/1500)));
  const confBoost = (scrape.hydrated ? 0.1 : 0) + (jc>0 ? 0.15 : 0);
  const confidence = Math.max(0.3, Math.min(0.98, confBase + confBoost));

  return {
    overall,
    axes5: {
      dataStructure: clamp100(axes5.dataStructure),
      expressionClarity: clamp100(axes5.expressionClarity),
      coverage: clamp100(axes5.coverage),
      documentStructure: clamp100(axes5.documentStructure),
      trust: clamp100(axes5.trust)
    },
    weights5: WEIGHTS5,
    rationales,
    evidence: {
      innerTextLen: ix, jsonldCount: jc, jsonldTypes: s.jsonldTypes,
      h1: s.h1, h2: s.h2, lists: s.lists, tables: s.tables, links: s.links,
      hasTel: s.hasTel, hasAddress: s.hasAddress
    },
    confidence,
    source: 'GEMINI_VIA_SCRAPE'
  };
}

const express = require('express');
const { chromium } = require('playwright');
const PQueue = require('p-queue').default;

const BUILD_TAG = 'scrape-v5-bundle-cache-07-scoring-fallback';
const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json({ limit: '64kb' }));

function logSfMemory(label) {
  try {
    const m = process.memoryUsage();
    console.log('[SF][MEMORY]', JSON.stringify({
      label,
      rssMB: Math.round(m.rss / 1024 / 1024),
      heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(m.heapTotal / 1024 / 1024),
      externalMB: Math.round(m.external / 1024 / 1024)
    }));
  } catch (e) {}
}

function logSf(label, extra) {
  try {
    console.log('[SF][' + label + ']', JSON.stringify(extra || {}));
  } catch (e) {
    console.log('[SF][' + label + ']');
  }
}

const SITEMAP_DISCOVERY_PATHS = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemaps.xml',
  '/sitemap/index.xml'
];

function extractSitemapUrlsFromRobotsTxt_(robotsText, origin) {
  const out = [];
  const seen = new Set();
  String(robotsText || '').split(/\r?\n/).forEach((line) => {
    const m = String(line || '').match(/^\s*Sitemap\s*:\s*(\S+)\s*$/i);
    if (!m || !m[1]) return;
    try {
      const u = new URL(m[1].trim(), origin).toString();
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    } catch (_) {}
  });
  return out;
}

function looksLikeSitemapXml_(text, contentType) {
  const ctype = String(contentType || '').toLowerCase();
  if (ctype.includes('xml')) return true;
  const head = String(text || '').slice(0, 2048);
  return /<\s*(urlset|sitemapindex)\b/i.test(head);
}

async function discoverSitemapFromOrigin_(origin, fetchText, options = {}) {
  const normalizedOrigin = String(origin || '').replace(/\/+$/, '');
  const result = {
    checked: false,
    exists: null,
    url: null,
    httpStatus: null,
    discoveryMethod: 'not_checked',
    checkedUrls: [],
    robotsTxtUrl: normalizedOrigin ? `${normalizedOrigin}/robots.txt` : null,
    robotsHttpStatus: null,
    robotsSitemapUrls: []
  };
  if (!normalizedOrigin || typeof fetchText !== 'function') return result;

  const timeoutMs = Number(options.timeoutMs || 1500);
  const robotsUrl = `${normalizedOrigin}/robots.txt`;
  const robots = await fetchText(robotsUrl, timeoutMs, 'GET');
  result.robotsHttpStatus = robots && typeof robots.status === 'number' ? robots.status : null;

  const candidates = [];
  if (robots && robots.ok) {
    result.robotsSitemapUrls = extractSitemapUrlsFromRobotsTxt_(robots.text || '', normalizedOrigin);
    result.robotsSitemapUrls.forEach((u) => candidates.push({ url: u, method: 'robots_txt' }));
  }

  SITEMAP_DISCOVERY_PATHS.forEach((path) => {
    candidates.push({ url: normalizedOrigin + path, method: 'common_path' });
  });

  const seen = new Set();
  for (const candidate of candidates) {
    const targetUrl = candidate && candidate.url;
    if (!targetUrl || seen.has(targetUrl)) continue;
    seen.add(targetUrl);
    result.checked = true;
    result.checkedUrls.push(targetUrl);
    const res = await fetchText(targetUrl, timeoutMs, 'GET');
    const status = res && typeof res.status === 'number' ? res.status : null;
    if (result.httpStatus === null) result.httpStatus = status;
    if (res && res.ok && looksLikeSitemapXml_(res.text || '', res.contentType || '')) {
      result.exists = true;
      result.url = targetUrl;
      result.httpStatus = status;
      result.discoveryMethod = candidate.method;
      return result;
    }
  }

  result.exists = false;
  result.discoveryMethod = result.checked ? 'not_found' : 'not_checked';
  return result;
}

function attachSitemapDiscoveryToGeoSignals_(geoSignalsV1, sitemapDiscovery) {
  if (!geoSignalsV1 || typeof geoSignalsV1 !== 'object' || !sitemapDiscovery || typeof sitemapDiscovery !== 'object') return;
  const exists = Object.prototype.hasOwnProperty.call(sitemapDiscovery, 'exists') ? sitemapDiscovery.exists : null;
  const checked = sitemapDiscovery.checked === true;
  const checkedUrls = Array.isArray(sitemapDiscovery.checkedUrls) ? sitemapDiscovery.checkedUrls.slice(0, 10) : [];
  const patch = {
    hasSitemapXml: exists,
    sitemapChecked: checked,
    sitemapExists: exists,
    sitemapXmlUrl: sitemapDiscovery.url || null,
    sitemapDiscoveryMethod: sitemapDiscovery.discoveryMethod || 'not_checked',
    sitemapCheckedUrls: checkedUrls,
    sitemapHttpStatus: Object.prototype.hasOwnProperty.call(sitemapDiscovery, 'httpStatus') ? sitemapDiscovery.httpStatus : null
  };

  geoSignalsV1.structuredData = Object.assign({}, geoSignalsV1.structuredData || {}, patch);
  geoSignalsV1.coverageSignals = Object.assign({}, geoSignalsV1.coverageSignals || {}, patch);
  geoSignalsV1.observed = geoSignalsV1.observed || {};
  geoSignalsV1.observed.structuredData = Object.assign({}, geoSignalsV1.observed.structuredData || {}, patch);
}

console.log('[BOOT][START]', JSON.stringify({
  build: BUILD_TAG,
  pid: process.pid,
  node: process.version,
  port: PORT,
  ts: new Date().toISOString()
}));

// === helper: lazyload対応の自動スクロール ===
async function autoScroll(page, { step = 1000, pauseMs = 250, maxScrolls = 6 } = {}) {
  let total = 0;
  for (let i = 0; i < maxScrolls; i++) {
    total = await page.evaluate((s) => {
      window.scrollBy(0, s);
      return window.scrollY || document.documentElement.scrollTop || 0;
    }, step);
    await page.waitForTimeout(pauseMs);
  }
  // 先頭に戻す（見出し抽出が安定）
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function collectEnrichedObservations(page, url) {
  const result = {
    sitemap: null,
    subpageMainlandmark: null,
    metaDetail: null,
    policyLinks: null,
    contentClarity: null,
    subpageHeading: null
  };

  // =========================
  // 1. sitemap_scan
  // =========================
  try {
    const base = new URL(url).origin;
    const fetchTextWithPageRequest = async (targetUrl, timeoutMs = 1500) => {
      try {
        const response = await page.request.get(targetUrl, {
          timeout: timeoutMs,
          headers: { 'Accept': 'application/xml,text/xml,text/plain,*/*;q=0.8' }
        });
        const status = response && typeof response.status === 'function' ? response.status() : null;
        const headers = response && typeof response.headers === 'function' ? response.headers() : {};
        const contentType = String((headers && (headers['content-type'] || headers['Content-Type'])) || '');
        if (!response || !response.ok()) return { ok: false, status, text: '', contentType };
        const text = String(await response.text() || '').slice(0, 120000);
        return { ok: true, status, text, contentType };
      } catch (e) {
        return { ok: false, status: null, text: '', contentType: '', errorMessage: String(e && (e.message || e) || '').slice(0, 160) };
      }
    };
    const sitemapDiscovery = await discoverSitemapFromOrigin_(base, fetchTextWithPageRequest, { timeoutMs: 2500 });
    result.sitemap = {
      found: sitemapDiscovery.exists === true,
      url: sitemapDiscovery.url,
      checkedUrls: sitemapDiscovery.checkedUrls,
      discoveryMethod: sitemapDiscovery.discoveryMethod,
      httpStatus: sitemapDiscovery.httpStatus
    };
  } catch (e) {
    result.sitemap = { found: false };
  }

  // =========================
  // 2. subpage_mainlandmark_scan
  // =========================
  try {
    const mainCount = await page.$$eval('main', els => els.length);
    const landmarkCount = await page.$$eval('[role="main"]', els => els.length);

    result.subpageMainlandmark = {
      mainCount,
      mainLandmarkCount: landmarkCount
    };
  } catch (e) {
    result.subpageMainlandmark = {};
  }

  // =========================
  // 3. meta_detail_scan
  // =========================
  try {
    const meta = await page.$eval(
      'meta[name="description"]',
      el => el.getAttribute('content') || ''
    ).catch(() => '');

    result.metaDetail = {
      hasMetaDescription: !!meta,
      metaDescriptionLength: meta ? meta.length : 0
    };
  } catch (e) {
    result.metaDetail = {};
  }

  // =========================
  // 4. policy_link_scan
  // =========================
  try {
    const links = await page.$$eval('a', els =>
      els.map(a => ({
        href: a.href,
        text: (a.innerText || '').toLowerCase()
      }))
    );

    function hasMatch(keywords) {
      return links.some(l =>
        keywords.some(k =>
          (l.href || '').toLowerCase().includes(k) ||
          (l.text || '').includes(k)
        )
      );
    }

    result.policyLinks = {
      hasPrivacyLink: hasMatch(['privacy', 'プライバシー']),
      hasPolicyLink: hasMatch(['policy', 'ポリシー']),
      hasTermsLink: hasMatch(['terms', '利用規約'])
    };
  } catch (e) {
    result.policyLinks = {};
  }

  // =========================
  // 5. content_clarity_scan
  // =========================
  try {
    result.contentClarity = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const headingEl = document.querySelector('main h1, h1, main h2, h2');
      const headingText = norm(headingEl ? headingEl.textContent : '');

      const anchors = Array.from(document.querySelectorAll('main a[href], a[href]'));
      const anchorTexts = anchors
        .map(a => norm(a.textContent || a.getAttribute('aria-label') || a.title || ''))
        .filter(Boolean);

      const genericRe = /^(more|read more|learn more|click here|view more|詳しく|こちら|詳細|もっと見る|続きを読む)$/i;
      const specificAnchorCount = anchorTexts.filter(t => t.length >= 8 && !genericRe.test(t)).length;
      const specificAnchorRatio = anchorTexts.length ? (specificAnchorCount / anchorTexts.length) : null;

      const images = Array.from(document.querySelectorAll('main img, img'));
      const altCoveredCount = images.filter(img => norm(img.getAttribute('alt')).length > 0).length;
      const imgAltRatio = images.length ? (altCoveredCount / images.length) : null;

      return {
        checked: true,
        headingTextLength: headingText.length || 0,
        anchorCount: anchorTexts.length,
        specificAnchorCount,
        specificAnchorRatio,
        imageCount: images.length,
        altCoveredCount,
        imgAltRatio
      };
    });
  } catch (e) {
    result.contentClarity = {};
  }

  // =========================
  // 6. subpage_heading_scan
  // =========================
  try {
    result.subpageHeading = await page.evaluate(() => {
      const headingEls = Array.from(document.querySelectorAll('main h1, main h2, main h3, h1, h2, h3'));
      const levels = headingEls.map(el => Number(String(el.tagName || '').replace(/[^1-6]/g, ''))).filter(Boolean);
      let headingSequenceBroken = false;
      for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i - 1] > 1) {
          headingSequenceBroken = true;
          break;
        }
      }
      return {
        checked: true,
        h1Count: levels.filter(n => n === 1).length,
        h2Count: levels.filter(n => n === 2).length,
        headingSequenceBroken
      };
    });
  } catch (e) {
    result.subpageHeading = {};
  }

  return result;
}

// === ADD: JSON-LD 待機＋コピーライト抽出（収集ペイロード） ==================
// 目的：SPA でも「一瞬でも出た main/header/footer/nav/h1」をラッチして取りこぼさない。
// 戻り値は probe 側(snake_case)で統一：buildAuditSigFromPage 側で header_present→headerPresent に合流する想定。
async function probeJsonLdAndCopyright(page, { maxWaitMs = 15000, pollMs = 200 } = {}) {
  const t0 = Date.now();

  // Playwright のロード状態は「補助」。これだけでは SPA の DOM 出現を保証できない。
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  console.log('[DBG][DOM-TOPOLOGY][ENTER]', { url: await page.url(), t: Date.now() });
  try { console.log('[DBG][DOM-TOPOLOGY][FRAMECOUNT]', page.frames().length); } catch(_){}

  // === [DBG][DOM-TOPOLOGY v1] 1回で「観測対象ズレ」を潰す ===
  try {
    const topo = await page.evaluate(() => {
      const out = {};

      // ---- 基本カウント（現ドキュメント）----
      out.url = location.href;
      out.readyState = document.readyState;
      out.title = document.title || '';
      out.bodyChildCount = document.body ? document.body.childElementCount : -1;

      out.counts = {
        header: document.querySelectorAll('header,[role="banner"]').length,
        footer: document.querySelectorAll('footer,[role="contentinfo"]').length,
        main:   document.querySelectorAll('main,[role="main"]').length,
        nav:    document.querySelectorAll('nav,[role="navigation"]').length,
        h1:     document.querySelectorAll('h1').length,
        ldjson:  document.querySelectorAll('script[type*="ld+json" i]').length,
        module:  document.querySelectorAll('script[type="module"][src]').length,
        iframe:  document.querySelectorAll('iframe').length
      };

      // ---- 画面に実体があるか（超ざっくり）----
      out.metrics = {
        innerTextLen: (document.documentElement?.innerText || '').length,
        bodyTextLen:  (document.body?.innerText || '').length,
      };

      // ---- JS進行の目安（1回で「JSが動いてるか」を見る）----
      out.runtime = {
        perfNow: (typeof performance !== 'undefined' && performance.now) ? Math.floor(performance.now()) : null,
        hasHydrationMarks: !!document.querySelector('script[type="module"], link[rel="modulepreload"]'),
        rafCallable: false
      };

      try {
        // requestAnimationFrame が存在して呼べる＝JSの実行環境としては動いている目安
        out.runtime.rafCallable = (typeof requestAnimationFrame === 'function');
      } catch (_) {
        out.runtime.rafCallable = false;
      }

      // ---- iframe: 同一オリジンだけ覗ける範囲で「中にmain等があるか」----
      const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12);
      out.iframes = iframes.map((f, idx) => {
        let ok = false, counts = null, src = '';
        try {
          src = f.getAttribute('src') || '';
          const d = f.contentDocument; // cross-origin だと例外/ null
          if (d) {
            ok = true;
            counts = {
              header: d.querySelectorAll('header,[role="banner"]').length,
              footer: d.querySelectorAll('footer,[role="contentinfo"]').length,
              main:   d.querySelectorAll('main,[role="main"]').length,
              nav:    d.querySelectorAll('nav,[role="navigation"]').length,
              h1:     d.querySelectorAll('h1').length,
              ldjson: d.querySelectorAll('script[type*="ld+json" i]').length
            };
          }
        } catch (e) {
          ok = false;
        }
        return { idx, src: src.slice(0, 160), sameOriginReadable: ok, counts };
      });

      // ---- Shadow DOM: open root の有無だけ（closed は“推定”もできないので存在確認はここまで）----
      const nodes = Array.from(document.querySelectorAll('*'));
      let openRoots = 0;
      for (const el of nodes) if (el.shadowRoot) openRoots++;

      // ---- Shadow DOM(open) の中に main/header/footer/nav/h1 が居ないかをスキャン ----
      try {
        // open shadowRoot だけ辿る（closed は辿れない）
        const roots = [];
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el && el.shadowRoot) roots.push(el.shadowRoot);
        }

        const shadowCounts = {
          roots: roots.length,
          header: 0,
          footer: 0,
          main: 0,
          nav: 0,
          h1: 0
        };

        // ルートごとにカウント（重複は許容：まず “居る/居ない” を確定したい）
        for (const r of roots) {
          try {
            shadowCounts.header += r.querySelectorAll('header,[role="banner"]').length;
            shadowCounts.footer += r.querySelectorAll('footer,[role="contentinfo"]').length;
            shadowCounts.main   += r.querySelectorAll('main,[role="main"]').length;
            shadowCounts.nav    += r.querySelectorAll('nav,[role="navigation"]').length;
            shadowCounts.h1     += r.querySelectorAll('h1').length;
          } catch (_) {}
        }

        out.shadowCounts = shadowCounts;

        // “main が Shadow 内にある” をフラグで返す
        out.shadowHasMain = shadowCounts.main > 0;

        // ついでに「Shadow の最上位タグ」を少しだけサンプル（観測用）
        out.shadowTopology = {
          samples: roots.slice(0, 3).map((r, i) => {
            try {
              const top = Array.from(r.children || []).slice(0, 8).map(el => ({
                tag: (el.tagName || '').toLowerCase(),
                id: el.id || '',
                cls: (el.className && String(el.className).split(/\s+/).slice(0, 4).join(' ')) || '',
                child: el.childElementCount
              }));
              return { i, top };
            } catch (e) {
              return { i, err: String(e && (e.message || e)) };
            }
          })
        };
      } catch (e) {
        out.shadowCounts = { err: String(e && (e.message || e)) };
      }

      // ---- 代表的な SPA ルート候補（あれば名前を見る）----
      const roots = ['#app', '#root', '#__next', '#svelte', '#nuxt', '#main', '#content'];
      out.spaRoots = roots
        .map(sel => ({ sel, hit: !!document.querySelector(sel) }))
        .filter(x => x.hit);

      return out;
    });

    // ---- Playwright frames: evaluateできる範囲で main 等を各frameで確認 ----
    try {
      const frames = page.frames();
      const framesInfo = [];
      for (const f of frames) {
        try {
          const r = await f.evaluate(() => ({
            url: location.href,
            hasMain: !!document.querySelector('main,[role="main"]'),
            hasHeader: !!document.querySelector('header,[role="banner"]'),
            hasFooter: !!document.querySelector('footer,[role="contentinfo"]'),
            navCount: document.querySelectorAll('nav,[role="navigation"]').length,
            h1Count: document.querySelectorAll('h1').length,
            bodyTextLen: (document.body?.innerText || '').length
          }));
          framesInfo.push(r);
        } catch (e) {
          framesInfo.push({ url: String(f.url()), err: String(e && (e.message || e)) });
        }
      }
      console.log('[DBG][DOM-TOPOLOGY][FRAMES]', { frameCount: frames.length, frames: framesInfo });
    } catch (e) {
      console.log('[DBG][DOM-TOPOLOGY][FRAMES][ERR]', String(e && (e.message || e)));
    }

    console.log('[DBG][DOM-TOPOLOGY]', topo);

    try{
      // 1) 展開できない問題を確実に潰す
      console.log('[DBG][DOM-TOPOLOGY][JSON]', JSON.stringify(topo));
    }catch(e){
      console.log('[DBG][DOM-TOPOLOGY][JSON][ERR]', String(e && (e.message || e)));
    }

    try{
      // 2) Shadow の “先頭だけ” を人間が読める形で抜く（JSONより見やすいことが多い）
      const s = topo && topo.shadowTopology && topo.shadowTopology.samples;
      console.log('[DBG][DOM-TOPOLOGY][SHADOW-SAMPLES]', Array.isArray(s) ? s : '(none)');
    }catch(e){
      console.log('[DBG][DOM-TOPOLOGY][SHADOW-SAMPLES][ERR]', String(e && (e.message || e)));
    }

    try{
      // 3) 重要シグナルだけを短く1行で（ログ検索が楽）
      console.log('[DBG][DOM-TOPOPOLOGY][SIG]', {
        url: topo && topo.url,
        module: topo && topo.counts && topo.counts.module,
        bodyTextLen: topo && topo.metrics && topo.metrics.bodyTextLen,
        openShadowRoots: topo && topo.shadowCounts && topo.shadowCounts.roots,
        shadowHasMain: topo && topo.shadowHasMain
      });
    }catch(_){}

    // === [DBG][DOM-ROOT-CHECK v1] 1回で「どこにDOMがあるか」を確定 ===
    try {
      // 1) 現在フレームの URL と、最終的に見てるページ URL のズレ
      const pageUrl = await page.url();
      const mainFrameUrl = page.mainFrame().url();
      console.log('[DBG][DOM-ROOT-CHECK][URL]', { pageUrl, mainFrameUrl });

      // 2) 画面が “真っ白” なのか / テキストはあるのか / body自体があるのか
      const surface = await page.evaluate(() => ({
        readyState: document.readyState,
        hasBody: !!document.body,
        bodyChildren: document.body ? document.body.childElementCount : -1,
        docElChildren: document.documentElement ? document.documentElement.childElementCount : -1,
        innerTextLen: (document.documentElement?.innerText || '').length,
        bodyTextLen: (document.body?.innerText || '').length,
        bodyHTMLLen: (document.body?.innerHTML || '').length,
        title: document.title || '',
        locationHref: location.href
      }));
      console.log('[DBG][DOM-ROOT-CHECK][SURFACE]', surface);

      // 3) “mainが無い”のではなく「別のセレクタで main 相当がある」ケースを拾う
      const altMain = await page.evaluate(() => {
        const candidates = [
          '#app', '#root', '#__next', '#nuxt', '#svelte',
          '#content', '#contents', '#main', '.main', '.l-main', '.site-main',
          '[data-testid="main"]', '[data-main]', '[role="document"]'
        ];

        const hits = [];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (!el) continue;
          const txtLen = (el.innerText || '').length;
          const child = el.childElementCount;
          hits.push({ sel, child, txtLen });
        }

        // body直下の代表タグを列挙（何で構成されてるか）
        const bodyTop = Array.from(document.body ? document.body.children : [])
          .slice(0, 20)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            cls: (el.className && String(el.className).split(/\s+/).slice(0, 4).join(' ')) || '',
            child: el.childElementCount
          }));

        return { altRoots: hits, bodyTop };
      });
      console.log('[DBG][DOM-ROOT-CHECK][ALT_MAIN]', altMain);

      // 4) “main等が0”の原因が Shadow DOM かを一発で判断（open rootsだけでも十分ヒントになる）
      const shadow = await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('*'));
        let openRoots = 0;
        let openRootTags = [];
        for (const el of nodes) {
          if (el.shadowRoot) {
            openRoots++;
            if (openRootTags.length < 12) openRootTags.push(el.tagName.toLowerCase());
          }
        }
        return { openRoots, openRootTags };
      });
      console.log('[DBG][DOM-ROOT-CHECK][SHADOW]', shadow);

      // 5) iframe が “別ドキュメント本体” になっていないか（cross-originかどうかも見える）
      const iframeInfo = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12);
        return iframes.map((f, i) => ({
          i,
          src: (f.getAttribute('src') || '').slice(0, 180),
          hasSrcdoc: !!f.getAttribute('srcdoc')
        }));
      });
      console.log('[DBG][DOM-ROOT-CHECK][IFRAMES]', iframeInfo);

    } catch (e) {
      console.log('[DBG][DOM-ROOT-CHECK][ERR]', String(e && (e.stack || e)));
    }

  } catch (e) {
    console.log('[DBG][DOM-TOPOLOGY][ERR]', String(e && (e.message || e)));
  }

  // --- DOM スナップショット（1回分） ---
  const snapshot = async () => {
    return await page.evaluate(() => {
      // --------- helpers ----------
      const q = (root, sel) => {
        try { return root ? root.querySelector(sel) : null; } catch (_) { return null; }
      };
      const qa = (root, sel) => {
        try { return root ? Array.from(root.querySelectorAll(sel)) : []; } catch (_) { return []; }
      };
      const textLen = (root) => {
        try { return (root && root.innerText) ? root.innerText.length : 0; } catch (_) { return 0; }
      };

      // --------- shadow roots (open only) ----------
      const hosts = Array.from(document.querySelectorAll('*'));
      const openRoots = [];
      for (const el of hosts) {
        if (el && el.shadowRoot) openRoots.push({ tag: el.tagName.toLowerCase(), root: el.shadowRoot });
        if (openRoots.length >= 8) break; // 多すぎると重いので上限
      }

      // Light DOM counts
      const light = {
        header: qa(document, 'header,[role="banner"]').length,
        footer: qa(document, 'footer,[role="contentinfo"]').length,
        main:   qa(document, 'main,[role="main"]').length,
        nav:    qa(document, 'nav,[role="navigation"]').length,
        h1:     qa(document, 'h1').length,
        ldjson: qa(document, 'script[type*="ld+json" i]').length,
        module: qa(document, 'script[type="module"][src]').length
      };

      // Shadow DOM counts（open root を合算）
      const shadow = {
        openRoots: openRoots.length,
        counts: { header: 0, footer: 0, main: 0, nav: 0, h1: 0, ldjson: 0 },
        textLenMax: 0,
        samples: [] // どのhostに入ってるかのヒント
      };

      for (const it of openRoots) {
        const r = it.root;
        const c = {
          header: qa(r, 'header,[role="banner"]').length,
          footer: qa(r, 'footer,[role="contentinfo"]').length,
          main:   qa(r, 'main,[role="main"]').length,
          nav:    qa(r, 'nav,[role="navigation"]').length,
          h1:     qa(r, 'h1').length,
          ldjson: qa(r, 'script[type*="ld+json" i]').length
        };
        shadow.counts.header += c.header;
        shadow.counts.footer += c.footer;
        shadow.counts.main   += c.main;
        shadow.counts.nav    += c.nav;
        shadow.counts.h1     += c.h1;
        shadow.counts.ldjson += c.ldjson;

        const tl = textLen(r);
        if (tl > shadow.textLenMax) shadow.textLenMax = tl;

        if (shadow.samples.length < 6) {
          shadow.samples.push({ host: it.tag, ...c, textLen: tl });
        }
      }

      // --------- JSON-LD 検出（Light + Shadow） ----------
      const allScriptsLight = qa(document, 'script');
      const allScriptsShadow = openRoots.flatMap(it => qa(it.root, 'script'));
      const allScripts = allScriptsLight.concat(allScriptsShadow);

      let scripts = allScripts.filter(el => {
        const t = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase().trim();
        return t.includes('ld+json');
      });

      if (scripts.length === 0) {
        scripts = allScripts.filter(el => {
          const t = String(el.getAttribute && el.getAttribute('type') || '').toLowerCase().trim();
          if (t && t !== 'application/json' && t !== 'text/plain' && t !== 'text/template') return false;
          const txt = String(el.textContent || '').trim();
          return txt.includes('"@context"') && txt.includes('"@type"');
        });
      }

      const jsonldCount = scripts.length;
      const jsonldSampleHead = String(scripts[0]?.textContent || '').slice(0, 200);

      // ★ 追加：jsonldTypesAll 抽出（最大5本・各テキスト最大50KB） + parseFailed
      let jsonldParseFailed = false;
      let jsonldTypesAll = [];
      try{
        const typeSet = new Set();

        const take = scripts.slice(0, 5);
        for (const sc of take){
          let txt = '';
          try{ txt = String(sc && sc.textContent || ''); }catch(_){ txt=''; }
          txt = txt.trim();
          if (!txt) continue;
          if (txt.length > 50000) txt = txt.slice(0, 50000); // ★重さ対策

          try{
            const obj = JSON.parse(txt);

            const nodes = Array.isArray(obj) ? obj : [obj];
            for (const node of nodes){
              if (!node || typeof node !== 'object') continue;
              const t = node['@type'];
              const types = Array.isArray(t) ? t : (t ? [t] : []);
              for (const tt of types){
                if (typeof tt === 'string' && tt) typeSet.add(tt);
              }
            }
          }catch(_e){
            // JSON-LD scriptがあるのにパースできない → “存在はするが確定不能”の重要シグナル
            jsonldParseFailed = true;
          }
        }

        jsonldTypesAll = Array.from(typeSet);
      }catch(_){
        jsonldParseFailed = true;
      }

      // --------- semantic DOM flags（Light OR Shadow） ----------
      const headerPresent = (light.header > 0) || (shadow.counts.header > 0);
      const footerPresent = (light.footer > 0) || (shadow.counts.footer > 0);
      const hasMainLandmark = (light.main > 0) || (shadow.counts.main > 0);
      const navCount = light.nav + shadow.counts.nav;
      const h1Count  = light.h1  + shadow.counts.h1;

      // --------- module script srcs（Lightのみで十分） ----------
      const moduleScriptSrcs = qa(document, 'script[type="module"][src]')
        .map(el => el.getAttribute('src') || '')
        .filter(Boolean);

      return {
        // JSON-LD
        jsonldCount,
        jsonldSampleHead,
        jsonldTypesAll,        // ★ 追加
        jsonldParseFailed,     // ★ 追加

        // SPA観測（Shadow込み）
        headerPresent,
        footerPresent,
        hasMainLandmark,
        navCount,
        h1Count,

        // デバッグ
        moduleScriptSrcs,
        shadowTopology: shadow,

        // 参考：Light側テキスト長（shadowはshadowTopology.textLenMax）
        innerTextLen: (document.documentElement?.innerText || '').length,
        bodyTextLen:  (document.body?.innerText || '').length
      };
    });
  };

  // --- ラッチ（取りこぼし防止） ---
  let headerSeen = false;
  let footerSeen = false;
  let mainSeen   = false;
  let navMax     = 0;
  let h1Max      = 0;

  let lastSnap = null;

  // まずは「JS描画で必要そうな要素が1つでも出る」まで軽く待つ（最大8秒）
  try {
    await page.waitForFunction(() => {
      const hasMain   = !!document.querySelector('main,[role="main"]');
      const hasHeader = !!document.querySelector('header,[role="banner"]');
      const hasFooter = !!document.querySelector('footer,[role="contentinfo"]');
      const hasLdJson = !!document.querySelector('script[type*="ld+json" i]');
      const hasModule = !!document.querySelector('script[type="module"][src]');
      return hasMain || hasHeader || hasFooter || hasLdJson || hasModule;
    }, { timeout: 8000 });
  } catch (_) {}

  // ★★★★★ ここに「IFRAME-CHECK」を挿入（この1箇所だけ） ★★★★★
  try {
    const iframes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map((f, i) => ({
        index: i,
        src: f.getAttribute('src'),
        id: f.id || null,
        class: f.className || null
      }));
    });
    console.log('[DEBUG][IFRAME-CHECK]', iframes);
  } catch (e) {
    console.log('[DEBUG][IFRAME-CHECK][ERR]', e && e.message);
  }

  // ★★★★★ A11Y（アクセシビリティツリー）経由の landmark 検出 ★★★★★
  let a11yMainSeen = false;

  try {
    // Playwright の role selector（closed shadow でも見える可能性あり）
    const a11yMainCount = await page.getByRole('main').count().catch(() => 0);
    const a11yBanner    = await page.getByRole('banner').count().catch(() => 0);
    const a11yFooter    = await page.getByRole('contentinfo').count().catch(() => 0);

    console.log('[DBG][A11Y-LANDMARKS]', {
      main: a11yMainCount,
      banner: a11yBanner,
      footer: a11yFooter
    });

    if (a11yMainCount > 0) a11yMainSeen = true;
  } catch (e) {
    console.log('[DBG][A11Y-LANDMARKS][ERR]', String(e && (e.message || e)));
  }

  // --- ポーリング：JSON-LD or semantic DOM の出現を待ちつつ、最大値をラッチ ---
  while (Date.now() - t0 < maxWaitMs) {
    const r = await snapshot();
    lastSnap = r;

    if (!a11yMainSeen) {
      const c = await page.getByRole('main').count().catch(() => 0);
      if (c > 0) a11yMainSeen = true;
    }

    if (r.headerPresent) headerSeen = true;
    if (r.footerPresent) footerSeen = true;
    if (r.hasMainLandmark || a11yMainSeen) mainSeen = true;

    if (Number(r.navCount || 0) > navMax) navMax = Number(r.navCount || 0);
    if (Number(r.h1Count  || 0) > h1Max)  h1Max  = Number(r.h1Count  || 0);

    // JSON-LD が DOM で出たら即勝ち
    if (Number(r.jsonldCount || 0) > 0) {
      return {
        jsonld_detected_once: true,
        jsonld_detect_count: Number(r.jsonldCount || 0),
        jsonld_types_all: Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [],
        jsonld_types:     Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [], // 互換
        jsonld_wait_ms:   Date.now() - t0,
        jsonld_timed_out: false,

        // ★ 追加：進捗状態（永続未判定の切り分け用）
        jsonld_scan_started: true,
        jsonld_scan_finished: true,
        jsonld_parse_failed: !!(r && r.jsonldParseFailed),

        // ★ 追加：同意壁の疑い（ここはDOM成功なので基本false）
        consent_wall_suspected: false,

        jsonld_sample_head: String(r.jsonldSampleHead || ''),

        // ★ ラッチ結果（snake_case）
        header_present: headerSeen,
        footer_present: footerSeen,
        nav_count: navMax,
        h1_count: h1Max,
        hasMainLandmark: mainSeen,

        // copyright（snake_case）
        copyright_footer_present: !!(r.footerElementPresent || footerSeen),
        copyright_hit: !!r.copyrightHit,
        copyright_hit_token: String(r.copyrightHitToken || ''),
        copyright_excerpt: String(r.copyrightExcerpt || '')
      };
    }

    // JSON-LD は無くても、semantic DOM が一度でも出たら「観測値」は確保できる
    // ただし JSON-LD をもう少し待ちたいので、ここでは抜けない（maxWaitMs まで続ける）

    await page.waitForTimeout(pollMs);
  }

  // --- タイムアウト時：最後のスナップでラッチを更新 ---
  const r = lastSnap || await snapshot();

  if (r.headerPresent) headerSeen = true;
  if (r.footerPresent) footerSeen = true;
  if (r.hasMainLandmark || a11yMainSeen) mainSeen = true;

  if (Number(r.navCount || 0) > navMax) navMax = Number(r.navCount || 0);
  if (Number(r.h1Count  || 0) > h1Max)  h1Max  = Number(r.h1Count  || 0);

  // --- フォールバック：DOMに JSON-LD が出ない SPA 用（module script から探索） ---
  // module script を 1本だけ GET して "@context" & "@type" を探す（軽量）
  try {
    if (Number(r.jsonldCount || 0) === 0) {
      // module src 候補（相対/絶対を正規化）
      let moduleSrcs = Array.isArray(r.moduleScriptSrcs) ? r.moduleScriptSrcs : [];

      // 相対パスを絶対化
      const pageUrl = await page.url();
      try {
        moduleSrcs = moduleSrcs.map(s => {
          try { return new URL(s, pageUrl).toString(); } catch(_) { return s; }
        });
      } catch(_) {}

      if (moduleSrcs.length > 0) {
        // app-index.js 優先、それ以外は先頭
        const target =
          moduleSrcs.find(u => String(u).includes('app-index.js')) ||
          moduleSrcs[0];

        if (target) {
          const resp = await page.context().request.get(target).catch(() => null);
          if (resp && resp.ok()) {
            const jsText = await resp.text();
            const idxContext = jsText.indexOf('"@context"');
            const idxType    = jsText.indexOf('"@type"');

            if (idxContext !== -1 && idxType !== -1) {
              // "@type" を列挙
              let typeNames = [];
              try {
                const mAll = jsText.matchAll(/"@type"\s*:\s*"([^"]+)"/g);
                for (const m of mAll) if (m && m[1]) typeNames.push(m[1]);
              } catch (_) {}

              // sample head
              const head = jsText.slice(Math.max(0, idxContext - 40), idxContext + 240);

              // detect_count は type の出現数をざっくり採用（最低1）
              const typeMatches = jsText.match(/"@type"\s*:/g);
              const count = typeMatches ? Math.max(1, typeMatches.length) : 1;

              return {
                jsonld_detected_once: true,
                jsonld_detect_count: count,
                jsonld_types_all: typeNames,
                jsonld_types:     typeNames, // 互換
                jsonld_wait_ms:   Date.now() - t0,
                jsonld_timed_out: false,

                // ★ 追加：進捗状態
                jsonld_scan_started: true,
                jsonld_scan_finished: true,
                jsonld_parse_failed: false,          // jsTextから拾えたのでparse失敗ではない

                // ★ 追加：同意壁疑い（timeout経由なのであり得る）
                consent_wall_suspected: false,       // ※ここは後で必要なら推定する（今は固定でOK）

                jsonld_sample_head: String(head || ''),

                header_present: headerSeen,
                footer_present: footerSeen,
                nav_count: navMax,
                h1_count: h1Max,
                hasMainLandmark: mainSeen,

                copyright_footer_present: !!(r.footerElementPresent || footerSeen),
                copyright_hit: !!r.copyrightHit,
                copyright_hit_token: String(r.copyrightHitToken || ''),
                copyright_excerpt: String(r.copyrightExcerpt || '')
              };
            }
          }
        }
      }
    }
  } catch (_) {
    // フォールバック失敗は無視して通常の timeout 結果へ
  }

  // --- ここまで来たら「見つからなかった」 ---
  return {
    jsonld_detected_once: false,
    jsonld_detect_count: Number(r.jsonldCount || 0),
    jsonld_types_all: Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [],
    jsonld_types:     Array.isArray(r.jsonldTypesAll) ? r.jsonldTypesAll : [], // 互換
    jsonld_wait_ms:   Date.now() - t0,
    jsonld_timed_out: true,
    jsonld_sample_head: String(r.jsonldSampleHead || ''),

    header_present: headerSeen,
    footer_present: footerSeen,
    nav_count: navMax,
    h1_count: h1Max,
    hasMainLandmark: mainSeen,

    copyright_footer_present: !!(r.footerElementPresent || footerSeen),
    copyright_hit: !!r.copyrightHit,
    copyright_hit_token: String(r.copyrightHitToken || ''),
    copyright_excerpt: String(r.copyrightExcerpt || '')
  };
}

// === [AIO][HEAD_META v1] head/meta 情報を抽出するヘルパー ==================
async function extractHeadMetaV1(page) {
  // title
  let titleText = '';
  try {
    // <title> が無い場合は空文字 or 例外になるので try/catch
    titleText = (await page.title()) || '';
  } catch (_) {
    titleText = '';
  }
  const hasTitle = !!titleText.trim();

  // meta description
  let descText = '';
  try {
    // head 内の <meta name="description">（大文字小文字ゆらぎも吸収）
    const handle = await page.$('head meta[name="description" i]');
    if (handle) {
      const content = await handle.getAttribute('content');
      descText = (content || '').trim();
      await handle.dispose();
    }
  } catch (_) {
    descText = '';
  }

  const hasMetaDescription = !!descText;
  const metaDescriptionLen = descText.length;

  return {
    hasTitle,
    titleText,
    hasMetaDescription,
    metaDescriptionLen,
    metaDescriptionText: descText
  };
}

// ===== [M3][SUBPAGES_VNEXT v1] 追加観測（v2非干渉：新キー subPages_vNext のみ） =====
const ENABLE_SUBPAGES_VNEXT = process.env.ENABLE_SUBPAGES_VNEXT !== '0';
const SUBPAGES_VNEXT_MAX = 8;

function pickSubPageCandidatesVNext_(origin){
  const o = String(origin || '').trim().replace(/\/+$/,'');
  if (!o) return [];

  const candidates = [
    o + '/about',
    o + '/company',
    o + '/service',
    o + '/contact',
    o + '/faq',
    o + '/policy',
    o + '/privacy',
    o + '/inquiry',
    o + '/business',
    o + '/support',
  ];

  const seen = new Set();
  const out = [];
  for (const u of candidates){
    const k = String(u).replace(/\/+$/,'');
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= SUBPAGES_VNEXT_MAX) break;
  }
  return out;
}

function firstMeaningfulStringVNext_(values){
  for (const v of (Array.isArray(values) ? values : [])) {
    const s = String(v || '').trim();
    if (s) return s;
  }
  return null;
}

function buildPublisherInfoFromSubPagesVNext_(subpages, structured, origin){
  const arr = Array.isArray(subpages) ? subpages : [];
  const companyPages = arr.filter(p => Array.isArray(p && p.companyLikeSignals) && p.companyLikeSignals.length > 0);
  const pool = companyPages.length ? companyPages : arr;

  function pickField(field){
    for (const page of pool) {
      const val = page && page.publisherCandidate && page.publisherCandidate[field];
      if (val != null && String(val).trim()) return String(val).trim();
    }
    return null;
  }

  const companyName = firstMeaningfulStringVNext_(pool.map(p => p && p.publisherCandidate && p.publisherCandidate.companyName).concat(pool.map(p => p && p.h1)).concat(pool.map(p => p && p.title)));
  const organizationName = firstMeaningfulStringVNext_(pool.map(p => p && p.publisherCandidate && p.publisherCandidate.organizationName).concat([companyName]));

  return {
    checked: true,
    companyName: companyName,
    organizationName: organizationName,
    address: pickField('address') || (structured && structured.address ? [structured.address.postalCode, structured.address.addressRegion, structured.address.addressLocality, structured.address.streetAddress].filter(Boolean).join(' ') : null),
    telephone: pickField('telephone') || (structured && structured.telephone ? structured.telephone : null),
    contactEmail: pickField('contactEmail'),
    representative: pickField('representative'),
    corporateNumber: pickField('corporateNumber'),
    sourceUrl: firstMeaningfulStringVNext_(pool.map(p => p && p.url)) || String(origin || '').trim() || null
  };
}

function summarizeSecurityHeaders_(responseHeaders){
  const h = responseHeaders && typeof responseHeaders === 'object' ? responseHeaders : {};
  return {
    checked: true,
    strictTransportSecurity: h['strict-transport-security'] ?? null,
    contentSecurityPolicy: h['content-security-policy'] ?? null,
    xFrameOptions: h['x-frame-options'] ?? null,
    xContentTypeOptions: h['x-content-type-options'] ?? null,
    referrerPolicy: h['referrer-policy'] ?? null,
    permissionsPolicy: h['permissions-policy'] ?? null
  };
}

// 1ページから“軽量な観測”だけ抜く（全文は保持しない）
async function extractLiteFromPageVNext_(page, url, origin, statusCode){
  const o = String(origin || '').trim().replace(/\/+$/,'');
  const u = String(url || '').trim();

  return await page.evaluate(({ u, o, statusCode }) => {
    function norm(s){ return String(s || '').replace(/\s+/g, ' ').trim(); }
    function textOf(el){ try{ return norm(el && el.textContent || ''); }catch(_){ return ''; } }
    function uniqTexts(arr){
      const out = [];
      const seen = new Set();
      for (const v of (Array.isArray(arr) ? arr : [])) {
        const s = norm(v);
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    }
    function attrOf(sel, name){
      try{ const el = document.querySelector(sel); return el ? norm(el.getAttribute(name) || '') : ''; }catch(_){ return ''; }
    }
    function collectSignalHits(combined, defs){
      const hits = [];
      for (const def of defs) {
        if (def.re.test(combined)) hits.push(def.label);
      }
      return hits;
    }

    const title = norm(document.title || '');
    const metaDescription = attrOf('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', 'content');
    const mainEl = document.querySelector('main,[role="main"]');
    const mainInnerText = norm((mainEl && mainEl.innerText) || '');
    const bodyInnerText = norm(document.body && document.body.innerText || '');
    const mainTextContent = norm((mainEl && mainEl.textContent) || '');
    const bodyTextContent = norm(document.body && document.body.textContent || '');
    const docTextContent = norm(document.documentElement && document.documentElement.textContent || '');
    const bodyText = mainInnerText || bodyInnerText || mainTextContent || bodyTextContent || docTextContent;
    const mainTextSample = (mainInnerText || bodyInnerText || mainTextContent || bodyTextContent || docTextContent).slice(0, 240);
    const bodyTextSample = (bodyInnerText || bodyTextContent || docTextContent || mainInnerText || mainTextContent).slice(0, 240);

    const h1Texts = uniqTexts(Array.from(document.querySelectorAll('main h1, h1')).map(textOf));
    const h2Texts = uniqTexts(Array.from(document.querySelectorAll('main h2, h2')).map(textOf));
    const roleHeadingTexts = uniqTexts(
      Array.from(document.querySelectorAll('[role="heading"]'))
        .map(textOf)
        .filter(Boolean)
    );
    const fallbackHeadingTexts = uniqTexts(
      Array.from(document.querySelectorAll('main .title, .page-title, .headline, .hero-title, .title'))
        .map(textOf)
        .filter(Boolean)
    );
    let headingTexts = uniqTexts(
      h1Texts
        .concat(h2Texts)
        .concat(roleHeadingTexts)
        .concat(fallbackHeadingTexts)
    ).slice(0, 10);
    const fallbackMainHeading = bodyText.slice(0, 80);
    if (!headingTexts.length && fallbackMainHeading) {
      headingTexts = [fallbackMainHeading];
    }
    const h1 = h1Texts[0] || roleHeadingTexts[0] || fallbackHeadingTexts[0] || '';
    const h2 = uniqTexts(
      h2Texts.length
        ? h2Texts
        : roleHeadingTexts.slice(h1 ? 1 : 0).concat(fallbackHeadingTexts.slice(h1 ? 1 : 0))
    ).slice(0, 10);

    const jsonldTypes = (() => {
      try{
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 20);
        const types = [];
        for (const s of scripts){
          const raw = String(s.textContent || '').trim();
          if (!raw) continue;
          let obj = null;
          try{ obj = JSON.parse(raw); }catch(_){ obj = null; }
          const pushType = (t) => { if (t && !types.includes(t)) types.push(String(t)); };
          const walk = (x) => {
            if (!x) return;
            if (Array.isArray(x)){ x.forEach(walk); return; }
            if (typeof x !== 'object') return;
            const t = x['@type'];
            if (Array.isArray(t)) t.forEach(pushType);
            else pushType(t);
            if (Array.isArray(x['@graph'])) x['@graph'].forEach(walk);
          };
          walk(obj);
        }
        return types.slice(0, 30);
      }catch(_){ return []; }
    })();

    const links = Array.from(document.querySelectorAll('a[href]'));
    const internalLinkCount = links.filter(a => {
      try {
        const uu = new URL(a.href, location.href);
        return uu.origin === o;
      } catch (_) {
        return false;
      }
    }).length;
    const contactLinkCount = links.filter(a => {
      const href = norm(a.getAttribute('href') || a.href || '').toLowerCase();
      const txt = norm(a.textContent || '').toLowerCase();
      return /contact|inquiry|お問い合わせ|お問合せ|問い合わせ/.test(href + ' ' + txt);
    }).length;

    const updatedDate = (() => {
      try{
        const txt = bodyText.slice(0, 30000);
        const m = txt.match(/(20\d{2})[\/\.\-](\d{1,2})[\/\.\-](\d{1,2})/);
        if (!m) return '';
        const y = m[1];
        const mm = String(m[2]).padStart(2,'0');
        const dd = String(m[3]).padStart(2,'0');
        return `${y}-${mm}-${dd}`;
      }catch(_){ return ''; }
    })();

    const is404 =
      (/^404\b/i.test(title)) ||
      (/not\s*found/i.test(title)) ||
      (metaDescription && /not\s*found/i.test(metaDescription)) ||
      (bodyText.slice(0, 400).match(/404|not\s*found/i));
    if (is404) return null;

    const combined = [u, title].concat(headingTexts).join(' | ');
    const combinedLower = combined.toLowerCase();

    const companyLikeSignals = collectSignalHits(combinedLower, [
      { label: 'about', re: /\/about\b|about\s+us|about\s+company/ },
      { label: 'company', re: /\/company\b|company|corporate|企業情報|会社概要|会社情報/ }
    ]);
    const serviceLikeSignals = collectSignalHits(combinedLower, [
      { label: 'service', re: /\/service\b|service|services|サービス|事業/ },
      { label: 'solution', re: /solution|solutions|ソリューション/ },
      { label: 'product', re: /product|products|プロダクト|製品/ }
    ]);
    const contactLikeSignals = collectSignalHits(combinedLower, [
      { label: 'contact', re: /\/contact\b|contact|お問い合わせ|お問合せ|問い合わせ/ },
      { label: 'inquiry', re: /inquiry|inquire/ }
    ]);
    const faqLikeSignals = collectSignalHits(combinedLower, [
      { label: 'faq', re: /\/faq\b|\bfaq\b|よくある質問|q&a|q & a/ }
    ]);

    const breadcrumbEl = document.querySelector('nav[aria-label*="breadcrumb" i], [aria-label*="breadcrumb" i], .breadcrumb, [class*="breadcrumb"], ol.breadcrumb, ul.breadcrumb, [data-breadcrumb]');
    const words = String(bodyText || '').match(/[一-龠ぁ-んァ-ンA-Za-z0-9]+/g) || [];

    const publisherCandidate = (() => {
      const addressMatch = bodyText.match(/(?:〒?\d{3}-?\d{4}[\s\S]{0,80}?(?:都|道|府|県)[\s\S]{0,120})/);
      const telMatch = bodyText.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/);
      const emailMatch = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      const representativeMatch = bodyText.match(/(?:代表取締役|代表者|代表)\s*[:：]?\s*([^\n]{1,40})/);
      const corporateNumberMatch = bodyText.match(/法人番号\s*[:：]?\s*(\d{13})/);
      return {
        checked: true,
        companyName: h1 || title || null,
        organizationName: h1 || title || null,
        address: addressMatch ? norm(addressMatch[0]) : null,
        telephone: telMatch ? norm(telMatch[0]) : null,
        contactEmail: emailMatch ? norm(emailMatch[0]) : null,
        representative: representativeMatch ? norm(representativeMatch[1]) : null,
        corporateNumber: corporateNumberMatch ? norm(corporateNumberMatch[1]) : null,
        sourceUrl: u
      };
    })();

    return {
      url: u,
      status: typeof statusCode === 'number' ? statusCode : null,
      title,
      metaDescription,
      h1,
      h2,
      jsonldTypes,
      updatedDate,
      internalLinkCount,
      h1Count: h1Texts.length,
      h2Count: h2Texts.length,
      roleHeadingCount: roleHeadingTexts.length,
      fallbackHeadingCount: fallbackHeadingTexts.length,
      headingTexts,
      headingCandidateTexts: uniqTexts(roleHeadingTexts.concat(fallbackHeadingTexts)).slice(0, 10),
      locationHref: String(location.href || u || ''),
      mainTextSample,
      bodyTextSample,
      bodyTextLen: bodyText.length,
      bodyInnerTextLen: bodyInnerText.length,
      mainInnerTextLen: mainInnerText.length,
      mainCount: document.querySelectorAll('main').length,
      navCount: document.querySelectorAll('nav').length,
      headerCount: document.querySelectorAll('header').length,
      footerCount: document.querySelectorAll('footer').length,
      hasBreadcrumb: !!breadcrumbEl,
      wordCount: words.length,
      contactLinkCount,
      companyLikeSignals,
      serviceLikeSignals,
      faqLikeSignals,
      contactLikeSignals,
      publisherCandidate
    };
  }, { u, o, statusCode });
}

// subPages_vNext を作る（最大8、失敗は握る）
async function buildSubPagesVNext_V1_(browserPage, origin, decision){
  const dec = decision && typeof decision === 'object' ? decision : null;
  const startedAt = Date.now();
  const setDecision = (patch) => {
    if (!dec || !patch || typeof patch !== 'object') return;
    try { Object.assign(dec, patch); } catch (_) {}
  };
  setDecision({
    enabled: !!ENABLE_SUBPAGES_VNEXT,
    envValue: process.env.ENABLE_SUBPAGES_VNEXT ?? null,
    origin: String(origin || '').trim().replace(/\/+$/,''),
    limit: 1,
    skipReason: 'not_reached'
  });
  if (!ENABLE_SUBPAGES_VNEXT) {
    setDecision({ skipReason: 'disabled_by_env', elapsedMs: Math.max(0, Date.now() - startedAt) });
    return [];
  }

  let o = String(origin || '').trim().replace(/\/+$/,'');
  if (!o){
    try{ o = (new URL(browserPage.url())).origin; }catch(_){ o = ''; }
  }
  if (!o) {
    setDecision({ skipReason: 'no_candidates', errorMessage: 'origin_missing', elapsedMs: Math.max(0, Date.now() - startedAt) });
    return [];
  }
  setDecision({ origin: o });

  const parentContext = browserPage && typeof browserPage.context === 'function' ? browserPage.context() : null;
  const browser = parentContext && typeof parentContext.browser === 'function'
    ? parentContext.browser()
    : null;
  if (!browser) {
    setDecision({ skipReason: 'browser_or_context_missing', errorMessage: 'browser_unavailable', elapsedMs: Math.max(0, Date.now() - startedAt) });
    return [];
  }

  let subContext = null;
  let subPage = null;

  try{
    subContext = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 800, height: 600 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });
    subPage = await subContext.newPage();
    await subPage.setViewportSize({ width: 800, height: 600 }).catch(() => {});
    await subPage.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) return route.abort();
      return route.continue();
    });
  }catch(e){
    setDecision({
      skipReason: 'browser_or_context_missing',
      errorMessage: String(e && (e.message || e) || ''),
      elapsedMs: Math.max(0, Date.now() - startedAt)
    });
    try { if (subPage) await subPage.close(); } catch(_e) {}
    try { if (subContext) await subContext.close(); } catch(_e) {}
    return [];
  }

  try{
    await subPage.goto(origin, { waitUntil: 'domcontentloaded', timeout: 12000 });
    try{ await subPage.waitForTimeout(150); }catch(_){ }
  }catch(_){ }

  const candidates = pickSubPageCandidatesVNext_(o).slice(0, 1);
  setDecision({
    candidateCount: candidates.length,
    candidateSample: candidates.slice(0, 5),
    limit: 1
  });
  console.log(`[SUBPAGE_ENRICH][TARGETS] count=${candidates.length}`, JSON.stringify({ origin: o, targets: candidates }));
  if (!candidates.length) {
    setDecision({ skipReason: 'no_candidates', elapsedMs: Math.max(0, Date.now() - startedAt) });
    return [];
  }

  const out = [];
  try {
    for (const url of candidates){
      if (out.length >= 1) break;
      setDecision({ attemptedCount: (dec && Number(dec.attemptedCount || 0) || 0) + 1 });
      try{
        const resp = await subPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        try{ await subPage.waitForTimeout(150); }catch(_){ }
        try {
          const contentType = resp && typeof resp.headerValue === 'function'
            ? await resp.headerValue('content-type')
            : ((resp && typeof resp.headers === 'function') ? (resp.headers()['content-type'] || null) : null);
          const finalUrl = (() => {
            try { return resp && typeof resp.url === 'function' ? resp.url() : subPage.url(); } catch (_) { return url; }
          })();
          const userAgent = await subPage.evaluate(() => navigator.userAgent).catch(() => null);
          const domMeta = await subPage.evaluate(() => {
            const iframes = Array.from(document.querySelectorAll('iframe')).map((f, i) => ({
              index: i,
              src: f.getAttribute('src') || '',
              id: f.id || null,
              className: f.className || null
            }));
            return {
              readyState: document.readyState,
              bodyInnerTextLen: String(document.body && document.body.innerText || '').length,
              iframeCount: iframes.length,
              iframeSrcs: iframes.slice(0, 10),
              scriptCount: document.querySelectorAll('script').length
            };
          }).catch(() => ({
            readyState: null,
            bodyInnerTextLen: 0,
            iframeCount: 0,
            iframeSrcs: [],
            scriptCount: 0
          }));

          console.log('[SUBPAGE_FETCH_DEBUG][META]', JSON.stringify({
            candidateUrl: url,
            finalUrl,
            status: resp ? resp.status() : null,
            title: await subPage.title().catch(() => ''),
            userAgent,
            contentType
          }));
          console.log('[SUBPAGE_FETCH_DEBUG][DOM]', JSON.stringify({
            candidateUrl: url,
            finalUrl,
            readyState: domMeta.readyState,
            bodyInnerTextLen: domMeta.bodyInnerTextLen,
            iframeCount: domMeta.iframeCount,
            iframeSrcs: domMeta.iframeCount > 0 ? domMeta.iframeSrcs : [],
            scriptCount: domMeta.scriptCount
          }));
          if (/^https?:\/\/www\.fork\.co\.jp\/about\/?$/i.test(String(finalUrl || url || ''))) {
            const domShape = await subPage.evaluate(() => {
              const body = document.body;
              const html = document.documentElement;
              const bodyInnerHTML = String(body && body.innerHTML || '');
              const docInnerHTML = String(html && html.innerHTML || '');
              const bodyTextContent = String(body && body.textContent || '');
              const bodyInnerText = String(body && body.innerText || '');

              const hiddenSelectors = [
                'main',
                '#app',
                '#__next',
                '#__nuxt',
                'app-index',
                'body > *:first-child'
              ];

              const hiddenSignals = hiddenSelectors.map(sel => {
                try {
                  const el = document.querySelector(sel);
                  if (!el) return { selector: sel, exists: false };
                  const style = window.getComputedStyle(el);
                  return {
                    selector: sel,
                    exists: true,
                    displayNone: style.display === 'none',
                    visibilityHidden: style.visibility === 'hidden'
                  };
                } catch (_) {
                  return { selector: sel, exists: false };
                }
              });

              return {
                bodyChildElementCount: body ? body.childElementCount : 0,
                bodyInnerHTMLHead: bodyInnerHTML.slice(0, 200),
                documentInnerHTMLHead: docInnerHTML.slice(0, 200),
                textContentLength: bodyTextContent.length,
                innerTextLength: bodyInnerText.length,
                hiddenSignals
              };
            }).catch(() => null);

            console.log('[SUBPAGE_DOM_SHAPE][BODY]', JSON.stringify({
              candidateUrl: url,
              finalUrl,
              bodyChildElementCount: domShape && domShape.bodyChildElementCount,
              textContentLength: domShape && domShape.textContentLength,
              innerTextLength: domShape && domShape.innerTextLength,
              hiddenSignals: domShape && domShape.hiddenSignals
            }));
            console.log('[SUBPAGE_DOM_SHAPE][HTML]', JSON.stringify({
              candidateUrl: url,
              finalUrl,
              bodyInnerHTMLHead: domShape && domShape.bodyInnerHTMLHead,
              documentInnerHTMLHead: domShape && domShape.documentInnerHTMLHead
            }));
          }
        } catch (_) { }
        try {
          await subPage.waitForFunction(() => {
            const bodyLen = (document.body && document.body.innerText ? document.body.innerText.length : 0);
            const docLen = (document.documentElement && document.documentElement.innerText ? document.documentElement.innerText.length : 0);
            const mainLen = (() => {
              const el = document.querySelector('main,[role="main"]');
              return el && el.innerText ? el.innerText.length : 0;
            })();
            return bodyLen > 0 || docLen > 0 || mainLen > 0;
          }, { timeout: 1200 }).catch(()=>{});
        } catch (_) { }
        try{ await subPage.waitForTimeout(120); }catch(_){ }

        const status = resp ? resp.status() : null;
        const lite = await extractLiteFromPageVNext_(subPage, url, o, status);
        if (!lite) continue;

        const hasAny = !!(lite && (lite.title || (lite.headingTexts && lite.headingTexts.length) || (lite.jsonldTypes && lite.jsonldTypes.length)));
        if (!hasAny) continue;

        out.push(lite);
        console.log('[SUBPAGE_BODY_DEBUG][PAGE]', JSON.stringify({
          candidateUrl: url,
          locationHref: lite.locationHref,
          status: lite.status,
          title: lite.title,
          mainCount: lite.mainCount,
          bodyTextLen: lite.bodyTextLen,
          bodyInnerTextLen: lite.bodyInnerTextLen,
          mainInnerTextLen: lite.mainInnerTextLen,
          wordCount: lite.wordCount
        }));
        console.log('[SUBPAGE_BODY_DEBUG][TEXT]', JSON.stringify({
          url: lite.url,
          locationHref: lite.locationHref,
          mainTextSample: lite.mainTextSample,
          bodyTextSample: lite.bodyTextSample
        }));
        console.log('[SUBPAGE_HEADING_DEBUG][PAGE]', JSON.stringify({
          candidateUrl: url,
          locationHref: lite.locationHref,
          title: lite.title,
          h1Count: lite.h1Count,
          h2Count: lite.h2Count,
          roleHeadingCount: lite.roleHeadingCount,
          fallbackHeadingCount: lite.fallbackHeadingCount,
          headingTexts: lite.headingTexts,
          headingCandidateTexts: lite.headingCandidateTexts
        }));
        console.log('[SUBPAGE_HEADING_DEBUG][TEXT_SAMPLE]', JSON.stringify({
          url: lite.url,
          locationHref: lite.locationHref,
          mainTextSample: lite.mainTextSample
        }));
        console.log('[SUBPAGE_ENRICH][PAGE]', JSON.stringify({
          url: lite.url,
          status: lite.status,
          title: lite.title,
          h1Count: lite.h1Count,
          h2Count: lite.h2Count,
          mainCount: lite.mainCount,
          navCount: lite.navCount,
          headerCount: lite.headerCount,
          footerCount: lite.footerCount,
          hasBreadcrumb: lite.hasBreadcrumb,
          companyLikeSignals: lite.companyLikeSignals,
          serviceLikeSignals: lite.serviceLikeSignals,
          contactLikeSignals: lite.contactLikeSignals,
          faqLikeSignals: lite.faqLikeSignals
        }));
        break;
      }catch(e){
        setDecision({
          skipReason: out.length ? 'ok' : 'fetch_failed',
          errorMessage: String(e && (e.message || e) || '').slice(0, 240)
        });
        console.warn('[SUBPAGE_ENRICH][PAGE][ERR]', JSON.stringify({ url, error: String(e && e.message || e) }));
      }
    }
  } finally {
    try { if (subPage) await subPage.close(); } catch(_) {}
    try { if (subContext) await subContext.close(); } catch(_) {}
  }

  setDecision({
    adoptedCount: out.length,
    skipReason: out.length ? 'ok' : (dec && dec.skipReason && dec.skipReason !== 'not_reached' ? dec.skipReason : 'adopted_zero'),
    elapsedMs: Math.max(0, Date.now() - startedAt)
  });
  console.log('[SUBPAGE_ENRICH][SUMMARY]', JSON.stringify({
    count: out.length,
    sample: out.slice(0, 1)
  }));
  console.log('[SUBPAGE_HEADING_DEBUG][SUMMARY]', JSON.stringify({
    adoptedCount: out.length,
    adoptedUrls: out.map(p => p && p.url).filter(Boolean)
  }));
  return out;
}
// ===== [M3][SUBPAGES_VNEXT v1] ここまで =====

async function collectProductSpecComparisonSignals(page, jsonldForFlags) {
  function uniq(arr) {
    return Array.from(new Set((arr || []).map(v => String(v || '').trim()).filter(Boolean)));
  }
  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }
  function flattenJsonLd(input, out) {
    out = out || [];
    if (!input) return out;
    if (Array.isArray(input)) {
      input.forEach(v => flattenJsonLd(v, out));
      return out;
    }
    if (typeof input !== 'object') return out;
    out.push(input);
    if (Array.isArray(input['@graph'])) input['@graph'].forEach(v => flattenJsonLd(v, out));
    return out;
  }
  function jsonLdTypeList(node) {
    const t = node && node['@type'];
    return (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v || ''));
  }
  function emitTrace(data) {
    try {
      console.log('[PW][PRODUCT_SPEC_COLLECT_TRACE]', JSON.stringify({
        tableCount: data && data.tableCount,
        dlCount: data && data.dlCount,
        headingCount: data && data.headingCount,
        specLikeTablesCount: data && data.specLikeTablesCount,
        comparisonLikeTablesCount: data && data.comparisonLikeTablesCount,
        specCueCount: data && data.specCueCount,
        comparisonCueCount: data && data.comparisonCueCount,
        productJsonLdCount: data && data.productJsonLdCount,
        serviceJsonLdCount: data && data.serviceJsonLdCount,
        structuredSpecScore: data && data.structuredSpecScore,
        comparisonReadinessLevel: data && data.comparisonReadinessLevel,
        hasStructuredProductInfo: data && data.hasStructuredProductInfo,
        hasComparisonReadyShape: data && data.hasComparisonReadyShape,
        attached: !!(data && data.attached),
        reason: data && data.reason
      }));
    } catch (_) {}
  }

  const dom = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const head = (s, n) => norm(s).slice(0, n || 80);
    const SPEC_RE = /(仕様|スペック|サイズ|重量|重さ|価格|料金|材質|素材|対応|型番|品番|SKU|容量|寸法|幅|高さ|奥行|カラー|色|spec|specification|size|weight|price|material|model|sku|capacity|dimension|color)/i;
    const COMP_RE = /(比較|違い|選び方|おすすめ|一覧|ラインアップ|性能差|compare|comparison|versus|vs\.?|difference|choose|ranking)/i;

    function qa(root, sel) {
      try { return root ? Array.from(root.querySelectorAll(sel)) : []; } catch (_) { return []; }
    }
    function openRoots() {
      const roots = [];
      try {
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el && el.shadowRoot) roots.push(el.shadowRoot);
          if (roots.length >= 8) break;
        }
      } catch (_) {}
      return roots;
    }
    const roots = [document].concat(openRoots());
    const all = (sel) => roots.flatMap(root => qa(root, sel));

    let specLikeTablesCount = 0;
    let comparisonLikeTablesCount = 0;
    let specCueCount = 0;
    let comparisonCueCount = 0;
    let specDlCount = 0;
    const evidenceSources = [];

    const tables = all('table').slice(0, 24);
    tables.forEach((table) => {
      const caption = head((table.querySelector('caption') || {}).innerText || '', 60);
      const thTexts = qa(table, 'th').slice(0, 24).map(el => norm(el.innerText || el.textContent)).filter(Boolean);
      const tdTexts = qa(table, 'td').slice(0, 80).map(el => norm(el.innerText || el.textContent)).filter(Boolean);
      const rowCount = qa(table, 'tr').length;
      const firstRowCells = qa(table, 'tr:first-child th, tr:first-child td').length;
      const colCount = Math.max(firstRowCells, thTexts.length ? Math.min(thTexts.length, 8) : 0);
      const text = [caption].concat(thTexts, tdTexts.slice(0, 24)).join(' ');
      const hasSpecCue = SPEC_RE.test(text);
      const hasComparisonCue = COMP_RE.test(text);
      if (hasSpecCue) {
        specLikeTablesCount++;
        specCueCount++;
        if (evidenceSources.length < 8) {
          evidenceSources.push('table: ' + head(caption || thTexts.join(' / ') || tdTexts.join(' / '), 80));
        }
      }
      if (hasComparisonCue || (hasSpecCue && rowCount >= 3 && colCount >= 3)) {
        comparisonLikeTablesCount++;
        comparisonCueCount++;
        if (evidenceSources.length < 8) {
          evidenceSources.push('comparison-table: rows=' + rowCount + ', cols=' + colCount);
        }
      }
    });

    const dls = all('dl').slice(0, 24);
    dls.forEach((dl) => {
      const labels = qa(dl, 'dt').slice(0, 30).map(el => norm(el.innerText || el.textContent)).filter(Boolean);
      const values = qa(dl, 'dd').slice(0, 30).map(el => norm(el.innerText || el.textContent)).filter(Boolean);
      const text = labels.concat(values.slice(0, 10)).join(' ');
      if (labels.length >= 3 && SPEC_RE.test(text)) {
        specDlCount++;
        specCueCount++;
        if (evidenceSources.length < 8) evidenceSources.push('dl: ' + head(labels.join(' / '), 80));
      }
      if (COMP_RE.test(text)) comparisonCueCount++;
    });

    const headingTexts = all('h1,h2,h3,h4,[role="heading"]').slice(0, 80)
      .map(el => norm(el.innerText || el.textContent))
      .filter(Boolean);
    headingTexts.forEach((txt) => {
      if (SPEC_RE.test(txt)) specCueCount++;
      if (COMP_RE.test(txt)) comparisonCueCount++;
    });

    return {
      tableCount: tables.length,
      dlCount: dls.length,
      headingCount: headingTexts.length,
      specLikeTablesCount,
      comparisonLikeTablesCount,
      specDlCount,
      specCueCount,
      comparisonCueCount,
      evidenceSources: evidenceSources.slice(0, 8)
    };
  }).catch(() => null);

  if (!dom || typeof dom !== 'object') {
    emitTrace({
      attached: false,
      reason: 'extraction_error'
    });
    return null;
  }

  const jsonldNodes = flattenJsonLd(jsonldForFlags || [], []);
  const productJsonLdCount = jsonldNodes.filter(node =>
    jsonLdTypeList(node).some(t => /^Product$/i.test(t))
  ).length;
  const serviceJsonLdCount = jsonldNodes.filter(node =>
    jsonLdTypeList(node).some(t => /^Service$/i.test(t))
  ).length;
  const productLikeNodes = jsonldNodes.filter(node =>
    jsonLdTypeList(node).some(t => /^(Product|Service|Offer|AggregateOffer)$/i.test(t))
  );
  const propertyKeys = [
    'name', 'description', 'sku', 'mpn', 'model', 'brand', 'offers',
    'additionalProperty', 'category', 'url', 'provider', 'serviceType',
    'areaServed', 'itemOffered'
  ];
  const jsonLdPropertyHits = productLikeNodes.map(node =>
    propertyKeys.filter(k => node && Object.prototype.hasOwnProperty.call(node, k)).length
  );
  const maxJsonLdPropertyCount = jsonLdPropertyHits.length ? Math.max(...jsonLdPropertyHits) : 0;
  const hasProductLikeJsonLd = productLikeNodes.length > 0;

  const hasStructuredProductInfo = !!(
    dom.specLikeTablesCount > 0 ||
    dom.specDlCount > 0 ||
    (hasProductLikeJsonLd && maxJsonLdPropertyCount >= 4)
  );
  const hasComparisonReadyShape = !!(
    dom.comparisonLikeTablesCount > 0 ||
    (dom.specLikeTablesCount > 0 && dom.comparisonCueCount > 0)
  );

  const hasRealObservationMaterial = !!(
    dom.specLikeTablesCount > 0 ||
    dom.comparisonLikeTablesCount > 0 ||
    dom.specDlCount > 0 ||
    hasProductLikeJsonLd
  );
  if (!hasRealObservationMaterial) {
    const hasCueOnly = Number(dom.specCueCount || 0) > 0 || Number(dom.comparisonCueCount || 0) > 0;
    emitTrace({
      tableCount: Number(dom.tableCount || 0),
      dlCount: Number(dom.dlCount || 0),
      headingCount: Number(dom.headingCount || 0),
      specLikeTablesCount: Number(dom.specLikeTablesCount || 0),
      comparisonLikeTablesCount: Number(dom.comparisonLikeTablesCount || 0),
      specCueCount: Number(dom.specCueCount || 0),
      comparisonCueCount: Number(dom.comparisonCueCount || 0),
      productJsonLdCount,
      serviceJsonLdCount,
      structuredSpecScore: null,
      comparisonReadinessLevel: null,
      hasStructuredProductInfo,
      hasComparisonReadyShape,
      attached: false,
      reason: hasCueOnly ? 'cue_only_guard' : 'no_structured_signal'
    });
    return null;
  }

  let structuredSpecScore = 0;
  if (dom.specLikeTablesCount > 0) structuredSpecScore += 35;
  if (dom.specDlCount > 0) structuredSpecScore += 20;
  if (hasProductLikeJsonLd) structuredSpecScore += clamp(maxJsonLdPropertyCount * 6, 10, 30);
  if (dom.comparisonLikeTablesCount > 0) structuredSpecScore += 25;
  if (hasComparisonReadyShape) structuredSpecScore += 10;
  structuredSpecScore = clamp(Math.round(structuredSpecScore), 0, 100);

  const comparisonReadinessLevel =
    structuredSpecScore >= 70 ? 'strong' :
    structuredSpecScore >= 40 ? 'medium' :
    structuredSpecScore > 0 ? 'weak' : 'none';

  const evidenceSources = uniq([]
    .concat(dom.evidenceSources || [])
    .concat(hasProductLikeJsonLd ? ['jsonld: Product/Service/Offer nodes=' + productLikeNodes.length] : [])
  ).slice(0, 8);

  emitTrace({
    tableCount: Number(dom.tableCount || 0),
    dlCount: Number(dom.dlCount || 0),
    headingCount: Number(dom.headingCount || 0),
    specLikeTablesCount: Number(dom.specLikeTablesCount || 0),
    comparisonLikeTablesCount: Number(dom.comparisonLikeTablesCount || 0),
    specCueCount: Number(dom.specCueCount || 0),
    comparisonCueCount: Number(dom.comparisonCueCount || 0),
    productJsonLdCount,
    serviceJsonLdCount,
    structuredSpecScore,
    comparisonReadinessLevel,
    hasStructuredProductInfo,
    hasComparisonReadyShape,
    attached: true,
    reason: 'attached'
  });

  return {
    hasStructuredProductInfo,
    hasComparisonReadyShape,
    structuredSpecScore,
    comparisonReadinessLevel,
    specLikeTablesCount: Number(dom.specLikeTablesCount || 0),
    comparisonLikeTablesCount: Number(dom.comparisonLikeTablesCount || 0),
    specCueCount: Number(dom.specCueCount || 0),
    comparisonCueCount: Number(dom.comparisonCueCount || 0),
    evidenceSources
  };
}

async function collectMultimodalSignals(page, jsonldForFlags) {
  function compactUrl(v) {
    return String(v || '').trim();
  }
  function uniq(arr) {
    return Array.from(new Set((arr || []).map(v => compactUrl(v)).filter(Boolean)));
  }
  function take(arr, n) {
    return (arr || []).filter(Boolean).slice(0, n || 5);
  }
  function flattenJsonLd(input, out) {
    out = out || [];
    if (!input) return out;
    if (Array.isArray(input)) {
      input.forEach(v => flattenJsonLd(v, out));
      return out;
    }
    if (typeof input !== 'object') return out;
    out.push(input);
    if (Array.isArray(input['@graph'])) input['@graph'].forEach(v => flattenJsonLd(v, out));
    return out;
  }
  function typeList(node) {
    const t = node && node['@type'];
    return (Array.isArray(t) ? t : (t ? [t] : [])).map(v => String(v || '').trim()).filter(Boolean);
  }
  function firstTextValue(v) {
    if (!v) return '';
    if (typeof v === 'string') return compactUrl(v);
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = firstTextValue(item);
        if (s) return s;
      }
      return '';
    }
    if (typeof v === 'object') {
      return firstTextValue(v.url || v.contentUrl || v.thumbnailUrl || v['@id'] || v.image);
    }
    return '';
  }

  try {
    const dom = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const abs = (u) => {
        try { return u ? new URL(u, document.baseURI).toString() : ''; } catch (_) { return String(u || '').trim(); }
      };
      const firstMeta = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const v = el && el.getAttribute('content');
          if (norm(v)) return norm(v);
        }
        return '';
      };
      const firstLink = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const v = el && el.getAttribute('href');
          if (norm(v)) return abs(v);
        }
        return '';
      };
      const collect = (sel) => Array.from(document.querySelectorAll(sel));
      const openRoots = [];
      try {
        const all = Array.from(document.querySelectorAll('*'));
        for (const el of all) {
          if (el && el.shadowRoot) openRoots.push(el.shadowRoot);
          if (openRoots.length >= 8) break;
        }
      } catch (_) {}
      const queryAll = (sel) => {
        const out = collect(sel);
        for (const root of openRoots) {
          try { out.push(...Array.from(root.querySelectorAll(sel))); } catch (_) {}
        }
        return out;
      };

      const ogImageUrl = abs(firstMeta([
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[property="og:image:secure_url"]'
      ]));
      const twitterImageUrl = abs(firstMeta([
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]'
      ]));
      const faviconUrl = firstLink([
        'link[rel~="icon"][href]',
        'link[rel="shortcut icon"][href]'
      ]);
      const appleTouchIconUrl = firstLink([
        'link[rel~="apple-touch-icon"][href]',
        'link[rel="apple-touch-icon-precomposed"][href]'
      ]);

      const images = queryAll('img').slice(0, 500);
      const imageUrls = [];
      let altMissingCount = 0;
      images.forEach((img) => {
        const alt = norm(img.getAttribute('alt'));
        if (!alt) altMissingCount++;
        const src = abs(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original'));
        if (src && imageUrls.length < 5) imageUrls.push(src);
      });
      const imageCount = images.length;
      const altTotal = imageCount;
      const imgAltRatio = imageCount ? ((imageCount - altMissingCount) / imageCount) : null;

      const iframes = queryAll('iframe');
      const iframeSrcs = iframes.map(el => abs(el.getAttribute('src'))).filter(Boolean);
      const youtubeIframes = iframeSrcs.filter(src => /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)|youtube-nocookie\.com/i.test(src));
      const vimeoIframes = iframeSrcs.filter(src => /(^|\/\/)(player\.)?vimeo\.com/i.test(src));
      const audioEmbedIframes = iframeSrcs.filter(src => /(spotify\.com|soundcloud\.com|podcasts\.apple\.com|anchor\.fm|podbean\.com)/i.test(src));

      const videoTags = queryAll('video');
      const audioTags = queryAll('audio');
      const tracks = queryAll('track');
      const captionTracks = tracks.filter(t => /^(captions|subtitles)$/i.test(norm(t.getAttribute('kind'))));
      const transcriptLinks = queryAll('a[href]').filter(a => {
        const txt = norm((a.innerText || a.textContent || '') + ' ' + (a.getAttribute('href') || ''));
        return /(transcript|caption|subtitles?|文字起こし|字幕|書き起こし)/i.test(txt);
      });

      const figures = queryAll('figure');
      const figcaptions = queryAll('figcaption');
      const mediaAriaNodes = queryAll('img,video,audio,iframe,figure').filter(el =>
        norm(el.getAttribute('aria-label') || el.getAttribute('title'))
      );
      const mediaCaptionSamples = [];
      figcaptions.forEach(el => {
        const t = norm(el.innerText || el.textContent);
        if (t && mediaCaptionSamples.length < 5) mediaCaptionSamples.push(t.slice(0, 120));
      });
      mediaAriaNodes.forEach(el => {
        const t = norm(el.getAttribute('aria-label') || el.getAttribute('title'));
        if (t && mediaCaptionSamples.length < 5) mediaCaptionSamples.push(t.slice(0, 120));
      });

      return {
        ogImageUrl,
        twitterImageUrl,
        faviconUrl,
        appleTouchIconUrl,
        imageCount,
        altTotal,
        altMissingCount,
        imgAltRatio,
        imageUrlsSample: imageUrls.slice(0, 5),
        videoTagCount: videoTags.length,
        hasYoutubeIframe: youtubeIframes.length > 0,
        hasVimeoIframe: vimeoIframes.length > 0,
        videoIframeCount: youtubeIframes.length + vimeoIframes.length,
        audioTagCount: audioTags.length,
        audioEmbedCount: audioEmbedIframes.length,
        trackCount: tracks.length,
        captionTrackCount: captionTracks.length,
        transcriptLinkCount: transcriptLinks.length,
        figureCount: figures.length,
        figcaptionCount: figcaptions.length,
        mediaAriaLabelCount: mediaAriaNodes.length,
        mediaCaptionSamples: mediaCaptionSamples.slice(0, 5)
      };
    });

    const nodes = flattenJsonLd(jsonldForFlags || [], []);
    const structuredImageTypes = [];
    let structuredLogoUrl = '';
    let structuredImageCount = 0;
    let imageObjectCount = 0;
    let primaryImageOfPage = '';
    let thumbnailUrlCount = 0;
    let videoObjectCount = 0;
    let videoThumbnailUrlCount = 0;
    let audioObjectCount = 0;

    nodes.forEach((node) => {
      if (!node || typeof node !== 'object') return;
      const types = typeList(node);
      const hasImage = !!firstTextValue(node.image);
      const hasLogo = !!firstTextValue(node.logo);
      const primaryImage = firstTextValue(node.primaryImageOfPage);
      const thumb = firstTextValue(node.thumbnailUrl);

      if (hasLogo && !structuredLogoUrl) structuredLogoUrl = firstTextValue(node.logo);
      if (hasImage || hasLogo || primaryImage || thumb) {
        structuredImageCount++;
        types.forEach(t => structuredImageTypes.push(t));
      }
      if (types.some(t => /^ImageObject$/i.test(t))) imageObjectCount++;
      if (primaryImage && !primaryImageOfPage) primaryImageOfPage = primaryImage;
      if (thumb) thumbnailUrlCount++;
      if (types.some(t => /^VideoObject$/i.test(t))) {
        videoObjectCount++;
        if (thumb) videoThumbnailUrlCount++;
      }
      if (types.some(t => /^AudioObject$/i.test(t))) audioObjectCount++;
    });

    return {
      checked: true,
      source: 'top_dom_head_meta_jsonld',
      image: {
        hasOgImage: !!(dom && dom.ogImageUrl),
        ogImageUrl: (dom && dom.ogImageUrl) || '',
        hasTwitterImage: !!(dom && dom.twitterImageUrl),
        twitterImageUrl: (dom && dom.twitterImageUrl) || '',
        hasFavicon: !!(dom && dom.faviconUrl),
        faviconUrl: (dom && dom.faviconUrl) || '',
        hasAppleTouchIcon: !!(dom && dom.appleTouchIconUrl),
        appleTouchIconUrl: (dom && dom.appleTouchIconUrl) || '',
        imageCount: Number((dom && dom.imageCount) || 0),
        altTotal: Number((dom && dom.altTotal) || 0),
        altMissingCount: Number((dom && dom.altMissingCount) || 0),
        imgAltRatio: (dom && typeof dom.imgAltRatio === 'number') ? dom.imgAltRatio : null,
        imageUrlsSample: take(dom && dom.imageUrlsSample, 5)
      },
      structured: {
        hasStructuredLogo: !!structuredLogoUrl,
        structuredLogoUrl: structuredLogoUrl || '',
        structuredImageCount,
        imageObjectCount,
        structuredImageTypes: take(uniq(structuredImageTypes), 12),
        primaryImageOfPage: primaryImageOfPage || '',
        thumbnailUrlCount
      },
      video: {
        hasVideoTag: Number((dom && dom.videoTagCount) || 0) > 0,
        videoTagCount: Number((dom && dom.videoTagCount) || 0),
        hasYoutubeIframe: !!(dom && dom.hasYoutubeIframe),
        hasVimeoIframe: !!(dom && dom.hasVimeoIframe),
        videoIframeCount: Number((dom && dom.videoIframeCount) || 0),
        hasVideoObject: videoObjectCount > 0,
        videoObjectCount,
        videoThumbnailUrlCount,
        trackCount: Number((dom && dom.trackCount) || 0),
        captionTrackCount: Number((dom && dom.captionTrackCount) || 0),
        transcriptLinkCount: Number((dom && dom.transcriptLinkCount) || 0)
      },
      audio: {
        hasAudioTag: Number((dom && dom.audioTagCount) || 0) > 0,
        audioTagCount: Number((dom && dom.audioTagCount) || 0),
        hasAudioObject: audioObjectCount > 0,
        audioObjectCount,
        audioEmbedCount: Number((dom && dom.audioEmbedCount) || 0),
        audioTranscriptLinkCount: Number((dom && dom.transcriptLinkCount) || 0)
      },
      general: {
        figureCount: Number((dom && dom.figureCount) || 0),
        figcaptionCount: Number((dom && dom.figcaptionCount) || 0),
        mediaAriaLabelCount: Number((dom && dom.mediaAriaLabelCount) || 0),
        mediaCaptionSamples: take(dom && dom.mediaCaptionSamples, 5)
      }
    };
  } catch (e) {
    return {
      checked: false,
      source: 'top_dom_head_meta_jsonld',
      errorMessage: String(e && (e.stack || e.message || e) || '').slice(0, 500)
    };
  }
}

// === [AIO][AUDIT_SIG v1] JSON-LD / コピーライト / head meta / ナビ導線 を集約するヘルパー ===
async function buildAuditSigFromPage(page) {
  // === [AIO][JSONLD_WAIT v1] JSON-LDの出現待ち＋状態を付けて probe をラップ ===
  async function probeJsonLdAndCopyrightWithWaitV1(page, opt){
    opt = opt || {};
    const T_MS = Number(opt.timeoutMs || 7000); // ★ 5〜8秒：まずは7秒
    const out = {
      jsonld_scan_started: false,
      jsonld_scan_finished: false,
      jsonld_parse_failed: false,
      consent_wall_suspected: false,
      jsonld_wait_ms: 0,

      // ★追加：同意クリックの試行結果（原因切り分け用）
      consent_click_tried: false,
      consent_click_succeeded: false
    };

    const t0 = Date.now();
    out.jsonld_scan_started = true;

    // 1) まず “出現待ち” をする（無ければ timeout）
    //    - type="application/ld+json" だけでなく、typeゆらぎや中身("@context"+"@type")でも拾う
    let selectorFound = false;
    try{
      await page.waitForFunction(() => {
        // 1) 正攻法：ld+json
        const ld = document.querySelector('script[type*="ld+json" i]');
        if (ld) return true;

        // 2) typeゆらぎ救済：type無し/別typeでも中身で判定（重くしない）
        const scripts = Array.from(document.querySelectorAll('script')).slice(0, 50);
        return scripts.some(s => {
          const t = String(s.getAttribute('type') || '').toLowerCase().trim();

          // JSONっぽいtype or type無しだけ対象（雑に広げすぎない）
          if (t && !(t.includes('json') || t.includes('ld+json'))) return false;

          const txt = String(s.textContent || '').trim();
          if (!txt) return false;

          // 最小条件：JSON-LDっぽいキーが両方ある
          return txt.includes('"@context"') && txt.includes('"@type"');
        });
      }, { timeout: T_MS });

      selectorFound = true;
    }catch(_){
      selectorFound = false;
    }
    out.jsonld_wait_ms = Date.now() - t0;

    // 2) consent wall 疑い（timeoutのときだけ軽く判定）
    if (!selectorFound){
      try{
        const htmlLower = String(await page.content() || '').toLowerCase();
        // 最小セット：cookie/同意/consent が濃いと疑う
        out.consent_wall_suspected =
          /cookie|consent|同意|クッキー|プライバシー|privacy/.test(htmlLower) &&
          /同意|accept|agree|consent|許可/.test(htmlLower);
      }catch(_){
        out.consent_wall_suspected = false;
      }
    }

    // 2.5) consent wall 疑いなら「同意操作」を1回だけ試してから再度 wait をやり直す
    //      - 成功したら selectorFound=true に寄せ、consent_wall_suspected も false に戻す
    if (!selectorFound && out.consent_wall_suspected){
      try{
        // よくある同意ボタン候補（最小セット）
        const clicked = await page.evaluate(() => {
          function clickByText(txt){
            const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
            const hit = els.find(el => {
              const t = (el.innerText || el.value || '').trim();
              return t && t.includes(txt);
            });
            if (hit){
              try{
                if (typeof hit.click === 'function') hit.click();
                else hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              }catch(_){}
              return true;
            }
            return false;
          }

          // 日本語/英語の最低限
          return (
            clickByText('同意') ||
            clickByText('許可') ||
            clickByText('OK') ||
            clickByText('Accept') ||
            clickByText('Agree')
          );
        });

        out.consent_click_tried = true;

        if (clicked){
          out.consent_click_succeeded = true;

          // クリック後の反映待ち
          await page.waitForTimeout(1200);

          // もう一回だけ “出現待ち” をやり直す（短めでOK）
          try{
            await page.waitForFunction(() => {
              const ld = document.querySelector('script[type*="ld+json" i]');
              if (ld) return true;

              const scripts = Array.from(document.querySelectorAll('script')).slice(0, 50);
              return scripts.some(s => {
                const t = String(s.getAttribute('type') || '').toLowerCase().trim();
                if (t && !(t.includes('json') || t.includes('ld+json'))) return false;
                const txt = String(s.textContent || '').trim();
                if (!txt) return false;
                return txt.includes('"@context"') && txt.includes('"@type"');
              });
            }, { timeout: Math.min(2500, T_MS) });

            selectorFound = true;
            out.consent_wall_suspected = false;
          }catch(_){
            // まだ見つからないなら従来どおり（suspected=true のまま）
          }
        }
      }catch(_){
        // 失敗しても従来どおり
      }
    }

    // 3) 既存プローブを実行（ここは既存資産を活かす）
    let jp = {};
    try{
      jp = await probeJsonLdAndCopyright(page);
    }catch(e){
      jp = { jsonld_scan_failed: true, jsonld_probe_err: String(e && (e.stack||e.message||e)) };
    }

    // 4) 状態を jp にマージして返す（snake_caseで揃える）
    //    - “出現待ちtimeout” が起きた場合のみ timed_out を真にする（雑な0件=timeoutを防ぐ）
    try{
      const detectCount = Number((jp && jp.jsonld_detect_count) || 0);
      const scanFailed  = !!(jp && jp.jsonld_scan_failed);

      jp = jp || {};
      jp.jsonld_scan_started = out.jsonld_scan_started;
      jp.jsonld_scan_finished = true;
      jp.jsonld_parse_failed = !!(jp && jp.jsonld_parse_failed); // 既存があれば尊重
      jp.consent_wall_suspected = out.consent_wall_suspected;
      jp.jsonld_wait_ms = out.jsonld_wait_ms;

      jp.consent_click_tried = out.consent_click_tried;
      jp.consent_click_succeeded = out.consent_click_succeeded;

      // ★ timeout判定は “出現待ち” 基準に統一
      //    - selectorが見つかったなら timed_out=false
      //    - 見つからず、かつ検出0で、scanFailedでないなら timed_out=true
      jp.jsonld_timed_out = (!selectorFound && !scanFailed && detectCount === 0 && out.consent_wall_suspected === true);
    }catch(_){}

    return jp;
  }

  // それぞれのヘルパーを並列で実行
  const [headMeta, jsonldProbe] = await Promise.all([
    extractHeadMetaV1(page),
    probeJsonLdAndCopyrightWithWaitV1(page, { timeoutMs: 7000 })
  ]);

  const hm = headMeta || {};
  const jp = jsonldProbe || {};

  // JSON-LD 関連
  const jsonldCount    = Number(jp.jsonld_detect_count || 0);
  const jsonldDetected = jsonldCount > 0;
  const jsonldTimedOut = (/application\/ld\+json/i.test(String(await page.content()||''))) ? !!jp.jsonld_timed_out : false;
  const jsonldTypesAll = Array.isArray(jp.jsonld_types_all)
    ? jp.jsonld_types_all
    : [];

  // ★ 追加：どこまで進んだか（永続未判定の原因切り分け用）
  const jsonldScanStarted   = !!jp.jsonld_scan_started;
  const jsonldScanFinished  = !!jp.jsonld_scan_finished;
  const jsonldParseFailed   = !!jp.jsonld_parse_failed;
  const consentWallSuspected = !!jp.consent_wall_suspected;
  const jsonldWaitMs        = Number(jp.jsonld_wait_ms || 0);

  // head/meta 関連（タイトル・description）
  const hasTitle            = !!hm.hasTitle;
  const hasMetaDescription  = !!hm.hasMetaDescription;
  const metaDescriptionLen  = Number(hm.metaDescriptionLen || 0);
  const metaDescriptionText = String(hm.metaDescriptionText || '');
  const titleText           = String(hm.titleText || '');

  // コピーライト関連
  const copyrightHit           = !!jp.copyright_hit;
  const copyrightExcerpt       = String(jp.copyright_excerpt || '');
  const copyrightFooterPresent = !!jp.copyright_footer_present;
  const copyrightHitToken      = String(jp.copyright_hit_token || '');

  // ★ SPA観測値（probe 側のラッチ結果を拾う）
  const hasMainLandmark = !!jp.hasMainLandmark;

  // probe 側が snake_case で返してくる想定（header_present / nav_count / h1_count）
  const headerPresent = !!jp.header_present;
  const footerPresent = !!jp.footer_present;
  const navCount      = Number(jp.nav_count || 0);
  const h1Count       = Number(jp.h1_count  || 0);

  // --- NEW: ナビ/フッターを含めた coverage 導線フラグ検出 ---
  let coverageNav = {
    hasCompanyNav: false,
    hasServiceNav: false,
    hasContactNav: false,
    hasFaqNav: false
  };

  try {
    const html = await page.content();
    const htmlStr   = String(html || '');
    const htmlLower = htmlStr.toLowerCase();

    function hasJP(re) {
      try { return re.test(htmlStr); }
      catch (_) { return false; }
    }

    function hasEN(re) {
      try { return re.test(htmlLower); }
      catch (_) { return false; }
    }

    // 会社情報 / 企業情報 / コーポレート系
    const hasCompanyNav =
      hasJP(/会社情報|会社概要|企業情報|企業概要|会社案内/) ||
      hasEN(/about\s+us|about\s+company|company(\s+(info|information|profile))?|corporate(\s+(profile|info))?/);

    // サービス / 事業内容 / ソリューション / 製品
    const hasServiceNav =
      hasJP(/サービス(一覧|紹介)?|事業内容|事業紹介|ソリューション|製品情報|プロダクト/) ||
      hasEN(/services|our\s+services|products|solutions/);

    // お問い合わせ / 資料請求 / CONTACT
    const hasContactNav =
      hasJP(/お問い合わせ|お問合せ|問合せ|お問い合せ|資料請求/) ||
      hasEN(/contact(\s+us)?/);

    // FAQ / よくある質問 / Q&A
    const hasFaqNav =
      hasJP(/FAQ|ＦＡＱ|よくある質問|よくあるご質問|Q＆A|Q&A/) ||
      hasEN(/\bfaq\b/);

    coverageNav = {
      hasCompanyNav: !!hasCompanyNav,
      hasServiceNav: !!hasServiceNav,
      hasContactNav: !!hasContactNav,
      hasFaqNav:     !!hasFaqNav
    };
  } catch (_) {
    // 失敗しても coverageNav はデフォルト(false)のまま
  }

  console.log('[AUDIT_SIG][coverageNav]', coverageNav);

  const traceId = `covnav|${(await page.url()).replace(/[#?].*$/,'').replace(/\/+$/,'')}|${Date.now()}`;

  console.log('[TRACE_COVNAV][NODE][auditSig-ready]', {
    traceId,
    url: await page.url(),
    coverageNav,
    htmlLen: (await page.content()).length
  });

  console.log(
    '[AUDIT_SIG][FINAL]',
    {
      url: await page.url(),
      hasMainLandmark_from_probe: jp.hasMainLandmark,
      hasMainLandmark_final: hasMainLandmark
    }
  );

  console.log('[AUDIT_SIG][HAS-SPA4]', { headerPresent, footerPresent, navCount, h1Count });

  let htmlLang = await page.evaluate(() => {
    const el = document.documentElement;
    return el ? (el.getAttribute('lang') || '') : '';
  });

  htmlLang = String(htmlLang || '').trim(); // ★ 正規化（空白やnullを潰す）

  return {
    // JSON-LD 周り
    jsonldDetected,
    jsonldCount,
    jsonldTimedOut,
    jsonldWaitMs,
    jsonldScanStarted,
    jsonldScanFinished,
    jsonldParseFailed,
    consentWallSuspected,
    jsonldSampleHead: String(jp.jsonld_sample_head || ''),
    jsonldTypes: jsonldTypesAll,

    // ★ main
    hasMainLandmark,

    // ★ header/footer
    headerPresent,
    footerPresent,
    navCount,
    h1Count,

    // ★ html lang（追加）
    htmlLang: htmlLang || '',
    hasHtmlLang: !!htmlLang,

    // head/meta 周り
    hasTitle,
    hasMetaDescription,
    metaDescriptionLen,
    metaDescriptionText,
    titleText,

    // コピーライト周り
    copyrightHit,
    copyrightExcerpt,
    copyrightFooterPresent,
    copyrightHitToken,

    // NEW: ナビ導線フラグ
    coverageNav
  };
}

// === [COV_NAV][DETECT v2] HTML から会社情報/サービス/お問い合わせ/FAQ 導線をざっくり検出 ===
function detectCoverageNavFromHtml_FOR_SCORING_ONLY(html) {
  try {
    html = String(html || '');
    if (!html) {
      return {
        hasCompanyNav: false,
        hasServiceNav: false,
        hasContactNav: false,
        hasFaqNav: false
      };
    }

    const htmlLower = html.toLowerCase();

    const hasJP = (re) => {
      try { return re.test(html); } catch (_) { return false; }
    };
    const hasEN = (re) => {
      try { return re.test(htmlLower); } catch (_) { return false; }
    };

    // 会社情報 / 企業情報 / コーポレート系
    const hasCompanyInfoLink =
      hasJP(/会社情報|会社概要|企業情報|企業概要|会社案内/) ||
      hasEN(/corporate\s+profile|corporate\s+info|about\s+us|about\s+company/);

    // サービス / 事業内容 / ソリューション / 製品
    const hasServicePageLink =
      hasJP(/サービス(一覧|紹介)?|事業内容|事業紹介|ソリューション|製品情報|プロダクト/) ||
      hasEN(/services|our\s+services|products|solutions/);

    // お問い合わせ / 資料請求 / CONTACT
    const hasContactLink =
      hasJP(/お問い合わせ|お問合せ|問合せ|お問い合せ|資料請求/) ||
      hasEN(/contact\s*us|contact/);

    // 採用情報 / CAREER
    const hasRecruitLink =
      hasJP(/採用情報|求人情報|キャリア採用|新卒採用|中途採用/) ||
      hasEN(/careers?|recruit/);

    // FAQ / よくある質問
    const hasFaqLink =
      hasJP(/FAQ|ＦＡＱ|よくある質問|よくあるご質問|Q＆A|Q&A/) ||
      hasEN(/faq/);

      const flags = {
        hasCompanyNav: !!hasCompanyInfoLink,
        hasServiceNav: !!hasServicePageLink,
        hasContactNav: !!hasContactLink,
        hasFaqNav:     !!hasFaqLink
      };

    try {
      console.log('[COV_NAV][FLAGS]', flags);
    } catch (_) {}

    return flags;
  } catch (e) {
    try {
      console.warn('[COV_NAV][ERR]', e);
    } catch (_) {}

    return {
      hasCompanyInfoLink: false,
      hasServicePageLink: false,
      hasContactLink: false,
      hasRecruitLink: false,
      hasFaqLink: false
    };
  }
}

const playwright = require('playwright');
// === minimal Playwright scrape (QUALITY MODE) ===
async function playScrapeMinimal(url) {
  const browser = await playwright.chromium.launch({
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage({ javaScriptEnabled: true });

  // 画像・フォント・メディアはブロック（テキスト優先で高速化）
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image','font','media'].includes(t)) return route.abort();
    return route.continue();
  });

  // 1) 初期ロード（DOM完成）→ ネットワーク静穏を1回待つ
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch(_) {}

  // ★ここに追加
  const metaDescription = await page.evaluate(() => {
    const el =
      document.querySelector('meta[name="description"]') ||
      document.querySelector('meta[property="og:description"]') ||
      document.querySelector('meta[name="twitter:description"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  });

  // 2) SPAレンダ待ち（候補セレクタ）
  const waitSelectors = ['main', '#app', '[id*="root"]', 'body'];
  for (const sel of waitSelectors) {
    try { await page.waitForSelector(sel, { timeout: 6000 }); break; } catch (_) {}
  }

  // 3) 遅延読込対策：自動スクロール（下のヘルパを後で追加します）
  try { await autoScroll(page, { step: 1200, pauseMs: 300, maxScrolls: 8 }); } catch (_) {}

  // 4) スクリプト後レンダ対策：再度 networkidle を短く
  try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch(_) {}

  // 5) 十分な本文長になるまで“しつこく待つ” （質優先）
  //    閾値は 600 文字に上げます（以前は 200）
  const THRESH = 600;
  try {
    await page.waitForFunction(
      (n) => document.body && document.body.innerText && document.body.innerText.length > n,
      { timeout: 12000 },
      THRESH
    );
  } catch (_) {
    // ここは妥協点。超えなくても続行。
  }

  // 6) 抽出
  const fullHtml = await page.content();
  const innerText = await page.evaluate(() => (document.body?.innerText || '').trim());
  const jsonldRaw = await page.$$eval(
    'script[type="application/ld+json"]',
    nodes => nodes.map(n => n.textContent).filter(Boolean)
  );

  // ★ coverage ナビ導線フラグ（会社情報・サービス・お問い合わせなど）
  const coverageNavFlags = detectCoverageNavFromHtml_FOR_SCORING_ONLY(fullHtml);

  // ★ 互換：GAS側が hasCompanyNav 等を見る場合に備えて“同義キー”も用意（既存を壊さない）
  const coverageNavCompat = (function(){
    try{
      const f = coverageNavFlags || {};
      // すでに hasCompanyNav 形式ならそのまま
      if (typeof f.hasCompanyNav === 'boolean' ||
          typeof f.hasServiceNav === 'boolean' ||
          typeof f.hasContactNav === 'boolean' ||
          typeof f.hasFaqNav === 'boolean') {
        return f;
      }
      // FOR_SCORING_ONLY が hasCompanyInfoLink 形式ならマップする
      return {
        hasCompanyNav: !!f.hasCompanyInfoLink,
        hasServiceNav: !!f.hasServicePageLink,
        hasContactNav: !!f.hasContactLink,
        hasFaqNav:     !!f.hasFaqLink
      };
    }catch(_){
      return coverageNavFlags || { hasCompanyNav:false, hasServiceNav:false, hasContactNav:false, hasFaqNav:false };
    }
  })();

  // JSON-LD パース
  const jsonld = [];
  for (const t of jsonldRaw) {
    try { const j = JSON.parse(t); Array.isArray(j) ? jsonld.push(...j) : jsonld.push(j); }
    catch (_) {}
  }

  await browser.close();

  return {
    innerText,
    html: fullHtml,
    jsonld,

    // ★ 互換キーも返す
    metaDescription,                  // ← page.evaluate で取ったやつ
    coverageNav: coverageNavCompat,   // ← GAS互換（hasCompanyNav形式）
    coverageNavRaw: coverageNavFlags, // ← 元の検出結果（デバッグ/後方互換）

    // ★ SSOT：下流がどこを見ても拾えるようにここに入れる
    facts: {
      auditSig: {
        coverageNav: coverageNavCompat,     // ← “互換の正” を入れるのが安全
        coverageNavRaw: coverageNavFlags    // ← 元も残すならここにも
      }
    },

    waitStrategy:'quality:domcontentloaded→networkidle→autoscroll→networkidle→len>600',
    blockedResources:['image','font','media'],
    fallbackJsonld:{}
  };
}

// === scrape adapter (FIX v3: signals) ===
/**
 * 役割：
 * - /scrape が返す bodyText/html を最優先で拾う
 * - それでも innerText が空なら、cheerio で HTML→本文を復元
 * - JSON-LD はなければ HTML から抽出
 */
async function scrapeForScoring(url) {
  const r = (typeof playScrapeMinimal === 'function')
    ? await playScrapeMinimal(url)
    : await yourExistingScrape(url);

  let innerText = r.innerText || r.bodyText || r.text || '';
  const fullHtml = r.html || r.fullHtml || '';

  // 既存 /scrape の bodyText が内文より長い場合は優先して採用
  const altText = r.bodyText || '';
  if (altText.length > innerText.length) innerText = altText;

  // innerText が空なら HTML→本文復元
  if ((!innerText || innerText.length === 0) && fullHtml) {
    try {
      const $ = cheerio.load(fullHtml);
      innerText = $('body').text().replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    } catch (_) {}
  }

  // --- 追加：DOMシグナル抽出（根拠用） ---
  let h1 = 0, h2 = 0, lists = 0, tables = 0, links = 0;
  let hasTel = false, hasAddress = false;
  let jsonldArr = Array.isArray(r.jsonld) ? r.jsonld : [];

  if (fullHtml) {
    try {
      const $ = cheerio.load(fullHtml);
      h1 = $('h1').length;
      h2 = $('h2').length;
      lists = $('ul,ol').length;
      tables = $('table').length;
      links = $('a[href]').length;

      // JSON-LD 抽出（なければ）
      if (!jsonldArr || jsonldArr.length === 0) {
        jsonldArr = $('script[type="application/ld+json"]').toArray().flatMap(n => {
          const t = $(n).text();
          try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch { return []; }
        });
      }
    } catch (_) {}
  }

  // 連絡先の簡易検出（日本語サイト向け・HTMLテキストも併用）
  try {
    const $all = fullHtml ? cheerio.load(fullHtml) : null;
    const htmlText = $all ? $all('body').text() : '';
    // innerText + HTMLテキストを結合して判定
    const joined = ((innerText || '') + ' ' + (htmlText || '')).trim();

    // 全角→半角、全角ハイフン→半角
    const z2hMap = { '０': '0', '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '－': '-', 'ー': '-', '―': '-' };
    const norm = joined.replace(/[０-９ー―－]/g, ch => z2hMap[ch] || ch).replace(/\s+/g, ' ').trim();

    // 電話番号（国内パターンを緩めに網羅）
    const telRe = /(TEL[:：]?\s*)?(\(0\d{1,4}\)|0\d{1,4})[\s-]?\d{1,4}[\s-]?\d{3,4}/i;
    hasTel = telRe.test(norm);

    // 住所（郵便番号 or 都道府県名）
    const zipRe = /(〒?\s*\d{3}-\d{4})/;
    const prefRe = /(北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県)/;
    hasAddress = zipRe.test(norm) || prefRe.test(norm);

    // デバッグしやすいようにサンプルも保持
    var innerTextSample = norm.slice(0, 160);
  } catch (e) {
    console.warn('[adapter] contact regex failed:', e && e.message ? e.message : e);
  }

  // === [SITE-FACTS-LITE v1] 汎用の “存在事実” を抽出して auditSig に保存 ===
  // 目的: LLMの推測で「採用がない/OGPがない/更新日がない/実績がない」等の嘘カードが出るのを恒久的に防ぐ
  let __siteFactsLite = null;
    try{
      const __html = String(fullHtml || '');
      const __text = String(innerText || '');

      // meta: OGP/Twitter
      const __og = (__html.match(/<meta[^>]+property=["']og:/ig) || []).length;
      const __tw = (__html.match(/<meta[^>]+name=["']twitter:/ig) || []).length;
      const __ogpDetected = (__og + __tw) > 0;

      // links: 採用/実績/お知らせ/FAQ の導線（href とテキスト両方で汎用検知）
      const __hrefs = Array.from(__html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/ig)).map(m=>String(m[1]||''));
      const __aTexts = Array.from(__html.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/ig)).map(m=>String(m[1]||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());

      const __H = (' ' + __hrefs.join(' ') + ' ').toLowerCase();
      const __T = (' ' + __aTexts.join(' ') + ' ').toLowerCase();

      const __hasRecruit = /\/recruit\b|\/career\b|\/jobs?\b/.test(__H) || /(採用|求人|キャリア)/.test(__T);
      const __hasWorks   = /\/case\b|\/works\b|\/portfolio\b/.test(__H) || /(実績|事例|works|case|portfolio)/.test(__T);
      const __hasNews    = /\/information\b|\/news\b|\/press\b|\/info\b/.test(__H) || /(お知らせ|ニュース|press|information)/.test(__T);
      const __hasFaq     = /\/faq\b/.test(__H) || /(faq|よくある質問)/.test(__T);

      // sections: 日付シグナル（ニュース欄や更新日らしき表示）
      const __dateRe = /(\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})|(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/g;
      const __dates = Array.from(new Set((__text.match(__dateRe) || []).map(s=>String(s).trim()))).slice(0,20);

      // sections: 実績件数の目安（liの繰り返し or "role=listitem"）
      const __roleListitem = (__html.match(/role=["']listitem["']/ig) || []).length;
      const __liCount = (__html.match(/<li\b/ig) || []).length;
      const __worksCount = Math.max(__roleListitem, __liCount);

      __siteFactsLite = {
        meta: { ogCount: __og, twCount: __tw, ogpDetected: __ogpDetected },
        links: { hasRecruit: __hasRecruit, hasWorks: __hasWorks, hasNews: __hasNews, hasFaq: __hasFaq },
        sections: { dates: __dates, worksCount: __worksCount }
      };

      // ★ auditSig にマージ（SSOTに残すのが目的）
      try{
        r.facts = r.facts || {};
        r.facts.auditSig = r.facts.auditSig || {};
        r.facts.auditSig.siteFactsLite = __siteFactsLite;

        // 互換用ショートフラグ（後段のカード制御が書きやすい）
        r.facts.auditSig.hasOgpMetaLite       = !!__ogpDetected;
        r.facts.auditSig.hasRecruitLinkLite   = !!__hasRecruit;
        r.facts.auditSig.hasWorksLinkLite     = !!__hasWorks;
        r.facts.auditSig.hasNewsLinkLite      = !!__hasNews;
        r.facts.auditSig.newsDatesCountLite   = __dates.length;
        r.facts.auditSig.worksCountLite       = __worksCount;
      }catch(_){}

      // ★ 保険：auditSig の直下にも同じものを持たせる（取り回し差異に負けない）
      try{
        r.auditSig = r.auditSig || {};
        if (r.auditSig.siteFactsLite === undefined) r.auditSig.siteFactsLite = __siteFactsLite;

        if (r.auditSig.hasOgpMetaLite       === undefined) r.auditSig.hasOgpMetaLite       = !!__ogpDetected;
        if (r.auditSig.hasRecruitLinkLite   === undefined) r.auditSig.hasRecruitLinkLite   = !!__hasRecruit;
        if (r.auditSig.hasWorksLinkLite     === undefined) r.auditSig.hasWorksLinkLite     = !!__hasWorks;
        if (r.auditSig.hasNewsLinkLite      === undefined) r.auditSig.hasNewsLinkLite      = !!__hasNews;
        if (r.auditSig.newsDatesCountLite   === undefined) r.auditSig.newsDatesCountLite   = __dates.length;
        if (r.auditSig.worksCountLite       === undefined) r.auditSig.worksCountLite       = __worksCount;
      }catch(_){}
    }catch(e){
    // 抽出に失敗してもスクレイプ自体は継続（空でよい）
    __siteFactsLite = null;
  }
  // === [SITE-FACTS-LITE v1] ここまで ===

  const signals = {
    h1, h2, lists, tables, links,
    hasTel, hasAddress,
    jsonldTypes: (jsonldArr || []).map(x => x && x['@type']).filter(Boolean)
  };

  return {
    fromScrape: true,
    hydrated: (innerText && innerText.length > 600) ? true : false,
    innerTextLen: innerText ? innerText.length : 0,
    fullHtmlLen: fullHtml ? fullHtml.length : 0,
    jsonld: jsonldArr,
    waitStrategy: r.waitStrategy || 'main|#app|[id*=root]',
    blockedResources: r.blockedResources || ['font','media'],
    facts: r.facts || {},
    fallbackJsonld: r.fallbackJsonld || {},
    signals,                      // ← 既存ならOK
    innerTextSample: (innerText || '').slice(0, 160), // ← 追加
  };
}

// -------------------- CORS --------------------
app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// -------------------- ヘルス --------------------
app.get('/', (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));
app.get('/health', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// 軽量ヘルスチェック（RSS を見るとメモリ傾向を掴みやすい）
app.get('/healthz', (_, res) => {
  const m = process.memoryUsage();
  res.status(200).json({ ok: true, rss: m.rss, heapUsed: m.heapUsed });
});

// -------------------- Subpage JSON-LD light batch --------------------
function normalizeSubpageJsonLdText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSubpageJsonLdType(value) {
  return normalizeSubpageJsonLdText(value).replace(/^https?:\/\/schema\.org\//i, '');
}

function isBlockedSubpageJsonLdHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal')) return true;
  if (/metadata/i.test(host) && /(google|cloud|aws|azure|instance|internal)/i.test(host)) return true;
  if (host === '169.254.169.254') return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map(n => Number(n));
    if (parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const a = parts[0];
    const b = parts[1];
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^fc|^fd/i.test(host)) return true;
  if (/^fe[89ab]/i.test(host)) return true;
  return false;
}

function collectSubpageJsonLdTypes(node, out, depth = 0) {
  if (!node || depth > 10) return;
  if (Array.isArray(node)) {
    node.forEach(item => collectSubpageJsonLdTypes(item, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;
  const typeValue = node['@type'];
  const types = Array.isArray(typeValue) ? typeValue : (typeValue ? [typeValue] : []);
  types.forEach(type => {
    const normalized = normalizeSubpageJsonLdType(type);
    if (normalized) out.push(normalized);
  });
  if (Array.isArray(node['@graph'])) {
    node['@graph'].forEach(item => collectSubpageJsonLdTypes(item, out, depth + 1));
  }
  Object.keys(node).forEach(key => {
    if (key === '@graph' || key === '@type') return;
    const value = node[key];
    if (value && typeof value === 'object') collectSubpageJsonLdTypes(value, out, depth + 1);
  });
}

function countSubpageJsonLdTypes(types) {
  const counts = {};
  (Array.isArray(types) ? types : []).forEach(type => {
    const normalized = normalizeSubpageJsonLdType(type);
    if (!normalized) return;
    counts[normalized] = (counts[normalized] || 0) + 1;
  });
  return counts;
}

function isLegalOperatorCandidateText_(value) {
  return /特定商取引法に基づく(?:表示|表記)|特定商取引に関する表記|特定商取引|特商法|商取引|販売者情報|販売業者|legal\s*notice|act\s+on\s+specified\s+commercial\s+transactions/i.test(String(value || ''));
}

function isLegalOperatorCandidatePath_(value) {
  const path = (() => {
    try { return new URL(String(value || '')).pathname.toLowerCase(); } catch (_) { return String(value || '').toLowerCase(); }
  })();
  return /\/(?:policies\/legal-notice|legal-notice|legal|law|commercial-transactions|specified-commercial-transactions|tokushoho)(?:\/|$|-|_)/i.test(path);
}

function inferLegalOperatorPageType_(url, title, h1Texts) {
  const hay = [
    url,
    title,
    ...(Array.isArray(h1Texts) ? h1Texts : [])
  ].map(v => String(v || '')).join(' ');
  return isLegalOperatorCandidatePath_(url) || isLegalOperatorCandidateText_(hay) ? 'legal' : '';
}

function inferSiteModeForRepresentativeObservation_(topUrl, explicitMode) {
  const mode = normalizeSubpageJsonLdText(explicitMode).toLowerCase();
  if (mode && mode !== 'generic' && mode !== 'unknown') return mode;
  try {
    const parsed = new URL(String(topUrl || ''));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/^(store|shop)\./.test(host) || /\.(store|shop)\./.test(host)) return 'ec';
    if (/\/(?:products?|collections?|cart|checkout|item|items)(?:\/|$|-|_)/i.test(path)) return 'ec';
  } catch (_) {}
  return mode || 'generic';
}

function extractLegalOperatorInfoFromHtml_(html, sourceUrl, meta = {}) {
  const empty = {
    observed: false,
    pageType: 'legal',
    sourceUrl: String(sourceUrl || ''),
    operatorName: '',
    address: '',
    telephone: '',
    hasOperatorName: false,
    hasAddress: false,
    hasTelephone: false,
    hasOperatorInfo: false,
    extractionMethod: 'html_text',
    evidenceLabels: []
  };
  try {
    const $ = cheerio.load(String(html || ''));
    const title = normalizeSubpageJsonLdText((meta && meta.title) || $('title').first().text());
    const h1Texts = Array.isArray(meta && meta.h1Texts) ? meta.h1Texts : $('h1').map((_, el) => normalizeSubpageJsonLdText($(el).text())).get();
    const pageHay = [sourceUrl, title].concat(h1Texts).join(' ');
    if (!isLegalOperatorCandidatePath_(sourceUrl) && !isLegalOperatorCandidateText_(pageHay)) return empty;

    const canonicalLabel = (value, kind = '') => {
      const text = normalizeSubpageJsonLdText(value);
      if (!text) return '';
      if (/事業者名/.test(text)) return '事業者名';
      if (/販売業者/.test(text)) return '販売業者';
      if (/運営会社/.test(text)) return '運営会社';
      if (/本社所在地/.test(text)) return '本社所在地';
      if (/所在地/.test(text)) return '所在地';
      if (/住所/.test(text)) return '住所';
      if (/お客様相談室/.test(text)) return 'お客様相談室';
      if (/電話番号/.test(text)) return '電話番号';
      if (/連絡先/.test(text)) return '連絡先';
      if (kind === 'operator' && /会社名/.test(text)) return '会社名';
      return '';
    };
    const operatorStopRe = /運営統括責任者|責任者|本社所在地|所在地|住所|連絡先|電話番号|お客様相談室|販売価格|商品代金|送料|支払方法/;
    const addressStopRe = /連絡先|電話番号|お客様相談室|販売価格|商品代金|送料|支払方法|返品|交換|キャンセル|引渡|配送/;
    const genericStopRe = /事業者名|販売業者|運営会社|会社名|本社所在地|所在地|住所|連絡先|電話番号|お客様相談室|販売価格|商品代金|送料|支払方法/;
    const cutAt = (value, stopRe) => normalizeSubpageJsonLdText(value).split(stopRe)[0] || '';
    const stripLeadingLabel = (value, kind) => {
      const text = normalizeSubpageJsonLdText(value);
      const labelRe = kind === 'operator'
        ? /^(?:事業者名|販売業者|運営会社|販売者|会社名)\s*[：:：]?\s*/
        : (kind === 'address'
            ? /^(?:本社所在地|所在地|住所)\s*[：:：]?\s*/
            : /^(?:連絡先|電話番号|電話|TEL|Tel|お客様相談室)\s*[：:：]?\s*/);
      return normalizeSubpageJsonLdText(text.replace(labelRe, ''));
    };
    const normalizePhone = v => normalizeSubpageJsonLdText(v)
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .replace(/[ー‐‑‒–—−]/g, '-')
      .replace(/[（）]/g, m => (m === '（' ? '(' : ')'))
      .replace(/\s+/g, '');
    const extractJapanesePhone = value => {
      const text = normalizePhone(value);
      if (/[A-Za-z]/.test(text)) return '';
      const match = text.match(/(?:0120-\d{2,4}-\d{3,4}|0\d{1,4}-\d{1,4}-\d{3,4}|0\d{9,10})/);
      return match ? match[0] : '';
    };
    const extractJapaneseAddress = value => {
      const text = cutAt(stripLeadingLabel(value, 'address'), addressStopRe);
      const match = text.match(/〒?\s?\d{3}[-‐‑‒–—]?\d{4}\s*(?:北海道|東京都|(?:京都|大阪)府|..県).{0,80}/);
      return normalizeSubpageJsonLdText(match ? match[0] : text).slice(0, 160);
    };
    const cleanOperatorName = value => {
      const text = cutAt(stripLeadingLabel(value, 'operator'), operatorStopRe);
      return normalizeSubpageJsonLdText(text).slice(0, 80);
    };

    const rows = [];
    $('tr').each((_, el) => {
      const cells = $(el).find('th,td').map((__, cell) => normalizeSubpageJsonLdText($(cell).text())).get().filter(Boolean);
      if (cells.length >= 2) rows.push({ label: cells[0], value: cells.slice(1).join(' ') });
    });
    $('dt').each((_, el) => {
      const label = normalizeSubpageJsonLdText($(el).text());
      const value = normalizeSubpageJsonLdText($(el).next('dd').text());
      if (label && value) rows.push({ label, value });
    });
    const bodyClone = $('body').clone();
    bodyClone.find('script,style,noscript,svg').remove();
    bodyClone.find('br,p,div,li,tr,dt,dd,th,td,section,article').append('\n');
    const visibleLines = bodyClone.text()
      .split(/\n+/)
      .map(line => normalizeSubpageJsonLdText(line))
      .filter(Boolean);

    const labelValueFromText = (labelRe, kind) => {
      for (const row of rows) {
        const label = canonicalLabel(row.label, kind);
        if (label && labelRe.test(row.label) && row.value) {
          if (kind === 'telephone' && !extractJapanesePhone(row.value)) continue;
          return { value: row.value, label };
        }
      }
      for (let i = 0; i < visibleLines.length; i++) {
        const line = visibleLines[i];
        const label = canonicalLabel(line, kind);
        if (!label || !labelRe.test(line)) continue;
        const afterLabel = normalizeSubpageJsonLdText(line.replace(new RegExp(`^.*?${label}\\s*[：:：]?\\s*`), ''));
        const value = afterLabel && !genericStopRe.test(afterLabel)
          ? afterLabel
          : normalizeSubpageJsonLdText(visibleLines[i + 1] || '');
        if (kind === 'telephone' && !extractJapanesePhone(value)) continue;
        if (value) return { value, label };
      }
      return { value: '', label: '' };
    };

    const operator = labelValueFromText(/販売業者|事業者名|運営会社|会社名/i, 'operator');
    const address = labelValueFromText(/所在地|住所|本社所在地/i, 'address');
    const telephone = labelValueFromText(/電話番号|電話|TEL|Tel|連絡先|お客様相談室/i, 'telephone');

    const out = Object.assign({}, empty, {
      operatorName: operator.value ? cleanOperatorName(operator.value) : '',
      address: address.value ? extractJapaneseAddress(address.value) : '',
      telephone: telephone.value ? extractJapanesePhone(telephone.value) : ''
    });
    if (out.operatorName && operator.label) out.evidenceLabels.push(operator.label);
    if (out.address && address.label) out.evidenceLabels.push(address.label);
    if (out.telephone && telephone.label) out.evidenceLabels.push(telephone.label);
    out.hasOperatorName = !!out.operatorName;
    out.hasAddress = !!out.address;
    out.hasTelephone = !!out.telephone;
    out.hasOperatorInfo = out.hasAddress && out.hasTelephone;
    out.observed = out.hasOperatorName || out.hasOperatorInfo;
    out.evidenceLabels = Array.from(new Set(out.evidenceLabels.filter(Boolean))).slice(0, 10);
    return out;
  } catch (_) {
    return empty;
  }
}

function inferSubpageJsonLdPageType(url, siteMode, jsonldTypes) {
  const typeSet = new Set((Array.isArray(jsonldTypes) ? jsonldTypes : []).map(type => normalizeSubpageJsonLdType(type).toLowerCase()));
  const path = (() => {
    try { return new URL(String(url || '')).pathname.toLowerCase(); } catch (_) { return String(url || '').toLowerCase(); }
  })();
  if (isLegalOperatorCandidatePath_(url)) return 'legal';
  if (typeSet.has('product') || typeSet.has('offer')) return 'product';
  if (typeSet.has('faqpage')) return 'faq';
  if (typeSet.has('article') || typeSet.has('newsarticle') || typeSet.has('blogposting')) return 'article';
  if (typeSet.has('breadcrumblist')) return 'category_or_detail';
  if (/\/(?:faq|faqs|guide|guides|help|support)(?:\/|$|-|_)/i.test(path)) return 'faq';
  if (/\/(?:product|products|item|items)(?:\/|$|-|_)/i.test(path)) return 'product';
  if (/\/(?:category|categories|collections|collection)(?:\/|$|-|_)/i.test(path)) return 'category';
  return siteMode === 'ec' && /\/collections?\//i.test(path) ? 'category' : 'unknown';
}

function normalizeArticleSignalText_(value, maxLen = 240) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const s = normalizeArticleSignalText_(item, maxLen);
      if (s) return s;
    }
    return '';
  }
  if (typeof value === 'object') {
    return normalizeArticleSignalText_(value.name || value.headline || value['@id'] || value.url || value.text || value.value || '', maxLen);
  }
  return '';
}

function normalizeArticleSignalUrl_(value, baseUrl, maxLen = 320) {
  const raw = normalizeArticleSignalText_(value, maxLen);
  if (!raw) return '';
  try { return new URL(raw, baseUrl || undefined).toString().slice(0, maxLen); } catch (_) { return raw.slice(0, maxLen); }
}

function normalizeArticleSignalArray_(value, maxItems = 10, maxLen = 120) {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = normalizeArticleSignalText_(v, maxLen);
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(value)) value.forEach(add);
  else if (typeof value === 'string') value.split(/[,、，]/).forEach(add);
  else if (value != null) add(value);
  return out.slice(0, maxItems);
}

function articleJsonLdTypes_(node) {
  const raw = node && typeof node === 'object' ? node['@type'] || node.type : null;
  return (Array.isArray(raw) ? raw : [raw])
    .map(type => normalizeSubpageJsonLdType(type))
    .filter(Boolean);
}

function isArticleJsonLdNode_(node) {
  return articleJsonLdTypes_(node).some(type => /^(Article|NewsArticle|BlogPosting)$/i.test(type));
}

function collectArticleJsonLdNodes_(node, out, depth = 0) {
  if (!node || depth > 8 || out.length >= 20) return;
  if (Array.isArray(node)) {
    node.slice(0, 80).forEach(item => collectArticleJsonLdNodes_(item, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;
  if (isArticleJsonLdNode_(node)) out.push(node);
  if (Array.isArray(node['@graph'])) node['@graph'].slice(0, 80).forEach(item => collectArticleJsonLdNodes_(item, out, depth + 1));
  ['mainEntity', 'mainEntityOfPage', 'itemListElement'].forEach(key => {
    if (node[key]) collectArticleJsonLdNodes_(node[key], out, depth + 1);
  });
}

function extractArticleMetaFromCheerio_($) {
  const clean = (v, maxLen = 240) => normalizeArticleSignalText_(v, maxLen);
  const metaOne = (selector, attr = 'content', maxLen = 240) => clean($(selector).first().attr(attr) || '', maxLen);
  const metaAll = (selector, attr = 'content') => $(selector).map((_, el) => clean($(el).attr(attr) || '', 120)).get().filter(Boolean).slice(0, 10);
  const tags = metaAll('meta[property="article:tag" i]');
  normalizeArticleSignalArray_(metaOne('meta[name="keywords" i]', 'content', 500), 10, 120).forEach(tag => {
    if (!tags.includes(tag) && tags.length < 10) tags.push(tag);
  });
  return {
    publishedTime: metaOne('meta[property="article:published_time" i]'),
    modifiedTime: metaOne('meta[property="article:modified_time" i]'),
    author: metaOne('meta[property="article:author" i]') || metaOne('meta[name="author" i]'),
    section: metaOne('meta[property="article:section" i]'),
    tags
  };
}

function buildArticleSignalsFromJsonLdAndMeta_(jsonLdItems, meta, baseUrl) {
  const items = Array.isArray(jsonLdItems) ? jsonLdItems : [];
  const articleNodes = [];
  items.forEach(item => collectArticleJsonLdNodes_(item, articleNodes, 0));
  const articleNode = articleNodes[0] || null;
  const types = Array.from(new Set(articleNodes.reduce((acc, node) => acc.concat(articleJsonLdTypes_(node)), []))).slice(0, 10);
  const hasType = (name) => types.some(type => new RegExp('^' + name + '$', 'i').test(type));
  const author = articleNode && Array.isArray(articleNode.author) ? articleNode.author[0] : (articleNode && articleNode.author);
  const publisher = articleNode && Array.isArray(articleNode.publisher) ? articleNode.publisher[0] : (articleNode && articleNode.publisher);
  const publisherLogo = publisher && typeof publisher === 'object'
    ? (publisher.logo && typeof publisher.logo === 'object' ? (publisher.logo.url || publisher.logo['@id']) : publisher.logo)
    : '';
  const mainEntity = articleNode && articleNode.mainEntityOfPage;
  const metaObj = meta && typeof meta === 'object' ? meta : {};
  const jsonLd = {
    hasArticleJsonLd: items.length ? hasType('Article') : null,
    hasNewsArticleJsonLd: items.length ? hasType('NewsArticle') : null,
    hasBlogPostingJsonLd: items.length ? hasType('BlogPosting') : null,
    types,
    headline: normalizeArticleSignalText_(articleNode && (articleNode.headline || articleNode.name), 240) || null,
    datePublished: normalizeArticleSignalText_(articleNode && articleNode.datePublished, 80) || null,
    dateModified: normalizeArticleSignalText_(articleNode && articleNode.dateModified, 80) || null,
    authorName: normalizeArticleSignalText_(author && (typeof author === 'object' ? author.name : author), 160) || null,
    authorType: normalizeArticleSignalText_(author && typeof author === 'object' ? author['@type'] : '', 80) || null,
    publisherName: normalizeArticleSignalText_(publisher && (typeof publisher === 'object' ? publisher.name : publisher), 160) || null,
    publisherType: normalizeArticleSignalText_(publisher && typeof publisher === 'object' ? publisher['@type'] : '', 80) || null,
    publisherLogo: normalizeArticleSignalUrl_(publisherLogo, baseUrl, 320) || null,
    mainEntityOfPage: normalizeArticleSignalUrl_(mainEntity && typeof mainEntity === 'object' ? (mainEntity['@id'] || mainEntity.url) : mainEntity, baseUrl, 320) || null,
    articleSection: normalizeArticleSignalText_(articleNode && articleNode.articleSection, 120) || null,
    articleTags: normalizeArticleSignalArray_(articleNode && (articleNode.keywords || articleNode.articleTag), 10, 120)
  };
  const metaOut = {
    publishedTime: normalizeArticleSignalText_(metaObj.publishedTime, 80) || null,
    modifiedTime: normalizeArticleSignalText_(metaObj.modifiedTime, 80) || null,
    author: normalizeArticleSignalText_(metaObj.author, 160) || null,
    section: normalizeArticleSignalText_(metaObj.section, 120) || null,
    tags: normalizeArticleSignalArray_(metaObj.tags, 10, 120)
  };
  const hasMeta = !!(metaOut.publishedTime || metaOut.modifiedTime || metaOut.author || metaOut.section || metaOut.tags.length);
  return {
    checked: items.length > 0 || hasMeta,
    source: {
      jsonLd: articleNodes.length > 0,
      meta: hasMeta
    },
    jsonLd,
    meta: metaOut,
    summary: {
      hasArticleType: types.length ? true : (items.length ? false : null),
      hasHeadline: !!jsonLd.headline,
      hasPublishedDate: !!(jsonLd.datePublished || metaOut.publishedTime),
      hasModifiedDate: !!(jsonLd.dateModified || metaOut.modifiedTime),
      hasAuthor: !!(jsonLd.authorName || metaOut.author),
      hasPublisher: !!jsonLd.publisherName
    }
  };
}

async function collectArticleSignalsFromPageLight_(page, baseUrl) {
  try {
    if (!page || typeof page.evaluate !== 'function') return buildArticleSignalsFromJsonLdAndMeta_([], {}, baseUrl);
    const data = await page.evaluate(() => {
      const clean = (v, max = 240) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
      const jsonLdItems = [];
      Array.from(document.querySelectorAll('script[type*="ld+json" i]')).slice(0, 20).forEach(script => {
        const raw = String(script.textContent || '').trim();
        if (!raw) return;
        try { jsonLdItems.push(JSON.parse(raw)); } catch (_) {}
      });
      const metaOne = (selector, attr = 'content', max = 240) => {
        const el = document.querySelector(selector);
        return el ? clean(el.getAttribute(attr) || '', max) : '';
      };
      const tags = Array.from(document.querySelectorAll('meta[property="article:tag" i]'))
        .map(el => clean(el.getAttribute('content') || '', 120))
        .filter(Boolean)
        .slice(0, 10);
      const keywords = metaOne('meta[name="keywords" i]', 'content', 500)
        .split(/[,、，]/)
        .map(v => clean(v, 120))
        .filter(Boolean);
      keywords.forEach(tag => { if (!tags.includes(tag) && tags.length < 10) tags.push(tag); });
      return {
        jsonLdItems,
        meta: {
          publishedTime: metaOne('meta[property="article:published_time" i]'),
          modifiedTime: metaOne('meta[property="article:modified_time" i]'),
          author: metaOne('meta[property="article:author" i]') || metaOne('meta[name="author" i]'),
          section: metaOne('meta[property="article:section" i]'),
          tags
        }
      };
    });
    return buildArticleSignalsFromJsonLdAndMeta_(data && data.jsonLdItems, data && data.meta, baseUrl);
  } catch (_) {
    return buildArticleSignalsFromJsonLdAndMeta_([], {}, baseUrl);
  }
}

function parseSubpageJsonLdLightHtml(url, finalUrl, status, html, siteMode) {
  const $ = cheerio.load(String(html || ''));
  const title = normalizeSubpageJsonLdText($('title').first().text()).slice(0, 180);
  const canonicalRaw = normalizeSubpageJsonLdText($('link[rel~="canonical" i]').first().attr('href') || '');
  let canonical = canonicalRaw;
  if (canonicalRaw) {
    try { canonical = new URL(canonicalRaw, finalUrl || url).toString(); } catch (_) {}
  }
  const h1Texts = [];
  $('h1').each((_, el) => {
    const text = normalizeSubpageJsonLdText($(el).text());
    if (text && !h1Texts.includes(text) && h1Texts.length < 5) h1Texts.push(text.slice(0, 180));
  });
  const jsonldTypes = [];
  const jsonLdItems = [];
  let parseErrors = 0;
  $('script[type*="ld+json" i]').each((_, el) => {
    const raw = String($(el).contents().text() || $(el).html() || '').trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      jsonLdItems.push(parsed);
      collectSubpageJsonLdTypes(parsed, jsonldTypes, 0);
    } catch (_) {
      parseErrors += 1;
    }
  });
  const uniqueTypes = Array.from(new Set(jsonldTypes.filter(Boolean))).slice(0, 50);
  const jsonldTypeCounts = countSubpageJsonLdTypes(jsonldTypes);
  const lowerTypes = new Set(uniqueTypes.map(type => normalizeSubpageJsonLdType(type).toLowerCase()));
  const legalPageType = inferLegalOperatorPageType_(finalUrl || url, title, h1Texts);
  const breadcrumbSelector = [
    'nav[aria-label*="breadcrumb" i]',
    '[aria-label*="パンくず"]',
    '[class*="breadcrumb" i]',
    '[id*="breadcrumb" i]',
    '[class*="breadcrumbs" i]',
    '[id*="breadcrumbs" i]',
    '[class*="pankuzu" i]',
    '[id*="pankuzu" i]'
  ].join(',');
  let hasBreadcrumbUi = $(breadcrumbSelector).length > 0;
  if (!hasBreadcrumbUi) {
    $('nav, ol, ul, div').slice(0, 200).each((_, el) => {
      if (hasBreadcrumbUi) return;
      const attrs = [
        $(el).attr('class'),
        $(el).attr('id'),
        $(el).attr('aria-label')
      ].map(v => normalizeSubpageJsonLdText(v).toLowerCase()).join(' ');
      const text = normalizeSubpageJsonLdText($(el).text()).slice(0, 120);
      if (/(breadcrumb|breadcrumbs|pankuzu)/i.test(attrs) || /パンくず/.test(attrs) || /パンくず/.test(text)) {
        hasBreadcrumbUi = true;
      }
    });
  }
  const bodyClone = $('body').first().clone();
  bodyClone.find('script,style,noscript,svg,nav,footer').remove();
  const sampledText = normalizeSubpageJsonLdText(bodyClone.text()).slice(0, 500);
  const bodyTextLength = normalizeSubpageJsonLdText($('body').first().text()).length;
  const legalOperatorInfo = legalPageType === 'legal'
    ? extractLegalOperatorInfoFromHtml_(html, finalUrl || url, { title, h1Texts })
    : null;
  const articleSignals = buildArticleSignalsFromJsonLdAndMeta_(jsonLdItems, extractArticleMetaFromCheerio_($), finalUrl || url);
  let internalLinkCount = 0;
  let externalLinkCount = 0;
  $('a[href]').slice(0, 1200).each((_, el) => {
    try {
      const href = $(el).attr('href') || '';
      if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href)) return;
      const linkUrl = new URL(href, finalUrl || url);
      const baseUrl = new URL(finalUrl || url);
      if (linkUrl.origin === baseUrl.origin) internalLinkCount += 1;
      else externalLinkCount += 1;
    } catch (_) {}
  });
  return {
    url,
    finalUrl: finalUrl || url,
    status,
    ok: true,
    pageType: legalPageType || inferSubpageJsonLdPageType(finalUrl || url, siteMode, uniqueTypes),
    title,
    canonical,
    h1Count: $('h1').length,
    h1Texts,
    jsonldTypes: uniqueTypes,
    jsonldTypeCounts,
    breadcrumbListCount: Number(jsonldTypeCounts.BreadcrumbList || 0),
    listItemCount: Number(jsonldTypeCounts.ListItem || 0),
    hasBreadcrumbJsonLd: lowerTypes.has('breadcrumblist'),
    hasProductJsonLd: lowerTypes.has('product') || lowerTypes.has('offer'),
    hasFaqJsonLd: lowerTypes.has('faqpage'),
    hasArticleJsonLd: lowerTypes.has('article') || lowerTypes.has('newsarticle'),
    hasBlogPostingJsonLd: lowerTypes.has('blogposting'),
    hasBreadcrumbUi,
    hasMain: $('main,[role="main"]').length > 0,
    hasMainLandmark: $('main,[role="main"]').length > 0,
    internalLinkCount,
    externalLinkCount,
    bodyTextLength,
    sampledText,
    legalOperatorInfo,
    articleSignals,
    error: null,
    parseErrors
  };
}

async function fetchSubpageHtmlLight(url, opts = {}) {
  const buildFetchError = (stage, error, meta) => {
    const cause = error && error.cause ? error.cause : null;
    const parts = [];
    const add = (key, value, limit) => {
      if (value === null || value === undefined || value === '') return;
      parts.push(`${key}=${String(value).slice(0, limit || 160)}`);
    };
    add('stage', stage, 40);
    add('url', url, 180);
    add('name', error && error.name, 80);
    add('message', error && error.message, 180);
    add('code', error && error.code, 80);
    add('causeName', cause && cause.name, 80);
    add('causeCode', cause && cause.code, 80);
    add('causeMessage', cause && cause.message, 180);
    add('reason', meta && meta.reason, 120);
    add('status', meta && meta.status, 40);
    if (meta && typeof meta.redirected === 'boolean') add('redirected', meta.redirected, 20);
    add('finalUrl', meta && meta.finalUrl, 180);
    return (parts.join(' | ') || 'html_fetch_failed').slice(0, 700);
  };
  const emptyHtmlFetchResult = (finalUrl, status, error, errorStage) => ({
    url,
    finalUrl: finalUrl || url,
    status: typeof status === 'number' ? status : null,
    ok: false,
    pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
    title: '',
    canonical: '',
    h1Count: 0,
    h1Texts: [],
    jsonldTypes: [],
    hasBreadcrumbJsonLd: false,
    hasBreadcrumbUi: false,
    error,
    errorStage,
    observationSource: 'html-fetch-light',
    observationMethod: 'html_fetch_light'
  });
  try {
    const initialUrl = new URL(String(url || ''));
    if (isBlockedSubpageJsonLdHost(initialUrl.hostname)) {
      return emptyHtmlFetchResult(url, null, 'blocked_private_or_metadata_host', 'precheck');
    }
    let response = null;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      });
    } catch (e) {
      return emptyHtmlFetchResult(url, null, buildFetchError('fetch', e), 'fetch');
    }
    const status = response && typeof response.status === 'number' ? response.status : null;
    const finalUrl = response && response.url ? response.url : url;
    const responseMeta = {
      status,
      redirected: !!(response && response.redirected),
      finalUrl
    };
    let finalParsed = null;
    try { finalParsed = new URL(String(finalUrl || '')); } catch (_) {}
    if (finalParsed && finalParsed.origin !== initialUrl.origin) {
      return emptyHtmlFetchResult(finalUrl, status, buildFetchError('fetch', null, Object.assign({}, responseMeta, {
        reason: 'redirect_origin_mismatch'
      })), 'fetch');
    }
    if (!response || !response.ok) {
      return emptyHtmlFetchResult(finalUrl, status, buildFetchError('fetch', null, Object.assign({}, responseMeta, {
        reason: status ? `HTTP ${status}` : 'fetch_failed'
      })), 'fetch');
    }
    const contentType = String(response.headers && response.headers.get && response.headers.get('content-type') || '');
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
      return emptyHtmlFetchResult(finalUrl, status, buildFetchError('fetch', null, Object.assign({}, responseMeta, {
        reason: `unsupported_content_type:${contentType.slice(0, 80)}`
      })), 'fetch');
    }
    let html = '';
    try {
      html = String(await response.text() || '').slice(0, 2 * 1024 * 1024);
    } catch (e) {
      return emptyHtmlFetchResult(finalUrl, status, buildFetchError('response_text', e, responseMeta), 'response_text');
    }
    try {
      return Object.assign(parseSubpageJsonLdLightHtml(url, finalUrl, status, html, opts.siteMode), {
        observationSource: 'html-fetch-light',
        observationMethod: 'html_fetch_light',
        errorStage: null
      });
    } catch (e) {
      return emptyHtmlFetchResult(finalUrl, status, buildFetchError('parse', e, responseMeta), 'parse');
    }
  } catch (e) {
    return emptyHtmlFetchResult(url, null, buildFetchError('fetch', e), 'fetch');
  }
}

async function fetchSubpageHtmlLightUrls_(urls, opts = {}) {
  const pages = [];
  for (const url of (Array.isArray(urls) ? urls : [])) {
    pages.push(await fetchSubpageHtmlLight(url, opts));
  }
  return { pages };
}

async function fetchSubpagePlaywrightScopedLight(url, opts = {}) {
  const context = opts && opts.context;
  const debugHeavySite = opts && opts.debugHeavySite === true;
  const emitScopedAudit = (phase, details = {}) => {
    if (!debugHeavySite) return;
    try {
      console.log('[DEBUG][HEAVY_SITE_INVESTIGATION_AUDIT]', JSON.stringify({
        phase,
        route: '/scrape',
        url,
        finalUrl: details.finalUrl || null,
        elapsedMs: Number(details.elapsedMs || 0),
        memory: typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : null,
        details
      }));
    } catch (_) {}
  };
  const emitScopedExtractionAudit = (phase, details = {}) => {
    if (!debugHeavySite) return;
    try {
      console.log('[DEBUG][SCOPED_PLAYWRIGHT_EXTRACTION_AUDIT]', JSON.stringify(Object.assign({
        phase,
        url,
        finalUrl: details && details.finalUrl || null
      }, details || {})));
    } catch (_) {}
  };
  const emitScopedBodyEmptyAudit = (details = {}) => {
    if (!debugHeavySite) return;
    try {
      console.log('[DEBUG][SCOPED_PLAYWRIGHT_BODY_EMPTY_AUDIT]', JSON.stringify(Object.assign({
        url,
        finalUrl: details && details.finalUrl || null
      }, details || {})));
    } catch (_) {}
  };
  let page = null;
  const pageStartedAt = Date.now();
  try {
    emitScopedAudit('scoped_page_start', { targetUrl: url });
    if (!context || typeof context.newPage !== 'function') {
      emitScopedAudit('scoped_page_done', {
        targetUrl: url,
        elapsedMs: Math.max(0, Date.now() - pageStartedAt),
        error: 'playwright_scoped_light_context_unavailable'
      });
      return {
        url,
        finalUrl: url,
        status: null,
        ok: false,
        pageType: inferSubpageJsonLdPageType(url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        h2Sample: [],
        jsonldTypes: [],
        jsonLdCount: 0,
        hasBreadcrumbJsonLd: false,
        hasBreadcrumbUi: false,
        hasMain: false,
        hasMainLandmark: false,
        internalLinkCount: 0,
        externalLinkCount: 0,
        bodyTextLength: 0,
        sampledText: '',
        error: 'playwright_scoped_light_context_unavailable',
        observationSource: 'playwright-scoped-light',
        observationMethod: 'playwright_scoped_light'
      };
    }
    page = await context.newPage();
    let response = null;
    try {
      const gotoStartedAt = Date.now();
      emitScopedAudit('scoped_goto_start', { targetUrl: url });
      response = await page.goto(url, {
        waitUntil: 'commit',
        timeout: Math.max(1000, Math.min(8000, Number(opts.timeout || 8000) || 8000))
      });
      emitScopedAudit('scoped_goto_end', {
        targetUrl: url,
        finalUrl: typeof page.url === 'function' ? page.url() || url : url,
        status: response && typeof response.status === 'function' ? response.status() : null,
        elapsedMs: Math.max(0, Date.now() - gotoStartedAt)
      });
    } catch (e) {
      const gotoError = String(e && (e.message || e) || 'playwright_scoped_light_goto_failed').slice(0, 240);
      emitScopedAudit('scoped_goto_end', {
        targetUrl: url,
        finalUrl: typeof page.url === 'function' ? page.url() || url : url,
        elapsedMs: Math.max(0, Date.now() - pageStartedAt),
        error: gotoError
      });
      emitScopedAudit('scoped_page_done', {
        targetUrl: url,
        finalUrl: typeof page.url === 'function' ? page.url() || url : url,
        elapsedMs: Math.max(0, Date.now() - pageStartedAt),
        error: gotoError
      });
      return {
        url,
        finalUrl: typeof page.url === 'function' ? page.url() || url : url,
        status: null,
        ok: false,
        pageType: inferSubpageJsonLdPageType(url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        h2Sample: [],
        jsonldTypes: [],
        jsonLdCount: 0,
        hasBreadcrumbJsonLd: false,
        hasBreadcrumbUi: false,
        hasMain: false,
        hasMainLandmark: false,
        internalLinkCount: 0,
        externalLinkCount: 0,
        bodyTextLength: 0,
        sampledText: '',
        error: String(e && (e.message || e) || 'playwright_scoped_light_goto_failed').slice(0, 240),
        observationSource: 'playwright-scoped-light',
        observationMethod: 'playwright_scoped_light'
      };
    }
    const status = response && typeof response.status === 'function' ? response.status() : null;
    const finalUrl = typeof page.url === 'function' ? page.url() || url : url;
    const extractStartedAt = Date.now();
    emitScopedAudit('scoped_extract_start', { targetUrl: url, finalUrl, status });
    emitScopedExtractionAudit('extract_start', { finalUrl, status });
    const observed = await page.evaluate(() => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = el => {
        try {
          if (!el || !el.getBoundingClientRect) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        } catch (_) {
          return true;
        }
      };
      const pickText = selector => Array.from(document.querySelectorAll(selector))
        .filter(isVisible)
        .map(el => clean(el.textContent).slice(0, 180))
        .filter(Boolean);
      const safeText = el => clean(el && (el.innerText || el.textContent));
      const visibleText = el => (isVisible(el) ? safeText(el) : '');
      const body = document.body;
      const bodyText = clean(body && (body.textContent || ''));
      const bodyInnerText = clean(body && (body.innerText || ''));
      const bodyChildren = body ? body.children.length : 0;
      const mainEls = Array.from(document.querySelectorAll('main')).filter(isVisible);
      const articleEls = Array.from(document.querySelectorAll('article')).filter(isVisible);
      const roleMainEls = Array.from(document.querySelectorAll('[role="main"]')).filter(isVisible);
      const navEls = Array.from(document.querySelectorAll('nav,[role="navigation"]')).filter(isVisible);
      const footerEls = Array.from(document.querySelectorAll('footer,[role="contentinfo"]')).filter(isVisible);
      const h1Els = Array.from(document.querySelectorAll('h1')).filter(isVisible);
      const h2Els = Array.from(document.querySelectorAll('h2')).filter(isVisible);
      const linkEls = Array.from(document.querySelectorAll('a[href]')).filter(isVisible);
      const visibleTextParts = [];
      [mainEls, articleEls, roleMainEls, navEls, footerEls, h1Els, h2Els].forEach(list => {
        list.slice(0, 10).forEach(el => {
          const text = visibleText(el);
          if (text) visibleTextParts.push(text.slice(0, 500));
        });
      });
      const visibleTextLength = clean(visibleTextParts.join(' ')).length;
      const mainText = clean(mainEls.map(visibleText).join(' '));
      const articleText = clean(articleEls.map(visibleText).join(' '));
      const roleMainText = clean(roleMainEls.map(visibleText).join(' '));
      let selectedTextSource = 'none';
      let selectedTextRejectedReason = '';
      if (mainText.length >= 80) selectedTextSource = 'main';
      else if (articleText.length >= 80) selectedTextSource = 'article';
      else if (roleMainText.length >= 80) selectedTextSource = 'role_main';
      else if (visibleTextLength >= 80) {
        selectedTextSource = 'visible_scoped';
        selectedTextRejectedReason = 'main_article_role_main_text_too_short';
      } else {
        selectedTextRejectedReason = 'no_scoped_visible_text';
      }
      let sameOriginLinks = 0;
      let navLinks = 0;
      let footerLinks = 0;
      const linkSamples = [];
      linkEls.slice(0, 250).forEach(a => {
        try {
          const link = new URL(a.getAttribute('href') || '', location.href);
          if (link.origin === location.origin) {
            sameOriginLinks += 1;
            if (linkSamples.length < 5) linkSamples.push({ text: clean(a.textContent).slice(0, 80), href: link.pathname });
          }
          if (a.closest('nav,[role="navigation"],header')) navLinks += 1;
          if (a.closest('footer,[role="contentinfo"]')) footerLinks += 1;
        } catch (_) {}
      });
      const selectedInternalLinkCount = navLinks || footerLinks || sameOriginLinks;
      const rejectedLinkReason = selectedInternalLinkCount ? '' : 'no_visible_same_origin_links';
      const h1TextsForAudit = h1Els.map(el => clean(el.textContent).slice(0, 120)).filter(Boolean).slice(0, 5);
      const h2TextsForAudit = h2Els.map(el => clean(el.textContent).slice(0, 120)).filter(Boolean).slice(0, 5);
      const selectedH1 = h1TextsForAudit[0] || '';
      const selectedHeadingSource = selectedH1 ? 'dom_h1' : (h2TextsForAudit[0] ? 'dom_h2' : 'none');
      const rejectedHeadingReason = selectedHeadingSource === 'none' ? 'no_visible_h1_h2' : '';
      let shadowHostCount = 0;
      let shadowTextLength = 0;
      let shadowH1Count = 0;
      let shadowLinkCount = 0;
      let shadowJsonLdCount = 0;
      try {
        const walkShadow = (root, depth = 0) => {
          if (!root || depth > 3 || shadowHostCount > 40) return;
          const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
          nodes.slice(0, 300).forEach(el => {
            if (!el) return;
            if (el.shadowRoot) {
              shadowHostCount += 1;
              const text = clean(el.shadowRoot.textContent || '');
              shadowTextLength += Math.min(1000, text.length);
              walkShadow(el.shadowRoot, depth + 1);
            }
            const tag = String(el.tagName || '').toLowerCase();
            if (tag === 'h1') shadowH1Count += 1;
            if (tag === 'a' && el.getAttribute && el.getAttribute('href')) shadowLinkCount += 1;
            if (tag === 'script' && /ld\+json/i.test(String(el.getAttribute && el.getAttribute('type') || ''))) shadowJsonLdCount += 1;
          });
        };
        walkShadow(document, 0);
      } catch (_) {}
      const jsonldTypes = [];
      const collectTypes = (node, depth = 0) => {
        if (!node || depth > 4) return;
        if (Array.isArray(node)) {
          node.slice(0, 50).forEach(item => collectTypes(item, depth + 1));
          return;
        }
        if (typeof node !== 'object') return;
        const type = node['@type'];
        if (Array.isArray(type)) type.slice(0, 10).forEach(item => jsonldTypes.push(String(item || '').trim()));
        else if (type) jsonldTypes.push(String(type || '').trim());
        if (Array.isArray(node['@graph'])) node['@graph'].slice(0, 50).forEach(item => collectTypes(item, depth + 1));
      };
      Array.from(document.querySelectorAll('script[type*="ld+json" i]')).slice(0, 20).forEach(script => {
        try { collectTypes(JSON.parse(script.textContent || ''), 0); } catch (_) {}
      });
      const canonicalRaw = document.querySelector('link[rel~="canonical" i]')?.getAttribute('href') || '';
      let canonical = canonicalRaw;
      try { if (canonicalRaw) canonical = new URL(canonicalRaw, location.href).toString(); } catch (_) {}
      const metaDescription = clean(document.querySelector('meta[name="description" i]')?.getAttribute('content') || '').slice(0, 240);
      const head = document.head;
      const docEl = document.documentElement;
      const htmlOuter = String(docEl && docEl.outerHTML || '');
      const htmlHeadSample = clean(htmlOuter.slice(0, 300));
      const scripts = Array.from(document.querySelectorAll('script'));
      const scriptSrcs = scripts.map(script => script.getAttribute('src') || '').filter(Boolean);
      const sameOriginScriptCount = scriptSrcs.filter(src => {
        try { return new URL(src, location.href).origin === location.origin; } catch (_) { return false; }
      }).length;
      const moduleScriptCount = scripts.filter(script => String(script.getAttribute('type') || '').toLowerCase() === 'module').length;
      const metaRefresh = document.querySelector('meta[http-equiv="refresh" i]');
      const robotsMeta = document.querySelector('meta[name="robots" i]')?.getAttribute('content') || '';
      const cspMeta = document.querySelector('meta[http-equiv="content-security-policy" i]');
      const bodyDirectTagSample = Array.from(body && body.children || [])
        .slice(0, 10)
        .map(el => String(el && el.tagName || '').toLowerCase())
        .filter(Boolean);
      const appRoots = {
        next: !!document.querySelector('#__next'),
        app: !!document.querySelector('#app'),
        root: !!document.querySelector('#root'),
        nuxt: !!document.querySelector('[data-nuxt]'),
        reactroot: !!document.querySelector('[data-reactroot]')
      };
      const noscriptTextLength = clean(Array.from(document.querySelectorAll('noscript')).map(el => el.textContent || '').join(' ')).length;
      const textNodes = Array.from(document.querySelectorAll('main,article,[role="main"]'))
        .filter(isVisible)
        .slice(0, 8)
        .map(el => {
          try {
            el.querySelectorAll('script,style,iframe,noscript,svg,canvas,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
          } catch (_) {}
          return clean(el.textContent).slice(0, 1500);
        })
        .filter(Boolean);
      const scopedText = textNodes.join(' ').slice(0, 5000);
      let internalLinkCount = 0;
      let externalLinkCount = 0;
      Array.from(document.querySelectorAll('nav a[href],footer a[href]')).slice(0, 250).forEach(a => {
        try {
          if (!isVisible(a)) return;
          const link = new URL(a.getAttribute('href') || '', location.href);
          if (link.origin === location.origin) internalLinkCount += 1;
          else externalLinkCount += 1;
        } catch (_) {}
      });
      return {
        title: clean(document.title).slice(0, 180),
        canonical,
        metaDescription,
        h1Texts: pickText('h1').slice(0, 5),
        h2Sample: pickText('h2').slice(0, 5),
        jsonldTypes: Array.from(new Set(jsonldTypes.filter(Boolean))).slice(0, 50),
        hasBreadcrumbUi: !!document.querySelector('[aria-label*="breadcrumb" i], nav[class*="breadcrumb" i], .breadcrumb, [class*="breadcrumb" i]'),
        hasMain: !!document.querySelector('main,article,[role="main"]'),
        internalLinkCount,
        externalLinkCount,
        bodyTextLength: scopedText.length,
        sampledText: scopedText.slice(0, 500),
        scopedAudit: {
          domProbe: {
            titleLength: clean(document.title).length,
            bodyChildCount: bodyChildren,
            bodyTextLength: bodyText.length,
            bodyInnerTextLength: bodyInnerText.length,
            visibleTextLength,
            mainCount: mainEls.length,
            articleCount: articleEls.length,
            roleMainCount: roleMainEls.length,
            navCount: navEls.length,
            footerCount: footerEls.length,
            h1Count: h1Els.length,
            h2Count: h2Els.length,
            linkCount: linkEls.length,
            shadowHostCount
          },
          textProbe: {
            mainTextLength: mainText.length,
            articleTextLength: articleText.length,
            roleMainTextLength: roleMainText.length,
            bodyTextLength: bodyText.length,
            visibleTextSampleLength: Math.min(200, clean(visibleTextParts.join(' ')).length),
            sampledTextLength: scopedText.slice(0, 500).length,
            selectedTextSource,
            selectedTextRejectedReason
          },
          linkProbe: {
            totalLinks: linkEls.length,
            sameOriginLinks,
            navLinks,
            footerLinks,
            selectedInternalLinkCount,
            rejectedLinkReason,
            linkSamples
          },
          headingProbe: {
            h1Texts: h1TextsForAudit,
            h2TextsSample: h2TextsForAudit,
            domH1Count: h1Els.length,
            domH2Count: h2Els.length,
            roleHeadingCountIfAlreadyAvailable: 0,
            selectedH1,
            selectedHeadingSource,
            rejectedHeadingReason
          },
          shadowProbe: {
            shadowHostCount,
            shadowTextLength,
            shadowH1Count,
            shadowLinkCount,
            shadowJsonLdCount
          },
          bodyEmptyAudit: {
            documentReadyState: document.readyState || '',
            documentContentType: document.contentType || '',
            documentElementOuterHTMLLengthCapped: Math.min(htmlOuter.length, 200000),
            documentElementOuterHTMLLengthOverCap: htmlOuter.length > 200000,
            headChildCount: head ? head.children.length : 0,
            bodyExists: !!body,
            bodyChildCount: bodyChildren,
            bodyInnerHTMLLength: String(body && body.innerHTML || '').length,
            bodyTextContentLength: bodyText.length,
            appRoots,
            scriptCount: scripts.length,
            scriptSrcCount: scriptSrcs.length,
            sameOriginScriptCount,
            moduleScriptCount,
            noscriptTextLength,
            metaRefresh: !!metaRefresh,
            metaRefreshContent: metaRefresh ? String(metaRefresh.getAttribute('content') || '').slice(0, 160) : '',
            canonical,
            robotsMeta: String(robotsMeta || '').slice(0, 160),
            hasCspMeta: !!cspMeta,
            bodyDirectTagSample,
            htmlHeadSample
          }
        }
      };
    }).catch(e => ({
      title: '',
      canonical: '',
      metaDescription: '',
      h1Texts: [],
      h2Sample: [],
      jsonldTypes: [],
      hasBreadcrumbUi: false,
      hasMain: false,
      internalLinkCount: 0,
      externalLinkCount: 0,
      bodyTextLength: 0,
      sampledText: '',
      error: String(e && (e.message || e) || 'playwright_scoped_light_extract_failed').slice(0, 240),
      scopedAudit: null
    }));
    const scopedAudit = observed && observed.scopedAudit || {};
    emitScopedExtractionAudit('dom_probe', Object.assign({ finalUrl }, scopedAudit.domProbe || {}));
    emitScopedExtractionAudit('text_probe', Object.assign({ finalUrl }, scopedAudit.textProbe || {}));
    emitScopedExtractionAudit('link_probe', Object.assign({ finalUrl }, scopedAudit.linkProbe || {}));
    emitScopedExtractionAudit('heading_probe', Object.assign({ finalUrl }, scopedAudit.headingProbe || {}));
    emitScopedExtractionAudit('shadow_probe', Object.assign({ finalUrl }, scopedAudit.shadowProbe || {}));
    emitScopedBodyEmptyAudit(Object.assign({
      finalUrl,
      status
    }, scopedAudit.bodyEmptyAudit || {}));
    const qualityInputs = {
      hasTitle: !!normalizeSubpageJsonLdText(observed && observed.title),
      hasH1: Array.isArray(observed && observed.h1Texts) && observed.h1Texts.length > 0,
      hasBodyText: Number(observed && observed.bodyTextLength || 0) >= 100,
      hasJsonLd: Array.isArray(observed && observed.jsonldTypes) && observed.jsonldTypes.length > 0,
      hasLinks: Number(observed && observed.internalLinkCount || 0) > 0
    };
    const reasonIfWeak = qualityInputs.hasTitle && !qualityInputs.hasH1 && !qualityInputs.hasBodyText && !qualityInputs.hasJsonLd && !qualityInputs.hasLinks
      ? 'title_only'
      : (!qualityInputs.hasBodyText ? 'body_text_missing_or_short' : '');
    emitScopedExtractionAudit('extraction_decision', {
      finalUrl,
      observationMethod: 'playwright_scoped_light',
      ok: !observed.error,
      qualityInputs,
      selectedTextSource: scopedAudit.textProbe && scopedAudit.textProbe.selectedTextSource || 'unknown',
      selectedHeadingSource: scopedAudit.headingProbe && scopedAudit.headingProbe.selectedHeadingSource || 'unknown',
      selectedLinkSource: scopedAudit.linkProbe && scopedAudit.linkProbe.selectedInternalLinkCount ? 'visible_same_origin_links' : 'none',
      reasonIfWeak
    });
    emitScopedAudit('scoped_extract_end', {
      targetUrl: url,
      finalUrl,
      status,
      titleLength: String(observed && observed.title || '').length,
      h1Count: Array.isArray(observed && observed.h1Texts) ? observed.h1Texts.length : 0,
      bodyTextLength: Number(observed && observed.bodyTextLength || 0),
      elapsedMs: Math.max(0, Date.now() - extractStartedAt),
      error: observed && observed.error || null
    });
    emitScopedExtractionAudit('extract_end', {
      finalUrl,
      status,
      elapsedMs: Math.max(0, Date.now() - extractStartedAt),
      titleLength: String(observed && observed.title || '').length,
      h1Count: Array.isArray(observed && observed.h1Texts) ? observed.h1Texts.length : 0,
      bodyTextLength: Number(observed && observed.bodyTextLength || 0),
      internalLinkCount: Number(observed && observed.internalLinkCount || 0),
      error: observed && observed.error || null
    });
    const uniqueTypes = Array.from(new Set((observed.jsonldTypes || []).map(type => normalizeSubpageJsonLdType(type)).filter(Boolean))).slice(0, 50);
    const lowerTypes = new Set(uniqueTypes.map(type => type.toLowerCase()));
    const jsonldTypeCounts = countSubpageJsonLdTypes(uniqueTypes);
    const result = {
      url,
      finalUrl,
      status,
      ok: !observed.error,
      pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, uniqueTypes),
      title: normalizeSubpageJsonLdText(observed.title).slice(0, 180),
      canonical: observed.canonical || '',
      metaDescription: normalizeSubpageJsonLdText(observed.metaDescription).slice(0, 240),
      h1Count: Array.isArray(observed.h1Texts) ? observed.h1Texts.length : 0,
      h1Texts: Array.isArray(observed.h1Texts) ? observed.h1Texts.slice(0, 5) : [],
      h2Sample: Array.isArray(observed.h2Sample) ? observed.h2Sample.slice(0, 5) : [],
      jsonldTypes: uniqueTypes,
      jsonLdCount: uniqueTypes.length,
      jsonldTypeCounts,
      hasBreadcrumbJsonLd: lowerTypes.has('breadcrumblist'),
      hasBreadcrumbUi: observed.hasBreadcrumbUi === true,
      hasMain: observed.hasMain === true,
      hasMainLandmark: observed.hasMain === true,
      internalLinkCount: Number(observed.internalLinkCount || 0),
      externalLinkCount: Number(observed.externalLinkCount || 0),
      bodyTextLength: Number(observed.bodyTextLength || 0),
      sampledText: normalizeSubpageJsonLdText(observed.sampledText).slice(0, 500),
      scopedExtractionSource: 'playwright_scoped_light',
      scopedTextSource: scopedAudit.textProbe && scopedAudit.textProbe.selectedTextSource || '',
      scopedHeadingSource: scopedAudit.headingProbe && scopedAudit.headingProbe.selectedHeadingSource || '',
      scopedLinkSource: scopedAudit.linkProbe && scopedAudit.linkProbe.selectedInternalLinkCount ? 'visible_same_origin_links' : '',
      scopedWeakReason: reasonIfWeak || '',
      error: observed.error || null,
      observationSource: 'playwright-scoped-light',
      observationMethod: 'playwright_scoped_light'
    };
    emitScopedAudit('scoped_page_done', {
      targetUrl: url,
      finalUrl,
      status,
      ok: result.ok,
      titleLength: String(result.title || '').length,
      h1Count: result.h1Count,
      bodyTextLength: result.bodyTextLength,
      elapsedMs: Math.max(0, Date.now() - pageStartedAt),
      error: result.error || null
    });
    return result;
  } catch (e) {
    emitScopedAudit('scoped_page_done', {
      targetUrl: url,
      elapsedMs: Math.max(0, Date.now() - pageStartedAt),
      error: String(e && (e.message || e) || 'playwright_scoped_light_failed').slice(0, 240)
    });
    return {
      url,
      finalUrl: url,
      status: null,
      ok: false,
      pageType: inferSubpageJsonLdPageType(url, opts.siteMode, []),
      title: '',
      canonical: '',
      h1Count: 0,
      h1Texts: [],
      h2Sample: [],
      jsonldTypes: [],
      jsonLdCount: 0,
      hasBreadcrumbJsonLd: false,
      hasBreadcrumbUi: false,
      hasMain: false,
      hasMainLandmark: false,
      internalLinkCount: 0,
      externalLinkCount: 0,
      bodyTextLength: 0,
      sampledText: '',
      error: String(e && (e.message || e) || 'playwright_scoped_light_failed').slice(0, 240),
      observationSource: 'playwright-scoped-light',
      observationMethod: 'playwright_scoped_light'
    };
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

function isSubpageHtmlLightObservationSufficient_(page) {
  if (!page || page.ok !== true) return false;
  const hasTitle = !!normalizeSubpageJsonLdText(page.title);
  const hasH1 = Number(page.h1Count || 0) > 0 || (Array.isArray(page.h1Texts) && page.h1Texts.length > 0);
  const hasJsonLd = (Array.isArray(page.jsonldTypes) && page.jsonldTypes.length > 0) ||
    Number(page.jsonLdCount || page.jsonldCount || page.deepJsonLdScriptCount || 0) > 0;
  const bodyTextLength = Number(page.bodyTextLength || 0);
  const internalLinkCount = Number(page.internalLinkCount || 0);
  const hasEnoughText = bodyTextLength >= 300;
  const hasStrongLinks = internalLinkCount >= 5;
  return hasTitle && hasEnoughText && (hasH1 || hasJsonLd || hasStrongLinks);
}

function isSubpageHtmlLightTlsSslFailure_(page) {
  if (!page || page.ok === true) return false;
  const text = [
    page.error,
    page.errorMessage,
    page.errorCode,
    page.causeCode,
    page.causeMessage,
    page.errorStage
  ].map(value => String(value || '')).join(' ');
  return /ERR_SSL_UNSAFE_LEGACY_RENEGOTIATION_DISABLED|(?:^|\b)(?:SSL|TLS)(?:\b|_)/i.test(text);
}

function normalizeDiscoverSubpageUrl(rawUrl, origin) {
  let parsed = null;
  try { parsed = new URL(String(rawUrl || ''), origin); } catch (_) { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (origin && parsed.origin !== origin) return null;
  parsed.hash = '';
  parsed.search = '';
  const path = parsed.pathname || '/';
  const lowerPath = path.toLowerCase();
  if (isBlockedSubpageJsonLdHost(parsed.hostname)) return null;
  if (lowerPath === '/' || lowerPath === '') return null;
  if (/\.(?:jpe?g|png|gif|webp|svg|ico|pdf|css|js|zip|csv|xlsx?|docx?|pptx?|xml)(?:$|\/)/i.test(lowerPath)) return null;
  if (/\/(?:wp-json|feed)(?:\/|$)/i.test(lowerPath)) return null;
  if (/\/(?:tag|category|author|page)\//i.test(lowerPath)) return null;
  return parsed.toString().replace(/\/$/, '');
}

function discoverSubpageCandidateKey(url) {
  try {
    const u = new URL(String(url || ''));
    return (u.origin + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return String(url || '').replace(/\/$/, '').toLowerCase();
  }
}

function isDiscoverImportantPath(path) {
  return /\/(?:about|company|corporate|profile|business|service|services|solution|solutions|works|case|cases|news|topics|blog|column|contact|inquiry|recruit|career|privacy|policy|ai_policy|faq|access|sitemap|legal-notice|legal|law|commercial-transactions|specified-commercial-transactions|tokushoho)(?:\/|$|-|_)/i.test(String(path || ''));
}

function isDiscoverDetailLikePath(path) {
  const p = String(path || '').toLowerCase();
  if (/\/(?:case|cases|works|news|topics|blog|column)\/.+/i.test(p)) return true;
  if (/\/\d{4}\/\d{1,2}(?:\/|$)/.test(p)) return true;
  if (/(?:\/|[-_])\d{3,}(?:\.html)?$/i.test(p)) return true;
  if (/\/[^/]+\.html$/i.test(p) && !/\/index\.html$/i.test(p) && p.split('/').filter(Boolean).length >= 2) return true;
  return false;
}

function isDiscoverArticleCandidatePath_(value) {
  let path = '';
  try { path = new URL(String(value || '')).pathname.toLowerCase(); } catch (_) { path = String(value || '').toLowerCase(); }
  return /\/(?:post|posts|article|articles|news|topics|column|blog|entry|story|stories)\/[^/]+/i.test(path);
}

function reasonDiscoverSubpageCandidate(url, source, sources) {
  let path = '';
  try { path = new URL(String(url || '')).pathname.toLowerCase(); } catch (_) { path = String(url || '').toLowerCase(); }
  const important = isDiscoverImportantPath(path);
  const detailLike = isDiscoverDetailLikePath(path);
  const sourceCount = Array.isArray(sources) ? sources.length : 1;
  if (sourceCount >= 2 && important) return 'multiple sources with important path';
  if (source === 'nav' && important) return 'primary navigation link with important path';
  if (source === 'footer' && important) return 'footer link with important path';
  if (source === 'htmlSitemap' && important) return 'HTML sitemap link with important path';
  if (source === 'sitemap' && detailLike) return 'sitemap detail-like url';
  if (source === 'sitemap' && important) return 'sitemap url with important path';
  return `${source || 'unknown'} candidate`;
}

function scoreDiscoverSubpageCandidate(url, source, sources, label = '') {
  let path = '';
  try { path = new URL(String(url || '')).pathname.toLowerCase(); } catch (_) { path = String(url || '').toLowerCase(); }
  const sourceScore = source === 'nav' ? 70 : (source === 'footer' ? 55 : (source === 'htmlSitemap' ? 45 : (source === 'sitemap' ? 20 : (source === 'article' ? 35 : 0))));
  const depth = path.split('/').filter(Boolean).length;
  const sourceCount = Array.isArray(sources) ? sources.length : 1;
  let score = sourceScore;
  if (isDiscoverImportantPath(path)) score += 50;
  if (isLegalOperatorCandidatePath_(url) || isLegalOperatorCandidateText_(label)) score += 15;
  if (depth <= 1) score += 15;
  else if (depth === 2) score += 8;
  if (sourceCount >= 2) score += Math.min(30, 10 + (sourceCount - 2) * 10);
  if (depth >= 3) score -= Math.min(30, (depth - 2) * 10);
  if (isDiscoverDetailLikePath(path)) score -= 30;
  if (/(?:\/|[-_])\d{3,}(?:\.html)?$/i.test(path) || /\/\d{4}(?:\/|-|_)/.test(path)) score -= 20;
  if (/\/[^/]+\.html$/i.test(path) && !/\/index\.html$/i.test(path) && depth >= 2) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function addDiscoverSubpageCandidate(map, rawUrl, source, origin, reason, sourceSummary) {
  const rawHref = rawUrl && typeof rawUrl === 'object' ? (rawUrl.href || rawUrl.url || '') : rawUrl;
  const label = rawUrl && typeof rawUrl === 'object' ? normalizeSubpageJsonLdText(rawUrl.text || rawUrl.label || rawUrl.title || '') : '';
  const url = normalizeDiscoverSubpageUrl(rawHref, origin);
  if (!url) return false;
  const key = discoverSubpageCandidateKey(url);
  const sourcePriority = { sitemap: 1, htmlSitemap: 2, footer: 3, nav: 4 };
  const existing = map.get(key);
  if (existing) {
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (label && !existing.label) existing.label = label.slice(0, 120);
    if ((sourcePriority[source] || 0) > (sourcePriority[existing.source] || 0)) {
      existing.source = source;
    }
    existing.score = scoreDiscoverSubpageCandidate(url, existing.source, existing.sources, existing.label || label);
    existing.reason = reasonDiscoverSubpageCandidate(url, existing.source, existing.sources);
    if (sourceSummary && Object.prototype.hasOwnProperty.call(sourceSummary, source)) sourceSummary[source] += 1;
    return false;
  }
  const item = {
    url,
    label: label.slice(0, 120),
    source,
    sources: [source],
    score: scoreDiscoverSubpageCandidate(url, source, [source], label),
    reason: reasonDiscoverSubpageCandidate(url, source, [source]) || reason
  };
  map.set(key, item);
  if (sourceSummary && Object.prototype.hasOwnProperty.call(sourceSummary, source)) sourceSummary[source] += 1;
  return true;
}

function addDiscoverArticleCandidatesFromLinks_(links, origin, candidateMap, sourceSummary) {
  const articleCandidates = [];
  (Array.isArray(links) ? links : []).forEach(link => {
    if (!link || !isDiscoverArticleCandidatePath_(link.href || link.url || '')) return;
    if (articleCandidates.length >= 20) return;
    if (addDiscoverSubpageCandidate(candidateMap, link, 'article', origin, 'article link from main/body', sourceSummary)) {
      articleCandidates.push(link);
    }
  });
  return articleCandidates;
}

function inferDiscoverCandidatePageType_(candidate, siteMode = 'generic') {
  const existing = normalizeSubpageJsonLdText(candidate && candidate.pageType).toLowerCase();
  if (existing && existing !== 'unknown' && existing !== 'category_or_detail') return existing;
  const url = String(candidate && (candidate.finalUrl || candidate.url || candidate.href || candidate.path) || '');
  if (isDiscoverArticleCandidatePath_(url) || candidate && candidate.source === 'article') return 'article';
  const path = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch (_) { return url.toLowerCase(); }
  })();
  if (/\/(?:about|company|corporate|profile|outline|about-us|company-profile)(?:\/|$|-|_)/i.test(path)) return 'about';
  if (/\/(?:business)(?:\/|$|-|_)/i.test(path)) return 'business';
  if (/\/(?:service|services|solution|solutions)(?:\/|$|-|_)/i.test(path)) return 'service';
  if (/\/(?:case|cases|works|work|portfolio|projects)(?:\/|$|-|_)/i.test(path)) return 'case';
  if (/\/(?:faq|faqs|guide|guides|help|support)(?:\/|$|-|_)/i.test(path)) return 'faq';
  if (/\/(?:product|products|item|items)(?:\/|$|-|_)/i.test(path)) return 'product';
  if (/\/(?:category|categories|collections|collection)(?:\/|$|-|_)/i.test(path)) return 'category';
  if (/\/(?:recruit|career|careers|jobs)(?:\/|$|-|_)/i.test(path)) return 'recruit';
  if (/\/(?:contact|inquiry|inquiries)(?:\/|$|-|_)/i.test(path)) return 'contact';
  if (/\/(?:privacy|policy|terms|law|legal|cookie|security|sitemap)(?:\/|$|-|_)/i.test(path)) return 'legal';
  return inferSubpageJsonLdPageType(url, siteMode, []);
}

function buildRoleRepresentativeCandidates_(candidates, opts = {}) {
  const siteMode = opts && opts.siteMode || 'generic';
  const byType = {};
  const seenByType = {};
  (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
    if (!candidate || !candidate.url) return;
    const pageType = inferDiscoverCandidatePageType_(candidate, siteMode);
    if (!pageType || pageType === 'unknown' || pageType === 'category_or_detail') return;
    const key = discoverSubpageCandidateKey(candidate.url);
    seenByType[pageType] = seenByType[pageType] || new Set();
    if (seenByType[pageType].has(key)) return;
    seenByType[pageType].add(key);
    byType[pageType] = byType[pageType] || [];
    byType[pageType].push({
      url: candidate.url || '',
      path: getCoverageCandidatePath_(candidate),
      pageType,
      score: Number(candidate.score || 0),
      source: candidate.source || '',
      sources: Array.isArray(candidate.sources) ? candidate.sources.slice(0, 8) : (candidate.source ? [candidate.source] : []),
      index
    });
  });
  Object.keys(byType).forEach(pageType => {
    byType[pageType] = byType[pageType]
      .sort((a, b) => (b.score - a.score) || (a.index - b.index) || String(a.url || '').localeCompare(String(b.url || '')))
      .slice(0, 2)
      .map(item => ({
        url: item.url,
        path: item.path,
        pageType: item.pageType,
        score: item.score,
        source: item.source,
        sources: item.sources
      }));
  });
  return byType;
}

function emitRoleRepresentativeCandidatesAudit_(origin, roleRepresentativeCandidates) {
  try {
    console.log('[DEBUG][ROLE_REPRESENTATIVE_CANDIDATES_AUDIT]', JSON.stringify({
      origin,
      pageTypes: Object.keys(roleRepresentativeCandidates || {}),
      countsByPageType: Object.fromEntries(
        Object.entries(roleRepresentativeCandidates || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])
      ),
      sampleByPageType: Object.fromEntries(
        Object.entries(roleRepresentativeCandidates || {}).map(([k, v]) => [
          k,
          (Array.isArray(v) ? v : []).slice(0, 2).map(x => ({
            path: x.path || x.url || x.href,
            pageType: x.pageType,
            score: x.score,
            source: x.source
          }))
        ])
      ),
      note: 'audit_only_not_used_for_observation'
    }));
  } catch (_) {}
}

function compactRepresentativePageAuditItem_(page, fallbackPageType = '') {
  const url = page && (page.url || page.finalUrl || page.href) || '';
  const path = page && page.path || (() => {
    try { return new URL(String(url || '')).pathname || ''; } catch (_) { return ''; }
  })();
  return {
    url,
    path,
    pageType: page && page.pageType || fallbackPageType || '',
    score: Number(page && page.score || 0),
    source: page && page.source || '',
    roleSource: page && page.roleSource || ''
  };
}

function getRoleRepresentativePriorityConfig_(siteType) {
  const normalized = normalizeSubpageJsonLdText(siteType || '').toLowerCase();
  const siteTypeForRolePriority = ['media', 'corporate', 'ec', 'service'].includes(normalized)
    ? normalized
    : 'default';
  const priorityByType = {
    media: ['article', 'about', 'contact', 'faq', 'category', 'legal'],
    corporate: ['about', 'business', 'service', 'case', 'recruit', 'contact', 'faq', 'legal', 'article'],
    ec: ['product', 'category', 'faq', 'guide', 'support', 'store', 'about', 'contact', 'legal', 'article'],
    service: ['service', 'business', 'faq', 'case', 'about', 'contact', 'legal', 'article'],
    default: ['about', 'business', 'service', 'article', 'faq', 'product', 'category', 'contact', 'legal']
  };
  return {
    siteTypeForRolePriority,
    rolePriority: priorityByType[siteTypeForRolePriority]
  };
}

function buildRoleBasedRepresentativePagesAudit_(roleRepresentativeCandidates, opts = {}) {
  const priorityConfig = getRoleRepresentativePriorityConfig_(opts && (opts.siteType || opts.siteMode) || 'default');
  const pageTypes = Array.from(new Set(priorityConfig.rolePriority.concat(Object.keys(roleRepresentativeCandidates || {}))));
  const seen = new Set();
  const out = [];
  pageTypes.forEach(pageType => {
    if (out.length >= 3) return;
    const items = Array.isArray(roleRepresentativeCandidates && roleRepresentativeCandidates[pageType])
      ? roleRepresentativeCandidates[pageType]
      : [];
    const item = items[0];
    if (!item) return;
    const key = discoverSubpageCandidateKey(item.url || item.path || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(Object.assign(compactRepresentativePageAuditItem_(item, pageType), {
      roleSource: 'roleRepresentativeCandidates'
    }));
  });
  return {
    siteTypeForRolePriority: priorityConfig.siteTypeForRolePriority,
    rolePriority: priorityConfig.rolePriority,
    availableRoleTypes: Object.keys(roleRepresentativeCandidates || {}),
    pages: out
  };
}

function buildRoleBasedSelectedCandidates_(candidates, opts = {}) {
  const maxObserve = Math.max(0, Number(opts && opts.maxObserve || 0) || 0);
  if (!maxObserve) {
    const priorityConfig = getRoleRepresentativePriorityConfig_(opts && (opts.siteType || opts.siteMode) || 'default');
    return {
      siteTypeForRolePriority: priorityConfig.siteTypeForRolePriority,
      rolePriority: priorityConfig.rolePriority,
      candidates: []
    };
  }
  const priorityConfig = getRoleRepresentativePriorityConfig_(opts && (opts.siteType || opts.siteMode) || 'default');
  const byType = {};
  (Array.isArray(candidates) ? candidates : []).forEach((candidate, index) => {
    if (!candidate || !candidate.url) return;
    const pageType = inferDiscoverCandidatePageType_(candidate, opts && opts.siteMode || 'generic');
    if (!pageType || pageType === 'unknown' || pageType === 'category_or_detail') return;
    byType[pageType] = byType[pageType] || [];
    byType[pageType].push(Object.assign({}, candidate, {
      pageType,
      __roleBasedIndex: index
    }));
  });
  Object.keys(byType).forEach(pageType => {
    byType[pageType] = byType[pageType].sort((a, b) => {
      const scoreDiff = Number(b && b.score || 0) - Number(a && a.score || 0);
      if (scoreDiff) return scoreDiff;
      return Number(a && a.__roleBasedIndex || 0) - Number(b && b.__roleBasedIndex || 0);
    });
  });
  const selected = [];
  const seen = new Set();
  const pageTypes = Array.from(new Set(priorityConfig.rolePriority.concat(Object.keys(byType))));
  pageTypes.forEach(pageType => {
    if (selected.length >= maxObserve) return;
    const candidate = Array.isArray(byType[pageType]) ? byType[pageType][0] : null;
    if (!candidate) return;
    const key = discoverSubpageCandidateKey(candidate.url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const cleaned = Object.assign({}, candidate);
    delete cleaned.__roleBasedIndex;
    selected.push(cleaned);
  });
  return {
    siteTypeForRolePriority: priorityConfig.siteTypeForRolePriority,
    rolePriority: priorityConfig.rolePriority,
    candidates: selected
  };
}

function buildRepresentativePagesAudit_(legacyRepresentativePages, roleRepresentativeCandidates, opts = {}) {
  const legacy = (Array.isArray(legacyRepresentativePages) ? legacyRepresentativePages : [])
    .map(page => compactRepresentativePageAuditItem_(page))
    .filter(page => page.path || page.url);
  const roleBasedAudit = buildRoleBasedRepresentativePagesAudit_(roleRepresentativeCandidates, opts);
  const roleBased = roleBasedAudit.pages;
  const pathOf = page => {
    const raw = page && (page.path || page.url || page.href) || '';
    const path = (() => {
      try { return new URL(String(raw || '')).pathname || ''; } catch (_) { return String(raw || ''); }
    })();
    return path && path !== '/' ? path.replace(/\/$/, '') : path;
  };
  const legacyPaths = legacy.map(pathOf).filter(Boolean);
  const roleBasedPaths = roleBased.map(pathOf).filter(Boolean);
  const legacySet = new Set(legacyPaths);
  const roleSet = new Set(roleBasedPaths);
  return {
    mode: 'audit_only_not_used_for_observation',
    siteTypeForRolePriority: roleBasedAudit.siteTypeForRolePriority,
    rolePriority: roleBasedAudit.rolePriority,
    availableRoleTypes: roleBasedAudit.availableRoleTypes,
    selectedRoleTypes: roleBased.map(page => page.pageType).filter(Boolean),
    legacyRepresentativePages: legacy,
    roleBasedRepresentativePages: roleBased,
    diff: {
      legacyPaths,
      roleBasedPaths,
      addedByRoleBased: roleBasedPaths.filter(path => !legacySet.has(path)),
      missingFromRoleBased: legacyPaths.filter(path => !roleSet.has(path))
    }
  };
}

function normalizeObservationPlanAuditPath_(page) {
  const raw = page && (page.path || page.url || page.href) || '';
  const path = (() => {
    try { return new URL(String(raw || '')).pathname || ''; } catch (_) { return String(raw || ''); }
  })();
  return path && path !== '/' ? path.replace(/\/$/, '') : path;
}

function buildObservationPlanAuditItem_(page, source) {
  return {
    url: page && page.url || '',
    path: page && page.path || normalizeObservationPlanAuditPath_(page),
    pageType: page && page.pageType || '',
    score: Number(page && page.score || 0),
    source
  };
}

function uniqueObservationPlanAuditPages_(pages, source) {
  const seen = new Set();
  const out = [];
  (Array.isArray(pages) ? pages : []).forEach(page => {
    const key = normalizeObservationPlanAuditPath_(page) || String(page && page.url || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(buildObservationPlanAuditItem_(page, source));
  });
  return out;
}

function buildObservationPlanAudit_(representativePagesAudit) {
  const audit = representativePagesAudit || {};
  const legacyObservationPlan = uniqueObservationPlanAuditPages_(
    audit.legacyRepresentativePages,
    'legacyRepresentativePages'
  );
  const roleBasedObservationPlan = uniqueObservationPlanAuditPages_(
    audit.roleBasedRepresentativePages,
    'roleBasedRepresentativePages'
  );
  const legacyPaths = legacyObservationPlan.map(normalizeObservationPlanAuditPath_).filter(Boolean);
  const roleBasedPaths = roleBasedObservationPlan.map(normalizeObservationPlanAuditPath_).filter(Boolean);
  const legacySet = new Set(legacyPaths);
  const roleSet = new Set(roleBasedPaths);
  return {
    mode: 'audit_only_not_used_for_observation',
    siteTypeForRolePriority: audit.siteTypeForRolePriority || 'default',
    legacyObservationPlan,
    roleBasedObservationPlan,
    diff: {
      legacyPaths,
      roleBasedPaths,
      addedByRoleBased: roleBasedPaths.filter(path => !legacySet.has(path)),
      missingFromRoleBased: legacyPaths.filter(path => !roleSet.has(path))
    },
    note: 'audit_only_observation_target_not_changed'
  };
}

function emitObservationPlanRoleAudit_(origin, observationPlanAudit) {
  try {
    const audit = observationPlanAudit || {};
    const legacyObservationPlan = Array.isArray(audit.legacyObservationPlan) ? audit.legacyObservationPlan : [];
    const roleBasedObservationPlan = Array.isArray(audit.roleBasedObservationPlan) ? audit.roleBasedObservationPlan : [];
    const diff = audit.diff || {};
    console.log('[DEBUG][OBSERVATION_PLAN_ROLE_AUDIT]', JSON.stringify({
      origin,
      mode: 'audit_only_not_used_for_observation',
      siteTypeForRolePriority: audit.siteTypeForRolePriority || 'default',
      legacyObservationPaths: legacyObservationPlan.map(x => x.path || x.url || x.href).filter(Boolean),
      roleBasedObservationPaths: roleBasedObservationPlan.map(x => x.path || x.url || x.href).filter(Boolean),
      addedByRoleBased: Array.isArray(diff.addedByRoleBased) ? diff.addedByRoleBased : [],
      missingFromRoleBased: Array.isArray(diff.missingFromRoleBased) ? diff.missingFromRoleBased : [],
      legacyCount: legacyObservationPlan.length,
      roleBasedCount: roleBasedObservationPlan.length,
      note: 'audit_only_observation_target_not_changed'
    }));
  } catch (_) {}
}

function emitRepresentativePagesRoleAudit_(origin, representativePagesAudit) {
  try {
    const audit = representativePagesAudit || {};
    const legacyPages = Array.isArray(audit.legacyRepresentativePages) ? audit.legacyRepresentativePages : [];
    const rolePages = Array.isArray(audit.roleBasedRepresentativePages) ? audit.roleBasedRepresentativePages : [];
    const diff = audit.diff || {};
    console.log('[DEBUG][REPRESENTATIVE_PAGES_ROLE_AUDIT]', JSON.stringify({
      origin,
      mode: 'audit_only_not_used_for_observation',
      siteTypeForRolePriority: audit.siteTypeForRolePriority || 'default',
      rolePriority: Array.isArray(audit.rolePriority) ? audit.rolePriority : [],
      availableRoleTypes: Array.isArray(audit.availableRoleTypes) ? audit.availableRoleTypes : [],
      selectedRoleTypes: Array.isArray(audit.selectedRoleTypes) ? audit.selectedRoleTypes : [],
      legacyPaths: legacyPages.map(x => x.path || x.url || x.href).filter(Boolean),
      roleBasedPaths: rolePages.map(x => x.path || x.url || x.href).filter(Boolean),
      addedByRoleBased: Array.isArray(diff.addedByRoleBased) ? diff.addedByRoleBased : [],
      missingFromRoleBased: Array.isArray(diff.missingFromRoleBased) ? diff.missingFromRoleBased : [],
      legacyCount: legacyPages.length,
      roleBasedCount: rolePages.length
    }));
  } catch (_) {}
}

async function fetchDiscoverSubpageText(url, timeoutMs = 8000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
      headers: {
        'Accept': 'application/xml,text/xml,text/html,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    const status = response && typeof response.status === 'number' ? response.status : null;
    if (!response || !response.ok) return { ok: false, status, text: '', finalUrl: response && response.url || url };
    const text = String(await response.text() || '').slice(0, 2 * 1024 * 1024);
    return { ok: true, status, text, finalUrl: response.url || url };
  } catch (e) {
    return { ok: false, status: null, text: '', finalUrl: url, error: String(e && (e.message || e) || '').slice(0, 160) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseDiscoverSitemapXml(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const sitemapLocs = [];
  const urlLocs = [];
  $('sitemap > loc').each((_, el) => {
    const loc = normalizeSubpageJsonLdText($(el).text());
    if (loc) sitemapLocs.push(loc);
  });
  $('url > loc').each((_, el) => {
    const loc = normalizeSubpageJsonLdText($(el).text());
    if (loc) urlLocs.push(loc);
  });
  return { sitemapLocs, urlLocs };
}

async function collectDiscoverSitemapCandidates(origin, candidateMap, sourceSummary, errors) {
  const roots = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'].map(path => origin.replace(/\/$/, '') + path);
  for (const sitemapUrl of roots) {
    const rootRes = await fetchDiscoverSubpageText(sitemapUrl, 8000);
    if (!rootRes.ok) {
      errors.push({ source: 'sitemap', message: `${sitemapUrl}: ${rootRes.status || rootRes.error || 'fetch_failed'}` });
      continue;
    }
    const parsed = parseDiscoverSitemapXml(rootRes.text);
    if (parsed.urlLocs.length) {
      parsed.urlLocs.forEach(loc => addDiscoverSubpageCandidate(candidateMap, loc, 'sitemap', origin, 'important path from sitemap', sourceSummary));
      return;
    }
    if (parsed.sitemapLocs.length) {
      const children = parsed.sitemapLocs.slice(0, 10);
      for (const childUrl of children) {
        const normalizedChild = normalizeDiscoverSubpageUrl(childUrl, origin) || childUrl;
        try {
          const childParsed = new URL(String(normalizedChild || childUrl));
          if (childParsed.origin !== origin) continue;
        } catch (_) {
          continue;
        }
        const childRes = await fetchDiscoverSubpageText(childUrl, 8000);
        if (!childRes.ok) {
          errors.push({ source: 'sitemap', message: `${childUrl}: ${childRes.status || childRes.error || 'fetch_failed'}` });
          continue;
        }
        const childParsedXml = parseDiscoverSitemapXml(childRes.text);
        childParsedXml.urlLocs.forEach(loc => addDiscoverSubpageCandidate(candidateMap, loc, 'sitemap', origin, 'important path from sitemap', sourceSummary));
      }
      return;
    }
  }
}

async function collectDiscoverLinksFromPage(page) {
  return page.evaluate(() => {
    const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const absUrl = (href) => {
      try { return new URL(href, location.href).toString(); } catch (_) { return ''; }
    };
    const queryAllDeep = (selector, opts = {}) => {
      const out = [];
      const seen = new Set();
      const maxNodes = Math.max(1, Math.min(600, Number(opts.maxNodes || 300)));
      const maxDepth = Math.max(1, Math.min(8, Number(opts.maxDepth || 5)));
      const walk = (root, depth = 0) => {
        if (!root || depth > maxDepth || !root.querySelectorAll || out.length >= maxNodes) return;
        try {
          Array.from(root.querySelectorAll(selector)).forEach((el) => {
            if (!el || seen.has(el) || out.length >= maxNodes) return;
            seen.add(el);
            out.push(el);
          });
          Array.from(root.querySelectorAll('*')).forEach((el) => {
            if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
          });
        } catch (_) {}
      };
      walk(document, 0);
      return out;
    };
    const linkFrom = (a) => ({
      href: absUrl(a.getAttribute && a.getAttribute('href') || ''),
      text: clean(a.innerText || a.textContent || a.getAttribute && (a.getAttribute('aria-label') || a.getAttribute('title')) || '')
    });
    const allLinks = queryAllDeep('a[href]', { maxNodes: 500 }).map(linkFrom).filter(x => x.href);
    const htmlSitemapLinks = allLinks.filter(x => /sitemap|site-map|サイトマップ/i.test(`${x.href} ${x.text}`)).slice(0, 5);
    const navLinks = queryAllDeep('nav a[href],[role="navigation"] a[href],header a[href]', { maxNodes: 250 }).map(linkFrom).filter(x => x.href).slice(0, 200);
    const footerLinks = queryAllDeep('footer a[href],[role="contentinfo"] a[href]', { maxNodes: 200 }).map(linkFrom).filter(x => x.href).slice(0, 160);
    return { allLinks: allLinks.slice(0, 500), htmlSitemapLinks, navLinks, footerLinks };
  }).catch(() => ({ htmlSitemapLinks: [], navLinks: [], footerLinks: [] }));
}

async function collectDiscoverFallbackCandidates(topUrl, origin, candidateMap, sourceSummary, errors, opts = {}) {
  const logArticleCandidateDiscovery = (topLinks, articleCandidates) => {
    try {
      console.log('[DEBUG][ARTICLE_CANDIDATE_DISCOVERY_AUDIT]', JSON.stringify({
        origin,
        allLinksCount: Array.isArray(topLinks && topLinks.allLinks) ? topLinks.allLinks.length : 0,
        articleCandidatesCount: Array.isArray(articleCandidates) ? articleCandidates.length : 0,
        articleCandidatePaths: (Array.isArray(articleCandidates) ? articleCandidates : []).slice(0, 10).map(link => {
          try { return new URL(String(link && (link.href || link.url) || '')).pathname || ''; } catch (_) { return String(link && (link.href || link.url) || ''); }
        }),
        source: 'main_body_article_links'
      }));
    } catch (_) {}
  };
  if (opts && opts.page) {
    const page = opts.page;
    try {
      const currentUrl = typeof page.url === 'function' ? page.url() : '';
      if (currentUrl !== topUrl) {
        await page.goto(topUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await collectBalancedHydrationMetrics(page, 2500, { shortFastMode: false }).catch(() => null);
      }
      const topLinks = await collectDiscoverLinksFromPage(page);
      if (Array.isArray(topLinks.htmlSitemapLinks) && topLinks.htmlSitemapLinks.length) {
        for (const sitemapLink of topLinks.htmlSitemapLinks.slice(0, 3)) {
          const sitemapPageUrl = normalizeDiscoverSubpageUrl(sitemapLink.href, origin);
          if (!sitemapPageUrl) continue;
          try {
            await page.goto(sitemapPageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await collectBalancedHydrationMetrics(page, 2000, { shortFastMode: false }).catch(() => null);
            const htmlSitemapLinks = await collectDiscoverLinksFromPage(page);
            (htmlSitemapLinks.allLinks || []).forEach(link => {
              addDiscoverSubpageCandidate(candidateMap, link, 'htmlSitemap', origin, 'linked from HTML sitemap', sourceSummary);
            });
          } catch (e) {
            errors.push({ source: 'htmlSitemap', message: `${sitemapPageUrl}: ${String(e && (e.message || e) || '').slice(0, 120)}` });
          }
        }
        await page.goto(topUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
        await collectBalancedHydrationMetrics(page, 1500, { shortFastMode: false }).catch(() => null);
      }
      const navFooterLinks = await collectDiscoverLinksFromPage(page);
      (navFooterLinks.navLinks || []).forEach(link => {
        addDiscoverSubpageCandidate(candidateMap, link, 'nav', origin, 'important path from navigation', sourceSummary);
      });
      (navFooterLinks.footerLinks || []).forEach(link => {
        addDiscoverSubpageCandidate(candidateMap, link, 'footer', origin, 'important path from footer', sourceSummary);
      });
      const articleCandidates = addDiscoverArticleCandidatesFromLinks_(navFooterLinks.allLinks, origin, candidateMap, sourceSummary);
      logArticleCandidateDiscovery(navFooterLinks, articleCandidates);
    } catch (e) {
      errors.push({ source: 'htmlSitemap', message: String(e && (e.message || e) || 'playwright_failed').slice(0, 160) });
    }
    return;
  }
  let browser = null;
  let context = null;
  let page = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      ignoreHTTPSErrors: true
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    page = await context.newPage();
    page.setDefaultNavigationTimeout(15000);
    page.setDefaultTimeout(15000);
    await page.goto(topUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await collectBalancedHydrationMetrics(page, 2500, { shortFastMode: false }).catch(() => null);
    const topLinks = await collectDiscoverLinksFromPage(page);
    if (Array.isArray(topLinks.htmlSitemapLinks) && topLinks.htmlSitemapLinks.length) {
      for (const sitemapLink of topLinks.htmlSitemapLinks.slice(0, 3)) {
        const sitemapPageUrl = normalizeDiscoverSubpageUrl(sitemapLink.href, origin);
        if (!sitemapPageUrl) continue;
        try {
          await page.goto(sitemapPageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await collectBalancedHydrationMetrics(page, 2000, { shortFastMode: false }).catch(() => null);
          const htmlSitemapLinks = await collectDiscoverLinksFromPage(page);
          (htmlSitemapLinks.allLinks || []).forEach(link => {
            addDiscoverSubpageCandidate(candidateMap, link, 'htmlSitemap', origin, 'linked from HTML sitemap', sourceSummary);
          });
        } catch (e) {
          errors.push({ source: 'htmlSitemap', message: `${sitemapPageUrl}: ${String(e && (e.message || e) || '').slice(0, 120)}` });
        }
      }
      await page.goto(topUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      await collectBalancedHydrationMetrics(page, 1500, { shortFastMode: false }).catch(() => null);
    }
    const navFooterLinks = await collectDiscoverLinksFromPage(page);
    (navFooterLinks.navLinks || []).forEach(link => {
      addDiscoverSubpageCandidate(candidateMap, link, 'nav', origin, 'important path from navigation', sourceSummary);
    });
    (navFooterLinks.footerLinks || []).forEach(link => {
      addDiscoverSubpageCandidate(candidateMap, link, 'footer', origin, 'important path from footer', sourceSummary);
    });
    const articleCandidates = addDiscoverArticleCandidatesFromLinks_(navFooterLinks.allLinks, origin, candidateMap, sourceSummary);
    logArticleCandidateDiscovery(navFooterLinks, articleCandidates);
  } catch (e) {
    errors.push({ source: 'htmlSitemap', message: String(e && (e.message || e) || 'playwright_failed').slice(0, 160) });
  } finally {
    try { if (page) await page.close(); } catch (_) {}
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
  }
}

function normalizeDiscoverTopUrl(rawTopUrl) {
  if (!rawTopUrl) return { ok: false, error: 'topUrl or url is required' };
  try {
    const parsed = new URL(String(rawTopUrl || ''));
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported protocol');
    if (isBlockedSubpageJsonLdHost(parsed.hostname)) throw new Error('blocked_private_or_metadata_host');
    parsed.hash = '';
    return { ok: true, topUrl: parsed.toString(), origin: parsed.origin };
  } catch (e) {
    return { ok: false, error: String(e && (e.message || e) || 'invalid topUrl').slice(0, 160) };
  }
}

async function discoverSubpageCandidatesLightData_(topUrl, origin, limit, opts = {}) {
  const normalizedLimit = Math.max(1, Math.min(50, Number(limit || 20) || 20));
  const sourceSummary = { sitemap: 0, htmlSitemap: 0, nav: 0, footer: 0, article: 0 };
  const errors = [];
  const candidateMap = new Map();
  await collectDiscoverSitemapCandidates(origin, candidateMap, sourceSummary, errors);
  await collectDiscoverFallbackCandidates(topUrl, origin, candidateMap, sourceSummary, errors, opts);
  const allCandidates = Array.from(candidateMap.values())
    .map(item => ({
      url: item.url,
      label: item.label || '',
      source: item.source,
      sources: item.sources,
      score: item.score,
      reason: item.reason
    }))
    .sort((a, b) => (b.score - a.score) || (a.url.length - b.url.length) || a.url.localeCompare(b.url));
  const roleRepresentativeCandidates = buildRoleRepresentativeCandidates_(allCandidates, { siteMode: opts && opts.siteMode || 'generic' });
  emitRoleRepresentativeCandidatesAudit_(origin, roleRepresentativeCandidates);
  return {
    candidates: allCandidates.slice(0, normalizedLimit),
    roleRepresentativeCandidates,
    totalCandidates: allCandidates.length,
    sourceSummary,
    errors
  };
}

function inferHtmlFetchOnlyStaticCandidatePageType_(path) {
  const value = String(path || '').toLowerCase();
  if (/\/about(?:\/|$|-|_)/i.test(value)) return 'about';
  if (/\/contact(?:\/|$|-|_)/i.test(value)) return 'contact';
  if (/\/(?:faq|guide|support)(?:\/|$|-|_)/i.test(value)) return 'faq';
  if (isLegalOperatorCandidatePath_(value)) return 'legal';
  if (/\/(?:terms|privacy)(?:\/|$|-|_)/i.test(value)) return 'legal';
  return 'unknown';
}

function buildHtmlFetchOnlyStaticSubpageCandidates_(topUrl, origin, mode) {
  const staticPaths = ['/about', '/contact', '/faq', '/guide', '/support', '/terms', '/privacy', '/legal', '/law', '/policies/legal-notice', '/tokushoho'];
  const source = mode === 'scopedPlaywright'
    ? 'scoped-playwright-static-candidate'
    : 'html-fetch-only-static-candidate';
  const candidates = staticPaths
    .map(path => {
      const url = normalizeDiscoverSubpageUrl(path, origin);
      if (!url) return null;
      const pageType = inferHtmlFetchOnlyStaticCandidatePageType_(path);
      return {
        url,
        path,
        pageType,
        source,
        sources: [source],
        score: scoreDiscoverSubpageCandidate(url, 'nav', [source]),
        reason: 'html fetch only static candidate',
        candidateOnly: true
      };
    })
    .filter(Boolean);
  return {
    candidates,
    totalCandidates: candidates.length,
    sourceSummary: {
      sitemap: 0,
      htmlSitemap: 0,
      nav: 0,
      footer: 0,
      other: candidates.length
    },
    errors: [],
    notes: [mode === 'scopedPlaywright'
      ? 'subpage_observation_mode_scoped_playwright_static_candidates'
      : 'subpage_observation_mode_html_fetch_only_static_candidates']
  };
}

app.post('/discover-subpage-candidates-light', async (req, res) => {
  const rawTopUrl = req && req.body && (req.body.topUrl || req.body.url);
  const normalized = normalizeDiscoverTopUrl(rawTopUrl);
  if (!normalized.ok) return res.status(400).json({ ok: false, error: normalized.error });
  const limit = Math.max(1, Math.min(50, Number(req.body && req.body.limit || 20) || 20));
  const siteMode = normalizeSubpageJsonLdText(req.body && req.body.siteMode || 'generic').toLowerCase() || 'generic';
  const discovered = await discoverSubpageCandidatesLightData_(normalized.topUrl, normalized.origin, limit, { siteMode });
  return res.status(200).json({
    ok: true,
    mode: 'discoverSubpageCandidatesLight',
    topUrl: normalized.topUrl,
    origin: normalized.origin,
    limit,
    candidates: discovered.candidates,
    roleRepresentativeCandidates: discovered.roleRepresentativeCandidates,
    sourceSummary: discovered.sourceSummary,
    errors: discovered.errors
  });
});

// Render check:
// curl -sS -X POST "https://aio-playwright-api-2.onrender.com/discover-subpage-candidates-light" -H "content-type: application/json" --max-time 180 -d '{"topUrl":"https://www.fork.co.jp/","limit":20}' | jq

async function fetchSubpageJsonLdLight(url, opts = {}) {
  const maxHtmlBytes = 2 * 1024 * 1024;
  const timeoutMs = Math.max(1000, Math.min(15000, Number(opts.timeout || 8000) || 8000));
  const context = opts.context;
  let page = null;
  const jsErrors = [];
  const failedRequests = [];
  const consoleErrors = [];
  try {
    const initialUrl = new URL(String(url || ''));
    if (isBlockedSubpageJsonLdHost(initialUrl.hostname)) {
      return {
        url,
        finalUrl: url,
        status: null,
        ok: false,
        pageType: inferSubpageJsonLdPageType(url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: 'blocked_private_or_metadata_host'
      };
    }
    if (!context || typeof context.newPage !== 'function') throw new Error('missing_playwright_context');
    page = await context.newPage();
    try {
      page.setDefaultNavigationTimeout(timeoutMs);
      page.setDefaultTimeout(timeoutMs);
    } catch (_) {}
    page.on('pageerror', (err) => {
      if (jsErrors.length >= 10) return;
      jsErrors.push(String(err && (err.message || err) || '').slice(0, 240));
    });
    page.on('console', (msg) => {
      try {
        if (!msg || !['error', 'warning'].includes(msg.type()) || consoleErrors.length >= 10) return;
        consoleErrors.push({
          type: msg.type(),
          text: String(msg.text() || '').slice(0, 240)
        });
      } catch (_) {}
    });
    page.on('requestfailed', (request) => {
      try {
        if (failedRequests.length >= 10) return;
        const failure = request.failure && request.failure();
        failedRequests.push({
          url: String(request.url() || '').slice(0, 240),
          resourceType: request.resourceType && request.resourceType(),
          failureText: String(failure && failure.errorText || '').slice(0, 160)
        });
      } catch (_) {}
    });
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs
    });
    const status = response && typeof response.status === 'function' ? response.status() : null;
    const finalUrl = page && typeof page.url === 'function' ? page.url() : (response && response.url ? response.url : url);
    let finalParsed = null;
    try { finalParsed = new URL(String(finalUrl || '')); } catch (_) {}
    if (finalParsed && isBlockedSubpageJsonLdHost(finalParsed.hostname)) {
      return {
        url,
        finalUrl,
        status,
        ok: false,
        pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: 'blocked_private_or_metadata_host'
      };
    }
    if (finalParsed && finalParsed.origin !== initialUrl.origin) {
      return {
        url,
        finalUrl,
        status,
        ok: false,
        pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: 'redirect_origin_mismatch'
      };
    }
    if (!response || (typeof response.ok === 'function' && !response.ok())) {
      return {
        url,
        finalUrl,
        status,
        ok: false,
        pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: status ? `HTTP ${status}` : 'fetch_failed'
      };
    }
    const headers = response && typeof response.headers === 'function' ? response.headers() : {};
    const contentType = headers && typeof headers === 'object'
      ? String(headers['content-type'] || '')
      : '';
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
      return {
        url,
        finalUrl,
        status,
        ok: false,
        pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: 'unsupported_content_type'
      };
    }
    const contentLengthHeader = headers && typeof headers === 'object'
      ? Number(headers['content-length'] || 0)
      : 0;
    if (Number.isFinite(contentLengthHeader) && contentLengthHeader > maxHtmlBytes) {
      return {
        url,
        finalUrl,
        status,
        ok: false,
        pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: 'content_length_too_large'
      };
    }
    const hydrationMetrics = await collectBalancedHydrationMetrics(page, 3500, { shortFastMode: false });
    let webdriverValue = '__unavailable__';
    try {
      const rawWebdriverValue = await page.evaluate(() => navigator.webdriver);
      webdriverValue = typeof rawWebdriverValue === 'undefined' ? '__undefined__' : rawWebdriverValue;
    } catch (_) {}
    const waitStartedAt = Date.now();
    const waitStrategyParts = [];
    try {
      await page.waitForLoadState('networkidle', { timeout: Math.min(1800, Math.max(800, timeoutMs - 1000)) });
      waitStrategyParts.push('networkidle');
    } catch (_) {
      waitStrategyParts.push('networkidle_timeout');
    }
    const countJsonLdScripts = async () => page.evaluate(() => {
      const queryAllDeep = (selector, opts = {}) => {
        const out = [];
        const seen = new Set();
        const maxNodes = Math.max(1, Math.min(500, Number(opts.maxNodes || 300)));
        const maxDepth = Math.max(1, Math.min(8, Number(opts.maxDepth || 6)));
        const walk = (root, depth = 0) => {
          if (!root || depth > maxDepth || !root.querySelectorAll || out.length >= maxNodes) return;
          try {
            Array.from(root.querySelectorAll(selector)).forEach((el) => {
              if (!el || seen.has(el) || out.length >= maxNodes) return;
              seen.add(el);
              out.push(el);
            });
            Array.from(root.querySelectorAll('*')).forEach((el) => {
              if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
            });
          } catch (_) {}
        };
        walk(document, 0);
        return out;
      };
      return {
        domJsonLdScriptCount: document.querySelectorAll('script[type*="ld+json" i]').length,
        deepJsonLdScriptCount: queryAllDeep('script[type*="ld+json" i]', { maxNodes: 80 }).length
      };
    }).catch(() => ({ domJsonLdScriptCount: 0, deepJsonLdScriptCount: 0 }));
    let jsonLdCountProbe = await countJsonLdScripts();
    const pollStartedAt = Date.now();
    while (
      Number(jsonLdCountProbe && jsonLdCountProbe.deepJsonLdScriptCount || 0) <= 0 &&
      Date.now() - pollStartedAt < 2500
    ) {
      try { await page.waitForTimeout(250); } catch (_) {}
      jsonLdCountProbe = await countJsonLdScripts();
    }
    waitStrategyParts.push(Number(jsonLdCountProbe && jsonLdCountProbe.deepJsonLdScriptCount || 0) > 0 ? 'jsonld_poll_found' : 'jsonld_poll_timeout');
    try {
      await page.waitForTimeout(1000);
      waitStrategyParts.push('post_poll_wait_1000ms');
    } catch (_) {}
    const observed = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const queryAllDeep = (selector, opts = {}) => {
        const out = [];
        const seen = new Set();
        const maxNodes = Math.max(1, Math.min(500, Number(opts.maxNodes || 300)));
        const maxDepth = Math.max(1, Math.min(8, Number(opts.maxDepth || 6)));
        const walk = (root, depth = 0) => {
          if (!root || depth > maxDepth || !root.querySelectorAll || out.length >= maxNodes) return;
          try {
            Array.from(root.querySelectorAll(selector)).forEach((el) => {
              if (!el || seen.has(el) || out.length >= maxNodes) return;
              seen.add(el);
              out.push(el);
            });
            Array.from(root.querySelectorAll('*')).forEach((el) => {
              if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
            });
          } catch (_) {}
        };
        walk(document, 0);
        return out;
      };
      const h1Texts = [];
      queryAllDeep('h1', { maxNodes: 50 }).forEach((el) => {
        const text = clean(el.innerText || el.textContent);
        if (text && !h1Texts.includes(text) && h1Texts.length < 5) h1Texts.push(text.slice(0, 180));
      });
      const h2Sample = [];
      queryAllDeep('h2', { maxNodes: 80 }).forEach((el) => {
        const text = clean(el.innerText || el.textContent);
        if (text && !h2Sample.includes(text) && h2Sample.length < 5) h2Sample.push(text.slice(0, 160));
      });
      const jsonldTexts = queryAllDeep('script[type*="ld+json" i]', { maxNodes: 50 })
        .map(el => String(el.textContent || '').trim())
        .filter(Boolean);
      const breadcrumbCandidates = queryAllDeep([
        'nav[aria-label*="breadcrumb" i]',
        '[aria-label*="パンくず"]',
        '.breadcrumb',
        '.breadcrumbs',
        '[class*="breadcrumb" i]',
        '[id*="breadcrumb" i]',
        '[class*="breadcrumbs" i]',
        '[id*="breadcrumbs" i]',
        '[class*="pankuzu" i]',
        '[id*="pankuzu" i]',
        'ol',
        'ul'
      ].join(','), { maxNodes: 200 });
      let hasBreadcrumbUi = false;
      for (const el of breadcrumbCandidates) {
        const attrs = [
          el.getAttribute && el.getAttribute('class'),
          el.getAttribute && el.getAttribute('id'),
          el.getAttribute && el.getAttribute('aria-label')
        ].map(v => clean(v).toLowerCase()).join(' ');
        const text = clean(el.innerText || el.textContent).slice(0, 160);
        const liCount = el.querySelectorAll ? el.querySelectorAll('li').length : 0;
        if (/(breadcrumb|breadcrumbs|pankuzu)/i.test(attrs) || /パンくず/.test(attrs) || /パンくず/.test(text) || (liCount >= 2 && /[>›»]/.test(text))) {
          hasBreadcrumbUi = true;
          break;
        }
      }
      const canonicalEl = document.querySelector('link[rel~="canonical" i]');
      const title = clean(document.title || '').slice(0, 180);
      const canonical = canonicalEl && canonicalEl.href ? String(canonicalEl.href || '').trim() : '';
      const metaDescription = clean((document.querySelector('meta[name="description" i]') || {}).content || '').slice(0, 240);
      const ogTitle = clean((document.querySelector('meta[property="og:title" i]') || {}).content || '').slice(0, 180);
      const ogDescription = clean((document.querySelector('meta[property="og:description" i]') || {}).content || '').slice(0, 240);
      const ogImageExists = !!clean((document.querySelector('meta[property="og:image" i]') || {}).content || '');
      const mainCandidates = queryAllDeep('main,[role="main"]', { maxNodes: 20 });
      const anchorEls = queryAllDeep('a[href]', { maxNodes: 1200 });
      let internalLinkCount = 0;
      let externalLinkCount = 0;
      anchorEls.forEach((a) => {
        try {
          const href = a.href || a.getAttribute('href') || '';
          if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href)) return;
          const u = new URL(href, location.href);
          if (u.origin === location.origin) internalLinkCount += 1;
          else externalLinkCount += 1;
        } catch (_) {}
      });
      let sampledText = '';
      try {
        const clone = document.body ? document.body.cloneNode(true) : null;
        if (clone && clone.querySelectorAll) {
          clone.querySelectorAll('script,style,noscript,svg,nav,footer').forEach(el => el.remove());
          sampledText = clean(clone.innerText || clone.textContent || '').slice(0, 500);
        }
      } catch (_) {}
      if (!sampledText) {
        const textParts = [];
        queryAllDeep('main,[role="main"],article,section,p,li', { maxNodes: 160 }).forEach((el) => {
          if (textParts.join(' ').length >= 600) return;
          const text = clean(el.innerText || el.textContent);
          if (text && text.length >= 12 && !textParts.includes(text)) textParts.push(text);
        });
        sampledText = clean(textParts.join(' ')).slice(0, 500);
      }
      if (!sampledText) sampledText = clean((document.body && document.body.innerText) || '').slice(0, 500);
      const allNodes = Array.from(document.querySelectorAll('*')).slice(0, 3000);
      const shadowHostCount = allNodes.filter(el => !!el.shadowRoot).length;
      return {
        finalUrl: location.href,
        readyState: document.readyState || '',
        locationHref: location.href,
        title,
        canonical,
        metaDescription,
        ogTitle,
        ogDescription,
        ogImageExists,
        domJsonLdScriptCount: document.querySelectorAll('script[type*="ld+json" i]').length,
        deepJsonLdScriptCount: jsonldTexts.length,
        scriptCount: document.querySelectorAll('script').length,
        moduleScriptCount: document.querySelectorAll('script[type="module"],script[type="module"][src]').length,
        nextDataExists: !!document.querySelector('#__NEXT_DATA__'),
        nuxtDataExists: !!(window.__NUXT__ || document.querySelector('#__NUXT_DATA__')),
        shadowHostCount,
        bodyTextLength: String((document.body && document.body.innerText) || '').length,
        h1Count: queryAllDeep('h1', { maxNodes: 100 }).length,
        h1Texts,
        h2Sample,
        jsonldTexts,
        hasMain: mainCandidates.length > 0,
        hasMainLandmark: mainCandidates.length > 0,
        hasBreadcrumbUi,
        internalLinkCount,
        externalLinkCount,
        sampledText,
        htmlLength: String((document.documentElement && document.documentElement.outerHTML) || '').length
      };
    });
    if (Number(observed && observed.htmlLength || 0) > maxHtmlBytes) {
      return {
        url,
        finalUrl,
        status,
        ok: false,
        pageType: inferSubpageJsonLdPageType(finalUrl || url, opts.siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: 'html_too_large'
      };
    }
    const jsonldTypes = [];
    const jsonLdItems = [];
    let parseErrors = 0;
    (Array.isArray(observed && observed.jsonldTexts) ? observed.jsonldTexts : []).forEach(raw => {
      try {
        const parsed = JSON.parse(raw);
        jsonLdItems.push(parsed);
        collectSubpageJsonLdTypes(parsed, jsonldTypes, 0);
      } catch (_) {
        parseErrors += 1;
      }
    });
    const uniqueTypes = Array.from(new Set(jsonldTypes.filter(Boolean))).slice(0, 50);
    const jsonldTypeCounts = countSubpageJsonLdTypes(jsonldTypes);
    const lowerTypes = new Set(uniqueTypes.map(type => normalizeSubpageJsonLdType(type).toLowerCase()));
    const observedFinalUrl = observed && observed.finalUrl ? observed.finalUrl : finalUrl;
    return {
      url,
      finalUrl: observedFinalUrl || finalUrl || url,
      status,
      ok: true,
      pageType: inferSubpageJsonLdPageType(observedFinalUrl || finalUrl || url, opts.siteMode, uniqueTypes),
      title: normalizeSubpageJsonLdText(observed && observed.title).slice(0, 180),
      canonical: normalizeSubpageJsonLdText(observed && observed.canonical),
      metaDescription: normalizeSubpageJsonLdText(observed && observed.metaDescription).slice(0, 240),
      ogTitle: normalizeSubpageJsonLdText(observed && observed.ogTitle).slice(0, 180),
      ogDescription: normalizeSubpageJsonLdText(observed && observed.ogDescription).slice(0, 240),
      ogImageExists: !!(observed && observed.ogImageExists),
      h1Count: Number(observed && observed.h1Count || 0),
      h1Texts: Array.isArray(observed && observed.h1Texts) ? observed.h1Texts.slice(0, 5) : [],
      h2Sample: Array.isArray(observed && observed.h2Sample) ? observed.h2Sample.slice(0, 5) : [],
      jsonldTypes: uniqueTypes,
      jsonLdCount: Array.isArray(observed && observed.jsonldTexts) ? observed.jsonldTexts.length : uniqueTypes.length,
      jsonldTypeCounts,
      breadcrumbListCount: Number(jsonldTypeCounts.BreadcrumbList || 0),
      listItemCount: Number(jsonldTypeCounts.ListItem || 0),
      domJsonLdScriptCount: Number(observed && observed.domJsonLdScriptCount || 0),
      deepJsonLdScriptCount: Number(observed && observed.deepJsonLdScriptCount || 0),
      readyState: String(observed && observed.readyState || ''),
      locationHref: String(observed && observed.locationHref || ''),
      bodyTextLength: Number(observed && observed.bodyTextLength || 0),
      htmlLength: Number(observed && observed.htmlLength || 0),
      scriptCount: Number(observed && observed.scriptCount || 0),
      moduleScriptCount: Number(observed && observed.moduleScriptCount || 0),
      nextDataExists: !!(observed && observed.nextDataExists),
      nuxtDataExists: !!(observed && observed.nuxtDataExists),
      shadowHostCount: Number(observed && observed.shadowHostCount || 0),
      hydrationMetrics,
      webdriverValue,
      launchProfile: 'signalsFirstLightAligned',
      jsErrors,
      failedRequests,
      consoleErrors,
      waitedMs: Math.max(0, Date.now() - waitStartedAt),
      waitStrategy: waitStrategyParts.join('+'),
      hasJsonLd: uniqueTypes.length > 0,
      hasBreadcrumbJsonLd: lowerTypes.has('breadcrumblist'),
      hasProductJsonLd: lowerTypes.has('product') || lowerTypes.has('offer'),
      hasFaqJsonLd: lowerTypes.has('faqpage'),
      hasArticleJsonLd: lowerTypes.has('article') || lowerTypes.has('newsarticle'),
      hasBlogPostingJsonLd: lowerTypes.has('blogposting'),
      hasOrganization: lowerTypes.has('organization') || lowerTypes.has('corporation') || lowerTypes.has('localbusiness'),
      hasWebPage: lowerTypes.has('webpage') || lowerTypes.has('aboutpage') || lowerTypes.has('contactpage') || lowerTypes.has('collectionpage'),
      hasService: lowerTypes.has('service'),
      hasBreadcrumbUi: !!(observed && observed.hasBreadcrumbUi),
      hasMain: !!(observed && observed.hasMain),
      hasMainLandmark: !!(observed && observed.hasMainLandmark),
      internalLinkCount: Number(observed && observed.internalLinkCount || 0),
      externalLinkCount: Number(observed && observed.externalLinkCount || 0),
      sampledText: normalizeSubpageJsonLdText(observed && observed.sampledText).slice(0, 500),
      articleSignals: buildArticleSignalsFromJsonLdAndMeta_(jsonLdItems, {}, observedFinalUrl || finalUrl || url),
      error: null,
      parseErrors
    };
  } catch (e) {
    return {
      url,
      finalUrl: url,
      status: null,
      ok: false,
      pageType: inferSubpageJsonLdPageType(url, opts.siteMode, []),
      title: '',
      canonical: '',
      h1Count: 0,
      h1Texts: [],
      jsonldTypes: [],
      hasBreadcrumbJsonLd: false,
      hasProductJsonLd: false,
      hasFaqJsonLd: false,
      hasArticleJsonLd: false,
      hasBlogPostingJsonLd: false,
      hasBreadcrumbUi: false,
      error: e && e.name === 'AbortError' ? 'timeout' : String(e && (e.message || e) || 'fetch_failed').slice(0, 160)
    };
  } finally {
    try { if (page) await page.close(); } catch (_) {}
  }
}

function compactSubpageJsonLdObservation_(page) {
  const rawCounts = page && page.jsonldTypeCounts && typeof page.jsonldTypeCounts === 'object'
    ? page.jsonldTypeCounts
    : {};
  const breadcrumbListCount = Number(
    page && typeof page.breadcrumbListCount === 'number'
      ? page.breadcrumbListCount
      : rawCounts.BreadcrumbList || 0
  );
  const listItemCount = Number(
    page && typeof page.listItemCount === 'number'
      ? page.listItemCount
      : rawCounts.ListItem || 0
  );
  return {
    url: page && page.url || '',
    ok: !!(page && page.ok),
    finalUrl: page && page.finalUrl || page && page.url || '',
    status: page && typeof page.status !== 'undefined' ? page.status : null,
    pageType: page && page.pageType || '',
    title: normalizeSubpageJsonLdText(page && page.title).slice(0, 240),
    canonical: page && page.canonical || '',
    h1Count: Number(page && page.h1Count || 0),
    h1Texts: Array.isArray(page && page.h1Texts) ? page.h1Texts.slice(0, 5) : [],
    jsonldTypes: Array.isArray(page && page.jsonldTypes) ? page.jsonldTypes.slice(0, 50) : [],
    jsonldTypeCounts: rawCounts,
    breadcrumbListCount,
    listItemCount,
    hasBreadcrumbJsonLd: page && page.hasBreadcrumbJsonLd === true,
    hasProductJsonLd: page && page.hasProductJsonLd === true,
    hasFaqJsonLd: page && page.hasFaqJsonLd === true,
    hasArticleJsonLd: page && page.hasArticleJsonLd === true,
    hasBlogPostingJsonLd: page && page.hasBlogPostingJsonLd === true,
    hasOrganization: page && page.hasOrganization === true,
    hasWebPage: page && page.hasWebPage === true,
    hasService: page && page.hasService === true,
    hasBreadcrumbUi: page && page.hasBreadcrumbUi === true,
    hasMain: page && page.hasMain === true,
    hasMainLandmark: page && page.hasMainLandmark === true,
    metaDescription: normalizeSubpageJsonLdText(page && page.metaDescription).slice(0, 240),
    ogTitle: normalizeSubpageJsonLdText(page && page.ogTitle).slice(0, 240),
    ogDescription: normalizeSubpageJsonLdText(page && page.ogDescription).slice(0, 240),
    ogImageExists: page && page.ogImageExists === true,
    internalLinkCount: Number(page && page.internalLinkCount || 0),
    externalLinkCount: Number(page && page.externalLinkCount || 0),
    bodyTextLength: Number(page && page.bodyTextLength || 0),
    sampledText: normalizeSubpageJsonLdText(String(page && page.sampledText || '').slice(0, 500)),
    articleSignals: page && page.articleSignals && typeof page.articleSignals === 'object' ? page.articleSignals : null,
    legalOperatorInfo: page && page.legalOperatorInfo && page.legalOperatorInfo.observed === true ? {
      observed: true,
      pageType: 'legal',
      sourceUrl: String(page.legalOperatorInfo.sourceUrl || page.finalUrl || page.url || ''),
      operatorName: normalizeSubpageJsonLdText(page.legalOperatorInfo.operatorName).slice(0, 120),
      address: normalizeSubpageJsonLdText(page.legalOperatorInfo.address).slice(0, 160),
      telephone: normalizeSubpageJsonLdText(page.legalOperatorInfo.telephone).slice(0, 60),
      hasOperatorName: page.legalOperatorInfo.hasOperatorName === true,
      hasAddress: page.legalOperatorInfo.hasAddress === true,
      hasTelephone: page.legalOperatorInfo.hasTelephone === true,
      hasOperatorInfo: page.legalOperatorInfo.hasOperatorInfo === true,
      extractionMethod: String(page.legalOperatorInfo.extractionMethod || 'html_text').slice(0, 80),
      evidenceLabels: Array.isArray(page.legalOperatorInfo.evidenceLabels) ? page.legalOperatorInfo.evidenceLabels.slice(0, 10) : []
    } : null,
    observationMethod: page && page.observationMethod
      ? String(page.observationMethod).slice(0, 80)
      : (page && page.observationSource === 'html-fetch-light' ? 'html_fetch_light' : ''),
    observationSource: page && page.observationSource ? String(page.observationSource).slice(0, 80) : '',
    scopedFallbackAttempted: page && page.scopedFallbackAttempted === true,
    scopedFallbackError: page && page.scopedFallbackError ? String(page.scopedFallbackError).slice(0, 160) : null,
    scopedFallbackStatus: page && typeof page.scopedFallbackStatus !== 'undefined' ? page.scopedFallbackStatus : null,
    scopedFallbackObservationMethod: page && page.scopedFallbackObservationMethod ? String(page.scopedFallbackObservationMethod).slice(0, 80) : '',
    error: page && page.error ? String(page.error).slice(0, 160) : null
  };
}

function isCoverageSignalsAboutPath_(value) {
  const path = (() => {
    try { return new URL(String(value || '')).pathname.toLowerCase(); } catch (_) { return String(value || '').toLowerCase(); }
  })();
  return /\/(?:about|company|corporate|profile|outline|about-us|company-profile)(?:\/|$|-|_)/i.test(path);
}

function getCoverageRepresentativePriority_(page, siteMode = 'generic') {
  const raw = String(page && (page.finalUrl || page.url || page.path) || '').toLowerCase();
  const path = (() => {
    try { return new URL(raw).pathname.toLowerCase(); } catch (_) { return raw; }
  })();
  const mode = normalizeSubpageJsonLdText(siteMode).toLowerCase();
  if (/\/(?:about|company|corporate|profile|outline|about-us|company-profile)(?:\/|$|-|_)/i.test(path)) return 0;
  if (mode === 'ec' && isLegalOperatorCandidatePath_(raw)) return 1;
  if (/\/(?:business|service|services|solution|solutions|case|works|products|product|recruit|career|careers|contact|inquiry)(?:\/|$|-|_)/i.test(path)) return 1;
  if (/\/(?:privacy|policy|terms|law|legal|cookie|security|sitemap)(?:\/|$|-|_)/i.test(path)) return 3;
  return 2;
}

function getCoverageCandidatePath_(candidate) {
  try { return new URL(String(candidate && candidate.url || '')).pathname || '/'; } catch (_) { return ''; }
}

function sortCoverageObserveCandidates_(candidates, siteMode = 'generic') {
  return (Array.isArray(candidates) ? candidates.slice() : []).sort((a, b) => {
    const aPriority = getCoverageRepresentativePriority_(a, siteMode);
    const bPriority = getCoverageRepresentativePriority_(b, siteMode);
    if (aPriority !== bPriority) return aPriority - bPriority;
    const aSources = Array.isArray(a && a.sources) ? a.sources.length : (a && a.source ? 1 : 0);
    const bSources = Array.isArray(b && b.sources) ? b.sources.length : (b && b.source ? 1 : 0);
    if (aSources !== bSources) return bSources - aSources;
    const aScore = Number(a && a.score || 0);
    const bScore = Number(b && b.score || 0);
    if (aScore !== bScore) return bScore - aScore;
    return String(a && a.url || '').localeCompare(String(b && b.url || ''));
  });
}

function buildCoverageCandidatePageTypes_(candidates) {
  const out = {
    about: false,
    business: false,
    service: false,
    case: false,
    article: false,
    recruit: false,
    contact: false,
    legal: false,
    sitemap: false
  };
  (Array.isArray(candidates) ? candidates : []).forEach(candidate => {
    const path = getCoverageCandidatePath_(candidate).toLowerCase();
    if (!path) return;
    if (/\/(?:about|company|corporate|profile|outline|about-us|company-profile)(?:\/|$|-|_)/i.test(path)) out.about = true;
    if (/\/(?:business)(?:\/|$|-|_)/i.test(path)) out.business = true;
    if (/\/(?:service|services|solution|solutions)(?:\/|$|-|_)/i.test(path)) out.service = true;
    if (/\/(?:case|cases|works|work|portfolio|projects)(?:\/|$|-|_)/i.test(path)) out.case = true;
    if (isDiscoverArticleCandidatePath_(path)) out.article = true;
    if (/\/(?:recruit|career|careers|jobs)(?:\/|$|-|_)/i.test(path)) out.recruit = true;
    if (/\/(?:contact|inquiry|inquiries)(?:\/|$|-|_)/i.test(path)) out.contact = true;
    if (/\/(?:privacy|policy|terms|law|legal|cookie|security)(?:\/|$|-|_)/i.test(path)) out.legal = true;
    if (/\/(?:sitemap)(?:\/|$|-|_)/i.test(path)) out.sitemap = true;
  });
  return out;
}

function buildRepresentativeObservationQualityAudit_(representativePages, observations) {
  const emptySummary = { strong: 0, partial: 0, weak: 0, failed: 0, timeout: 0 };
  const emptyDiagnostics = {
    total: 0,
    observed: 0,
    strong: 0,
    partial: 0,
    weak: 0,
    failed: 0,
    timeout: 0,
    fallbackUsed: 0,
    shadowAttempted: 0,
    shadowTimedOut: 0,
    errors: 0
  };
  try {
    const pages = Array.isArray(representativePages) ? representativePages : [];
    const observedPages = Array.isArray(observations) ? observations : [];
    const byKey = new Map();
    const addObservationKey = (key, page) => {
      const normalized = normalizeSubpageJsonLdText(key).toLowerCase();
      if (normalized && !byKey.has(normalized)) byKey.set(normalized, page);
    };
    const pathFromUrl = value => {
      try { return new URL(String(value || '')).pathname || ''; } catch (_) { return String(value || ''); }
    };
    observedPages.forEach(page => {
      if (!page) return;
      addObservationKey(page.url, page);
      addObservationKey(page.finalUrl, page);
      addObservationKey(pathFromUrl(page.finalUrl || page.url), page);
    });
    const qualityInputPages = pages.length
      ? pages
      : observedPages.map(page => ({
          url: page && page.url || '',
          finalUrl: page && page.finalUrl || page && page.url || '',
          path: pathFromUrl(page && (page.finalUrl || page.url) || ''),
          pageType: page && page.pageType || '',
          title: page && page.title || '',
          h1: Array.isArray(page && page.h1Texts) ? page.h1Texts[0] || '' : '',
          hasH1: Number(page && page.h1Count || 0) > 0
        }));
    const summary = Object.assign({}, emptySummary);
    const diagnostics = Object.assign({}, emptyDiagnostics, { total: qualityInputPages.length });
    const qualityPages = qualityInputPages.map(page => {
      const path = page && page.path || pathFromUrl(page && (page.finalUrl || page.url) || '');
      const observed = byKey.get(normalizeSubpageJsonLdText(page && page.url).toLowerCase()) ||
        byKey.get(normalizeSubpageJsonLdText(page && page.finalUrl).toLowerCase()) ||
        byKey.get(normalizeSubpageJsonLdText(path).toLowerCase()) ||
        {};
      const titleText = normalizeSubpageJsonLdText(String((observed && observed.title) || (page && page.title) || '').slice(0, 500));
      const h1Texts = Array.isArray(observed && observed.h1Texts) ? observed.h1Texts : [];
      const h1Text = normalizeSubpageJsonLdText(
        String(h1Texts[0] || (observed && observed.h1) || (page && page.h1) || '').slice(0, 500)
      );
      const bodyTextLengthNumber = Number(observed && observed.bodyTextLength || 0);
      const sampledTextLength = bodyTextLengthNumber > 0
        ? 0
        : normalizeSubpageJsonLdText(String(observed && observed.sampledText || '').slice(0, 500)).length;
      const errorText = normalizeSubpageJsonLdText(String(observed && observed.error || '').slice(0, 500));
      const bodyTextLength = Math.max(bodyTextLengthNumber, sampledTextLength);
      const h1Count = Math.max(
        Number(observed && observed.h1Count || 0),
        h1Texts.length,
        h1Text ? 1 : 0,
        page && page.hasH1 ? 1 : 0
      );
      const jsonLdTypes = Array.isArray(observed && observed.jsonldTypes)
        ? observed.jsonldTypes
        : (Array.isArray(page && page.jsonLdTypes) ? page.jsonLdTypes : []);
      const jsonLdCount = Math.max(
        Number(observed && (observed.jsonLdCount || observed.jsonldCount || observed.deepJsonLdScriptCount) || 0),
        jsonLdTypes.length
      );
      const internalLinkCount = Number(
        observed && observed.internalLinkCount ||
        page && page.internalLinkCount ||
        0
      );
      const timedOut = /timeout/i.test(errorText);
      const method = (() => {
        const raw = normalizeSubpageJsonLdText(observed && observed.observationMethod);
        if (raw) return raw;
        if (observed && observed.observationSource === 'html-fetch-light') return 'html_fetch_light';
        if (observed && observed.ok === true) return 'playwright_light';
        return 'unknown';
      })();
      const fallbackUsed = observed && (
        observed.usedFallbackExtraction === true ||
        observed.returnedPartial === true ||
        observed.partial === true
      );
      const shadowAttempted = observed && (
        observed.usedShadowDomExtraction === true ||
        observed.shadowAttempted === true
      );
      const shadowTimedOut = observed && (
        observed.shadowTimedOut === true ||
        /shadow.*timeout/i.test(errorText)
      );
      const observedSignals = {
        title: !!titleText,
        h1: h1Count > 0,
        bodyText: bodyTextLength >= 100,
        jsonLd: jsonLdCount > 0,
        links: internalLinkCount > 0
      };
      const reasons = [];
      if (observedSignals.title) reasons.push('has_title');
      if (observedSignals.h1) reasons.push('has_h1');
      if (observedSignals.bodyText) reasons.push('has_body_text');
      if (observedSignals.jsonLd) reasons.push('has_jsonld');
      if (observedSignals.links) reasons.push('has_links');
      if (method === 'html_fetch_light') reasons.push('method_html_fetch_light');
      if (method === 'playwright_scoped_light') reasons.push('method_playwright_scoped_light');
      if (observed && observed.scopedFallbackAttempted === true) reasons.push('scoped_playwright_fallback_attempted');
      if (fallbackUsed) reasons.push('fallback_used');
      if (shadowTimedOut) reasons.push('shadow_timeout');
      if (timedOut) reasons.push('timeout');
      if (errorText && !timedOut) reasons.push('error');
      let quality = 'weak';
      if (timedOut) quality = 'timeout';
      else if (observed && observed.ok === false) quality = 'failed';
      else if (!observedSignals.title && !observedSignals.h1 && bodyTextLength < 80 && !observedSignals.links && !observedSignals.jsonLd) quality = 'failed';
      else if (method !== 'unknown' && observedSignals.title && observedSignals.bodyText && observedSignals.h1 && !fallbackUsed && !errorText) quality = 'strong';
      else if ((observedSignals.title || observedSignals.h1 || observedSignals.jsonLd) && (bodyTextLength >= 100 || observedSignals.links || observedSignals.jsonLd)) quality = 'partial';
      if (!reasons.length) reasons.push(quality === 'failed' ? 'no_observed_content' : 'limited_observed_content');
      summary[quality] += 1;
      diagnostics[quality] += 1;
      if (observed && observed.ok === true) diagnostics.observed += 1;
      if (fallbackUsed) diagnostics.fallbackUsed += 1;
      if (shadowAttempted) diagnostics.shadowAttempted += 1;
      if (shadowTimedOut) diagnostics.shadowTimedOut += 1;
      if (errorText) diagnostics.errors += 1;
      return {
        path,
        pageType: page && page.pageType || '',
        quality,
        reasons,
        observed: observedSignals,
        diagnostics: {
          source: observed && observed.ok === true ? 'observed' : 'representative',
          method,
          fallbackUsed: !!fallbackUsed,
          shadowAttempted: !!shadowAttempted,
          shadowTimedOut: !!shadowTimedOut,
          scopedFallbackAttempted: observed && observed.scopedFallbackAttempted === true,
          scopedFallbackError: observed && observed.scopedFallbackError || null,
          error: errorText || null
        }
      };
    });
    return {
      quality: { summary, pages: qualityPages },
      diagnostics
    };
  } catch (e) {
    return {
      quality: { summary: emptySummary, pages: [] },
      diagnostics: Object.assign({}, emptyDiagnostics, {
        errors: 1,
        error: 'representative_quality_helper_failed'
      })
    };
  }
}

function buildSubpageCardConnectionMatrixAudit_(coverageSignals) {
  const sourceKeys = coverageSignals && typeof coverageSignals === 'object' ? Object.keys(coverageSignals) : [];
  if (!coverageSignals || typeof coverageSignals !== 'object') {
    return {
      hasCoverageSignals: false,
      sourceKeys,
      representativePagesCount: 0,
      representativeObservationQualityCount: 0,
      observedPages: [],
      matrix: [],
      blockedReason: 'coverage_signals_missing'
    };
  }
  const quality = coverageSignals && coverageSignals.representativeObservationQuality || {};
  const pages = Array.isArray(quality.pages) ? quality.pages : [];
  const representativePages = Array.isArray(coverageSignals.representativePages) ? coverageSignals.representativePages : [];
  const representativeByPath = new Map();
  representativePages.forEach(page => {
    if (page && page.path) representativeByPath.set(String(page.path), page);
  });
  const usableStrength = strength => strength === 'strong' || strength === 'partial';
  const typeMatches = (pageType, values) => {
    const type = normalizeSubpageJsonLdText(pageType).toLowerCase();
    return values.some(value => type === value || type.indexOf(value) >= 0);
  };
  const buildBlockedReason = (page) => {
    const strength = normalizeSubpageJsonLdText(page && page.quality).toLowerCase();
    const observed = page && page.observed || {};
    if (strength === 'weak') return 'weak_reference_only';
    if (strength === 'timeout' || strength === 'failed' || strength === 'error') return 'observation_failed_reference_only';
    if (observed.bodyText !== true) return 'empty_dom_reference_only';
    if (!usableStrength(strength)) return 'not_enough_observation_strength';
    return '';
  };
  const matrixPages = pages.slice(0, 20).map(page => {
    const path = page && page.path || '';
    const representative = representativeByPath.get(String(path)) || {};
    const strength = normalizeSubpageJsonLdText(page && page.quality).toLowerCase() || 'unknown';
    const pageType = page && page.pageType || '';
    const observed = page && page.observed || {};
    const diagnostics = page && page.diagnostics || {};
    const bodyTextLength = Number(
      page && page.bodyTextLength ||
      representative && (representative.bodyTextLength || representative.textLength) ||
      0
    );
    const hasBodyText = observed.bodyText === true || bodyTextLength > 0;
    const usable = usableStrength(strength) && hasBodyText;
    const blockedReason = usable ? '' : buildBlockedReason(page);
    const usableForCards = {
      DOC_PRIMARY_MESSAGE: usable && typeMatches(pageType, ['about', 'business', 'service', 'guide', 'faq', 'case']),
      DATA_ORG_PROFILE: usable && typeMatches(pageType, ['about', 'company', 'corporate', 'contact', 'legal']),
      FAQ: usable && typeMatches(pageType, ['faq', 'guide', 'help', 'support']),
      FRESHNESS: usable && typeMatches(pageType, ['news', 'blog', 'notice', 'press']),
      ENTITY: usable && typeMatches(pageType, ['about', 'company', 'corporate', 'business', 'service']),
      SERVICE_CASE_STORE: usable && typeMatches(pageType, ['business', 'service', 'case', 'store', 'category', 'guide'])
    };
    const usableKeys = Object.keys(usableForCards).filter(key => usableForCards[key]);
    return {
      path,
      pageType,
      method: diagnostics.method || 'unknown',
      strength,
      hasBodyText,
      usableForCards,
      reason: usableKeys.length
        ? `usable_for_${usableKeys.join(',').toLowerCase()}`
        : (usable ? 'usable_strength_but_no_card_family_match' : 'not_usable_for_cards'),
      blockedReason
    };
  });
  return {
    hasCoverageSignals: true,
    sourceKeys,
    representativePagesCount: representativePages.length,
    representativeObservationQualityCount: pages.length,
    observedPages: pages.map(page => page && page.path || '').filter(Boolean),
    matrix: matrixPages
  };
}

function buildCoverageSignalsV1FromSubpageObservation_(payload) {
  const candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  const observations = Array.isArray(payload && payload.observations) ? payload.observations : [];
  const candidateByUrl = new Map();
  candidates.forEach(candidate => {
    if (!candidate || !candidate.url) return;
    candidateByUrl.set(String(candidate.url), candidate);
  });
  const rawSourceSummary = payload && payload.candidateSummary && payload.candidateSummary.sourceSummary
    ? payload.candidateSummary.sourceSummary
    : null;
  const roleRepresentativeCandidates = payload && payload.candidateSummary && payload.candidateSummary.roleRepresentativeCandidates
    ? payload.candidateSummary.roleRepresentativeCandidates
    : buildRoleRepresentativeCandidates_(candidates, { siteMode: payload && payload.siteMode || 'generic' });
  const candidateSourceSummary = rawSourceSummary
    ? {
        sitemap: Number(rawSourceSummary.sitemap || 0),
        nav: Number(rawSourceSummary.nav || 0),
        footer: Number(rawSourceSummary.footer || 0),
        other: Number(rawSourceSummary.other || rawSourceSummary.htmlSitemap || 0)
      }
    : candidates.reduce((acc, candidate) => {
        const sources = Array.isArray(candidate && candidate.sources)
          ? candidate.sources
          : (candidate && candidate.source ? [candidate.source] : []);
        sources.forEach(source => {
          if (source === 'sitemap' || source === 'nav' || source === 'footer') acc[source] += 1;
          else acc.other += 1;
        });
        return acc;
      }, { sitemap: 0, nav: 0, footer: 0, other: 0 });
  const candidatePageTypes = buildCoverageCandidatePageTypes_(candidates);
  const observedPages = observations.filter(page => page && page.ok === true);
  const hasBreadcrumb = page => {
    const types = Array.isArray(page && page.jsonldTypes) ? page.jsonldTypes : [];
    return page && (
      page.hasBreadcrumbJsonLd === true ||
      Number(page.breadcrumbListCount || 0) > 0 ||
      types.some(type => normalizeSubpageJsonLdType(type).toLowerCase() === 'breadcrumblist')
    );
  };
  const representativePages = observedPages
    .map(page => {
      const candidate = candidateByUrl.get(String(page.url || '')) || {};
      const finalUrl = page.finalUrl || page.url || '';
      const path = (() => {
        try { return new URL(String(finalUrl || page.url || '')).pathname || '/'; } catch (_) { return ''; }
      })();
      const h1Texts = Array.isArray(page.h1Texts) ? page.h1Texts : [];
      const jsonLdTypes = Array.isArray(page.jsonldTypes) ? page.jsonldTypes.slice(0, 50) : [];
      const candidatePageType = inferDiscoverCandidatePageType_(candidate, payload && payload.siteMode || 'generic');
      const pageType = candidatePageType && candidatePageType !== 'unknown' && candidatePageType !== 'category_or_detail'
        ? candidatePageType
        : (page.pageType || inferSubpageSignalsPageType_(page));
      const legalOperatorInfo = page.legalOperatorInfo && page.legalOperatorInfo.observed === true ? page.legalOperatorInfo : null;
      return {
        url: page.url || '',
        finalUrl,
        path,
        pageType,
        title: normalizeSubpageJsonLdText(page.title).slice(0, 180),
        h1: normalizeSubpageJsonLdText(h1Texts[0] || ''),
        hasH1: Number(page.h1Count || 0) > 0 || h1Texts.length > 0,
        hasBreadcrumbList: hasBreadcrumb(page),
        jsonLdTypes,
        legalOperatorInfo,
        matchedCandidateSources: Array.isArray(candidate.sources)
          ? candidate.sources.slice(0, 8)
          : (candidate.source ? [candidate.source] : [])
      };
    })
    .sort((a, b) => {
      const aPriority = getCoverageRepresentativePriority_(a, payload && payload.siteMode);
      const bPriority = getCoverageRepresentativePriority_(b, payload && payload.siteMode);
      if (aPriority !== bPriority) return aPriority - bPriority;
      if (a.hasBreadcrumbList !== b.hasBreadcrumbList) return a.hasBreadcrumbList ? -1 : 1;
      if (a.hasH1 !== b.hasH1) return a.hasH1 ? -1 : 1;
      if (a.matchedCandidateSources.length !== b.matchedCandidateSources.length) {
        return b.matchedCandidateSources.length - a.matchedCandidateSources.length;
      }
      return String(a.url || '').localeCompare(String(b.url || ''));
    })
    .slice(0, 10);
  const representativePagesAudit = buildRepresentativePagesAudit_(representativePages, roleRepresentativeCandidates, {
    siteMode: payload && payload.siteMode || 'generic'
  });
  emitRepresentativePagesRoleAudit_(payload && payload.origin || '', representativePagesAudit);
  const observationPlanAudit = buildObservationPlanAudit_(representativePagesAudit);
  if (payload && payload.candidateSummary && payload.candidateSummary.activeObservationInput) {
    observationPlanAudit.activeObservationInput = payload.candidateSummary.activeObservationInput;
    observationPlanAudit.activeObservationInputChanged = payload.candidateSummary.activeObservationInputChanged === true;
  }
  emitObservationPlanRoleAudit_(payload && payload.origin || '', observationPlanAudit);
  const observedH1PageCount = observedPages.filter(page => Number(page.h1Count || 0) > 0 || (Array.isArray(page.h1Texts) && page.h1Texts.length > 0)).length;
  const observedBreadcrumbPageCount = observedPages.filter(page => hasBreadcrumb(page)).length;
  const representativeQualityAudit = buildRepresentativeObservationQualityAudit_(representativePages, observations);
  const notes = [];
  if (Array.isArray(payload && payload.notes)) {
    payload.notes.slice(0, 10).forEach(note => {
      const normalizedNote = String(note || '').trim();
      if (normalizedNote && !notes.includes(normalizedNote)) notes.push(normalizedNote);
    });
  }
  if (observedPages.length === 0 && observations.length > 0) notes.push('no_observed_subpages_but_observation_attempted');
  if (String(payload && payload.subpageObservationMode || '').toLowerCase() === 'htmlfetchonly') {
    notes.push('subpage_observation_mode_html_fetch_only');
  }
  if (String(payload && payload.subpageObservationMode || '').toLowerCase() === 'scopedplaywright') {
    notes.push('subpage_observation_mode_scoped_playwright');
  }
  return {
    version: 'coverageSignalsV1',
    generatedAt: new Date().toISOString(),
    source: 'discover-and-observe-subpages-light',
    topUrl: payload && payload.topUrl || '',
    origin: payload && payload.origin || '',
    candidateSourceSummary,
    candidatePageTypes,
    roleRepresentativeCandidates,
    observedSubpageCount: observedPages.length,
    observedH1PageCount,
    observedBreadcrumbPageCount,
    hasObservedSubpageH1: observedH1PageCount > 0,
    hasObservedBreadcrumbList: observedBreadcrumbPageCount > 0,
    hasObservedAboutPage: observedPages.some(page => isCoverageSignalsAboutPath_(page.finalUrl || page.url || '')),
    representativePages,
    representativePagesAudit,
    observationPlanAudit,
    representativeObservationQuality: representativeQualityAudit.quality,
    representativeExtractionDiagnostics: representativeQualityAudit.diagnostics,
    notes
  };
}

function buildGeoSignalsCoverageSignals_(coverageSignalsV1) {
  if (!coverageSignalsV1 || typeof coverageSignalsV1 !== 'object') return null;
  const representativePages = Array.isArray(coverageSignalsV1.representativePages)
    ? coverageSignalsV1.representativePages
    : [];
  const compactRoleRepresentativeCandidates = (input) => {
    const out = {};
    Object.entries(input && typeof input === 'object' ? input : {}).forEach(([pageType, items]) => {
      if (!Array.isArray(items)) return;
      out[pageType] = items.slice(0, 2).map(item => ({
        url: item && item.url || '',
        path: item && item.path || '',
        pageType: item && item.pageType || pageType,
        score: Number(item && item.score || 0),
        source: item && item.source || '',
        sources: Array.isArray(item && item.sources) ? item.sources.slice(0, 8) : []
      }));
    });
    return out;
  };
  const compactRepresentativePagesAudit = (audit) => {
    const compactPages = pages => (Array.isArray(pages) ? pages : []).slice(0, 5).map(page => ({
      url: page && page.url || '',
      path: page && page.path || '',
      pageType: page && page.pageType || '',
      score: Number(page && page.score || 0),
      source: page && page.source || '',
      roleSource: page && page.roleSource || ''
    }));
    const diff = audit && audit.diff || {};
    return {
      mode: audit && audit.mode || 'audit_only_not_used_for_observation',
      siteTypeForRolePriority: audit && audit.siteTypeForRolePriority || 'default',
      rolePriority: Array.isArray(audit && audit.rolePriority) ? audit.rolePriority.slice(0, 20) : [],
      availableRoleTypes: Array.isArray(audit && audit.availableRoleTypes) ? audit.availableRoleTypes.slice(0, 20) : [],
      selectedRoleTypes: Array.isArray(audit && audit.selectedRoleTypes) ? audit.selectedRoleTypes.slice(0, 10) : [],
      legacyRepresentativePages: compactPages(audit && audit.legacyRepresentativePages),
      roleBasedRepresentativePages: compactPages(audit && audit.roleBasedRepresentativePages),
      diff: {
        legacyPaths: Array.isArray(diff.legacyPaths) ? diff.legacyPaths.slice(0, 10) : [],
        roleBasedPaths: Array.isArray(diff.roleBasedPaths) ? diff.roleBasedPaths.slice(0, 10) : [],
        addedByRoleBased: Array.isArray(diff.addedByRoleBased) ? diff.addedByRoleBased.slice(0, 10) : [],
        missingFromRoleBased: Array.isArray(diff.missingFromRoleBased) ? diff.missingFromRoleBased.slice(0, 10) : []
      }
    };
  };
  const compactObservationPlanAudit = (audit) => {
    const compactPlan = pages => (Array.isArray(pages) ? pages : []).slice(0, 5).map(page => ({
      url: page && page.url || '',
      path: page && page.path || '',
      pageType: page && page.pageType || '',
      score: Number(page && page.score || 0),
      source: page && page.source || ''
    }));
    const diff = audit && audit.diff || {};
    return {
      mode: audit && audit.mode || 'audit_only_not_used_for_observation',
      siteTypeForRolePriority: audit && audit.siteTypeForRolePriority || 'default',
      activeObservationInput: audit && audit.activeObservationInput || '',
      activeObservationInputChanged: audit && audit.activeObservationInputChanged === true,
      legacyObservationPlan: compactPlan(audit && audit.legacyObservationPlan),
      roleBasedObservationPlan: compactPlan(audit && audit.roleBasedObservationPlan),
      diff: {
        legacyPaths: Array.isArray(diff.legacyPaths) ? diff.legacyPaths.slice(0, 10) : [],
        roleBasedPaths: Array.isArray(diff.roleBasedPaths) ? diff.roleBasedPaths.slice(0, 10) : [],
        addedByRoleBased: Array.isArray(diff.addedByRoleBased) ? diff.addedByRoleBased.slice(0, 10) : [],
        missingFromRoleBased: Array.isArray(diff.missingFromRoleBased) ? diff.missingFromRoleBased.slice(0, 10) : []
      },
      note: audit && audit.note || 'audit_only_observation_target_not_changed'
    };
  };
  const qualityPages = coverageSignalsV1.representativeObservationQuality &&
    Array.isArray(coverageSignalsV1.representativeObservationQuality.pages)
    ? coverageSignalsV1.representativeObservationQuality.pages
    : [];
  if (Number(coverageSignalsV1.observedSubpageCount || 0) <= 0 && !representativePages.length && !qualityPages.length) return null;
  return {
    version: 'coverageSignalsV1',
    source: 'discover-and-observe-subpages-light',
    checked: true,
    observedSubpageCount: Number(coverageSignalsV1.observedSubpageCount || 0),
    observedH1PageCount: Number(coverageSignalsV1.observedH1PageCount || 0),
    observedBreadcrumbPageCount: Number(coverageSignalsV1.observedBreadcrumbPageCount || 0),
    hasObservedSubpageH1: coverageSignalsV1.hasObservedSubpageH1 === true,
    hasObservedBreadcrumbList: coverageSignalsV1.hasObservedBreadcrumbList === true,
    hasObservedAboutPage: coverageSignalsV1.hasObservedAboutPage === true,
    candidateSourceSummary: coverageSignalsV1.candidateSourceSummary || {
      sitemap: 0,
      nav: 0,
      footer: 0,
      other: 0
    },
    candidatePageTypes: coverageSignalsV1.candidatePageTypes || buildCoverageCandidatePageTypes_([]),
    roleRepresentativeCandidates: compactRoleRepresentativeCandidates(coverageSignalsV1.roleRepresentativeCandidates),
    representativePagesAudit: compactRepresentativePagesAudit(coverageSignalsV1.representativePagesAudit),
    observationPlanAudit: compactObservationPlanAudit(coverageSignalsV1.observationPlanAudit),
    representativePages: representativePages.slice(0, 5).map(page => ({
      url: page && page.url || '',
      path: page && page.path || '',
      pageType: page && page.pageType || '',
      title: page && page.title || '',
      h1: page && page.h1 || '',
      hasH1: !!(page && page.hasH1),
      hasBreadcrumbList: !!(page && page.hasBreadcrumbList),
      jsonLdTypes: Array.isArray(page && page.jsonLdTypes) ? page.jsonLdTypes.slice(0, 20) : [],
      legalOperatorInfo: page && page.legalOperatorInfo && page.legalOperatorInfo.observed === true ? page.legalOperatorInfo : null,
      matchedCandidateSources: Array.isArray(page && page.matchedCandidateSources)
        ? page.matchedCandidateSources.slice(0, 8)
        : []
    })),
    representativeObservationQuality: coverageSignalsV1.representativeObservationQuality || {
      summary: { strong: 0, partial: 0, weak: 0, failed: 0, timeout: 0 },
      pages: []
    },
    representativeExtractionDiagnostics: coverageSignalsV1.representativeExtractionDiagnostics || {
      total: 0,
      observed: 0,
      strong: 0,
      partial: 0,
      weak: 0,
      failed: 0,
      timeout: 0,
      fallbackUsed: 0,
      shadowAttempted: 0,
      shadowTimedOut: 0,
      errors: 0
    },
    notes: Array.isArray(coverageSignalsV1.notes) ? coverageSignalsV1.notes.slice(0, 10) : []
  };
}

function inferSubpageSignalsPageType_(page) {
  const existing = normalizeSubpageJsonLdText(page && page.pageType);
  if (existing && existing !== 'unknown' && existing !== 'category_or_detail') return existing;
  const path = (() => {
    try { return new URL(String(page && (page.finalUrl || page.url) || '')).pathname.toLowerCase(); } catch (_) { return ''; }
  })();
  if (/\/(?:about|company|corporate|profile|outline|about-us|company-profile)(?:\/|$|-|_)/i.test(path)) return 'about';
  if (/\/(?:business)(?:\/|$|-|_)/i.test(path)) return 'business';
  if (/\/(?:service|services|solution|solutions)(?:\/|$|-|_)/i.test(path)) return 'service';
  if (/\/(?:case|cases|works|work|portfolio|projects)(?:\/|$|-|_)/i.test(path)) return 'case';
  if (/\/(?:recruit|career|careers|jobs)(?:\/|$|-|_)/i.test(path)) return 'recruit';
  if (/\/(?:contact|inquiry|inquiries)(?:\/|$|-|_)/i.test(path)) return 'contact';
  if (/\/(?:privacy|policy|terms|law|legal|cookie|security)(?:\/|$|-|_)/i.test(path)) return 'legal';
  return existing || 'unknown';
}

function buildSubpageSignalsSummary_(pages) {
  const okPages = (Array.isArray(pages) ? pages : []).filter(page => page && page.ok !== false);
  const pageTypes = Array.from(new Set(okPages.map(page => normalizeSubpageJsonLdText(page.pageType)).filter(Boolean))).slice(0, 20);
  const jsonLdTypesAll = Array.from(new Set([].concat(...okPages.map(page => (
    Array.isArray(page.jsonLdTypes) ? page.jsonLdTypes : (Array.isArray(page.jsonldTypes) ? page.jsonldTypes : [])
  ))).map(normalizeSubpageJsonLdType).filter(Boolean))).slice(0, 50);
  return {
    observedPageTypes: pageTypes,
    hasAnyJsonLd: okPages.some(page => page.hasJsonLd === true || Number(page.jsonLdCount || page.jsonldCount || 0) > 0),
    hasAnyBreadcrumbList: okPages.some(page => page.hasBreadcrumbList === true || page.hasBreadcrumbJsonLd === true || Number(page.breadcrumbListCount || 0) > 0),
    hasAnyMain: okPages.some(page => page.hasMain === true || page.hasMainLandmark === true),
    jsonLdTypesAll,
    pagesWithH1Count: okPages.filter(page => Number(page.h1Count || 0) > 0 || !!normalizeSubpageJsonLdText(page.h1)).length,
    pagesWithJsonLdCount: okPages.filter(page => page.hasJsonLd === true || Number(page.jsonLdCount || page.jsonldCount || 0) > 0).length,
    pagesWithBreadcrumbListCount: okPages.filter(page => page.hasBreadcrumbList === true || page.hasBreadcrumbJsonLd === true || Number(page.breadcrumbListCount || 0) > 0).length
  };
}

function buildSubpageSignalsV1FromSubpageObservation_(payload) {
  const observations = Array.isArray(payload && payload.observations) ? payload.observations : [];
  const candidates = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  const candidateByUrl = new Map();
  candidates.forEach(candidate => {
    if (!candidate || !candidate.url) return;
    candidateByUrl.set(String(candidate.url), candidate);
  });
  const pages = observations
    .filter(page => page && page.ok === true)
    .slice(0, 5)
    .map(page => {
      const candidate = candidateByUrl.get(String(page.url || '')) || {};
      const finalUrl = page.finalUrl || page.url || '';
      const path = (() => {
        try { return new URL(String(finalUrl || page.url || '')).pathname || '/'; } catch (_) { return ''; }
      })();
      const h1Texts = Array.isArray(page.h1Texts) ? page.h1Texts : [];
      const jsonLdTypes = Array.isArray(page.jsonldTypes) ? page.jsonldTypes.slice(0, 50) : [];
      const candidatePageType = normalizeSubpageJsonLdText(candidate && candidate.pageType);
      const pageType = candidatePageType && candidatePageType !== 'unknown' && candidatePageType !== 'category_or_detail'
        ? candidatePageType
        : inferSubpageSignalsPageType_(page);
      return {
        url: page.url || '',
        finalUrl,
        path,
        pageType,
        title: normalizeSubpageJsonLdText(page.title).slice(0, 180),
        h1: normalizeSubpageJsonLdText(h1Texts[0] || '').slice(0, 180),
        h1Count: Number(page.h1Count || 0),
        h2Sample: Array.isArray(page.h2Sample) ? page.h2Sample.slice(0, 5).map(v => normalizeSubpageJsonLdText(v).slice(0, 160)).filter(Boolean) : [],
        canonical: normalizeSubpageJsonLdText(page.canonical).slice(0, 240),
        jsonLdTypes,
        jsonLdCount: Number(page.jsonLdCount || page.jsonldCount || page.deepJsonLdScriptCount || jsonLdTypes.length || 0),
        hasJsonLd: page.hasJsonLd === true || jsonLdTypes.length > 0,
        hasBreadcrumbList: page.hasBreadcrumbJsonLd === true || Number(page.breadcrumbListCount || 0) > 0,
        hasBreadcrumbUi: page.hasBreadcrumbUi === true,
        hasOrganization: page.hasOrganization === true,
        hasWebPage: page.hasWebPage === true,
        hasService: page.hasService === true,
        hasFAQPage: page.hasFaqJsonLd === true,
        hasArticle: page.hasArticleJsonLd === true || page.hasBlogPostingJsonLd === true,
        hasMain: page.hasMain === true || page.hasMainLandmark === true,
        hasMainLandmark: page.hasMainLandmark === true,
        articleSignals: page.articleSignals && typeof page.articleSignals === 'object' ? page.articleSignals : null,
        metaDescription: normalizeSubpageJsonLdText(page.metaDescription).slice(0, 240),
        ogTitle: normalizeSubpageJsonLdText(page.ogTitle).slice(0, 180),
        ogDescription: normalizeSubpageJsonLdText(page.ogDescription).slice(0, 240),
        ogImageExists: page.ogImageExists === true,
        internalLinkCount: Number(page.internalLinkCount || 0),
        externalLinkCount: Number(page.externalLinkCount || 0),
        sampledText: normalizeSubpageJsonLdText(page.sampledText).slice(0, 500),
        legalOperatorInfo: page.legalOperatorInfo && page.legalOperatorInfo.observed === true ? page.legalOperatorInfo : null
      };
    });
  if (!pages.length) return null;
  const summary = buildSubpageSignalsSummary_(pages);
  return {
    version: 'subpageSignalsV1',
    observedCount: pages.length,
    pages,
    summary
  };
}

function buildRepresentativeSignalsV1_(payload, opts = {}) {
  const siteType = getRoleRepresentativePriorityConfig_(opts && (opts.siteType || opts.siteMode) || payload && payload.siteMode || 'default').siteTypeForRolePriority;
  const pages = [];
  const candidateByKey = new Map();
  (Array.isArray(payload && payload.candidates) ? payload.candidates : []).forEach(candidate => {
    const key = discoverSubpageCandidateKey(candidate && candidate.url || candidate && candidate.path || '');
    if (key) candidateByKey.set(key, candidate);
  });
  const pushPages = (items) => {
    (Array.isArray(items) ? items : []).forEach(page => {
      if (!page || page.ok === false) return;
      const candidateKey = discoverSubpageCandidateKey(page.finalUrl || page.url || page.path || '');
      const candidate = candidateKey ? candidateByKey.get(candidateKey) : null;
      const candidatePageType = candidate ? inferDiscoverCandidatePageType_(candidate, payload && payload.siteMode || opts && opts.siteMode || 'generic') : '';
      const pageType = normalizeSubpageJsonLdText(
        candidatePageType && candidatePageType !== 'unknown' && candidatePageType !== 'category_or_detail'
          ? candidatePageType
          : (page.pageType || inferSubpageSignalsPageType_(page))
      );
      if (pageType !== 'article') return;
      const url = String(page.finalUrl || page.url || '');
      const path = (() => {
        try { return new URL(url || String(page.url || '')).pathname || ''; } catch (_) { return String(page.path || ''); }
      })();
      const articleSignals = page.articleSignals && typeof page.articleSignals === 'object' ? page.articleSignals : {};
      const jsonLd = articleSignals.jsonLd && typeof articleSignals.jsonLd === 'object' ? articleSignals.jsonLd : {};
      const meta = articleSignals.meta && typeof articleSignals.meta === 'object' ? articleSignals.meta : {};
      const headline = normalizeSubpageJsonLdText(
        jsonLd.headline || page.headline || page.title || page.h1 || (Array.isArray(page.h1Texts) ? page.h1Texts[0] : '')
      ).slice(0, 180) || null;
      const summary = normalizeSubpageJsonLdText(
        articleSignals.summaryText || jsonLd.description || meta.description || page.metaDescription || page.ogDescription
      ).slice(0, 240) || null;
      const datePublished = normalizeSubpageJsonLdText(jsonLd.datePublished || meta.publishedTime).slice(0, 80) || null;
      const dateModified = normalizeSubpageJsonLdText(jsonLd.dateModified || meta.modifiedTime).slice(0, 80) || null;
      const author = normalizeSubpageJsonLdText(jsonLd.authorName || meta.author).slice(0, 120) || null;
      const publisher = normalizeSubpageJsonLdText(jsonLd.publisherName).slice(0, 120) || null;
      const publisherLogo = normalizeSubpageJsonLdText(jsonLd.publisherLogo).slice(0, 240) || null;
      const articleSection = normalizeSubpageJsonLdText(jsonLd.articleSection || meta.section).slice(0, 120) || null;
      const keywords = []
        .concat(Array.isArray(jsonLd.articleTags) ? jsonLd.articleTags : [])
        .concat(Array.isArray(meta.tags) ? meta.tags : [])
        .map(value => normalizeSubpageJsonLdText(value).slice(0, 80))
        .filter(Boolean)
        .slice(0, 10);
      const mainEntityOfPage = normalizeSubpageJsonLdText(jsonLd.mainEntityOfPage).slice(0, 240) || null;
      pages.push({
        path,
        url,
        role: 'article',
        pageType: 'article',
        headline,
        summary,
        datePublished,
        dateModified,
        author,
        publisher,
        publisherLogo,
        articleSection,
        keywords,
        mainEntityOfPage
      });
    });
  };
  pushPages(payload && payload.observations);
  if (!pages.length && payload && payload.subpageSignals) pushPages(payload.subpageSignals.pages);
  if (!pages.length && payload && payload.coverageSignals && Array.isArray(payload.coverageSignals.representativePages)) {
    pushPages(payload.coverageSignals.representativePages);
  }

  const seen = new Set();
  const evidencePages = [];
  pages.forEach(page => {
    const key = page.url || page.path;
    if (!key || seen.has(key) || evidencePages.length >= 5) return;
    seen.add(key);
    const hasHeadline = !!page.headline;
    const hasDate = !!(page.datePublished || page.dateModified);
    const hasIdentity = !!(page.author || page.publisher);
    const strength = hasHeadline && hasDate && hasIdentity
      ? 'strong'
      : (hasHeadline ? 'partial' : 'weak');
    evidencePages.push({
      path: page.path || '',
      url: page.url || '',
      role: 'article',
      pageType: 'article',
      strength,
      headline: page.headline || null,
      datePublished: page.datePublished || null,
      dateModified: page.dateModified || null,
      author: page.author || null,
      publisher: page.publisher || null
    });
  });

  const observed = evidencePages.length > 0;
  const hasHeadline = pages.some(page => !!page.headline);
  const hasSummary = pages.some(page => !!page.summary);
  const hasAuthor = pages.some(page => !!page.author);
  const hasPublisher = pages.some(page => !!page.publisher);
  const hasPublisherLogo = pages.some(page => !!page.publisherLogo);
  const hasDatePublished = pages.some(page => !!page.datePublished);
  const hasDateModified = pages.some(page => !!page.dateModified);
  const hasArticleSection = pages.some(page => !!page.articleSection);
  const hasKeywords = pages.some(page => Array.isArray(page.keywords) && page.keywords.length > 0);
  const hasMainEntityOfPage = pages.some(page => !!page.mainEntityOfPage);
  const freshnessUsable = hasDatePublished || hasDateModified;
  const identityUsable = hasAuthor || hasPublisher;
  const contentUnderstandingUsable = hasHeadline || hasSummary || hasArticleSection || hasKeywords;
  const strength = !observed
    ? 'none'
    : (hasHeadline && freshnessUsable && identityUsable ? 'strong' : (hasHeadline ? 'partial' : 'weak'));
  return {
    version: 1,
    siteType,
    generatedFrom: 'role_based_observation',
    roles: {
      article: {
        observed,
        strength,
        observedPagesCount: evidencePages.length,
        hasHeadline,
        hasSummary,
        hasAuthor,
        hasPublisher,
        hasPublisherLogo,
        hasDatePublished,
        hasDateModified,
        hasArticleSection,
        hasKeywords,
        hasMainEntityOfPage,
        freshnessUsable,
        identityUsable,
        contentUnderstandingUsable,
        evidencePages
      }
    }
  };
}

function emitRepresentativeSignalsArticleAudit_(representativeSignals) {
  try {
    const article = representativeSignals && representativeSignals.roles && representativeSignals.roles.article || {};
    console.log('[DEBUG][REPRESENTATIVE_SIGNALS_ARTICLE_AUDIT]', JSON.stringify({
      siteType: representativeSignals && representativeSignals.siteType || '',
      hasRepresentativeSignals: !!representativeSignals,
      articleObserved: article.observed === true,
      articleStrength: article.strength || 'none',
      observedPagesCount: Number(article.observedPagesCount || 0),
      freshnessUsable: article.freshnessUsable === true,
      identityUsable: article.identityUsable === true,
      contentUnderstandingUsable: article.contentUnderstandingUsable === true,
      evidencePagePaths: Array.isArray(article.evidencePages) ? article.evidencePages.map(page => page && page.path || '').filter(Boolean) : []
    }));
  } catch (_) {}
}

function buildRepresentativeEvidenceV1_(representativeSignals) {
  const article = representativeSignals && representativeSignals.roles && representativeSignals.roles.article || {};
  const pages = Array.isArray(article.evidencePages) ? article.evidencePages : [];
  const items = pages.slice(0, 5).map(page => {
    const observedSignals = [];
    if (page && page.headline) observedSignals.push('headline');
    if (page && page.datePublished) observedSignals.push('datePublished');
    if (page && page.dateModified) observedSignals.push('dateModified');
    if (page && page.author) observedSignals.push('author');
    if (page && page.publisher) observedSignals.push('publisher');
    const usableFor = [];
    if (page && (page.datePublished || page.dateModified)) usableFor.push('freshness');
    if (page && (page.author || page.publisher)) usableFor.push('identity');
    if (page && page.headline) usableFor.push('contentUnderstanding');
    const headline = page && page.headline || null;
    const datePublished = page && page.datePublished || null;
    const dateModified = page && page.dateModified || null;
    const author = page && page.author || null;
    const publisher = page && page.publisher || null;
    const summaryText = headline
      ? `記事ページで見出し「${headline}」を確認できます。`
      : ((datePublished || dateModified)
        ? '記事ページで日付情報を確認できます。'
        : ((author || publisher)
          ? '記事ページで著者または媒体情報を確認できます。'
          : '記事ページとして観測されていますが、主要な記事情報は限定的です。'));
    return {
      role: 'article',
      pageType: 'article',
      path: page && page.path || '',
      url: page && page.url || '',
      strength: page && (page.strength === 'strong' || page.strength === 'partial' || page.strength === 'weak')
        ? page.strength
        : 'weak',
      observedSignals,
      usableFor,
      summaryText,
      facts: {
        headline,
        datePublished,
        dateModified,
        author,
        publisher
      }
    };
  });
  return {
    version: 1,
    generatedFrom: 'representativeSignals',
    items
  };
}

function emitRepresentativeEvidenceArticleAudit_(representativeEvidence) {
  try {
    const items = Array.isArray(representativeEvidence && representativeEvidence.items) ? representativeEvidence.items : [];
    const articleItems = items.filter(item => item && item.role === 'article');
    const usableForSet = new Set();
    articleItems.forEach(item => {
      (Array.isArray(item.usableFor) ? item.usableFor : []).forEach(value => {
        if (value) usableForSet.add(value);
      });
    });
    console.log('[DEBUG][REPRESENTATIVE_EVIDENCE_ARTICLE_AUDIT]', JSON.stringify({
      hasRepresentativeEvidence: !!representativeEvidence,
      itemCount: items.length,
      articleItemCount: articleItems.length,
      evidencePagePaths: articleItems.map(item => item && item.path || '').filter(Boolean),
      usableFor: Array.from(usableForSet)
    }));
  } catch (_) {}
}

function buildRepresentativeFactsReadinessV1_(representativeEvidence) {
  const items = Array.isArray(representativeEvidence && representativeEvidence.items) ? representativeEvidence.items : [];
  const buildReadiness = (target) => {
    const matched = items.filter(item => item && Array.isArray(item.usableFor) && item.usableFor.includes(target));
    const roles = Array.from(new Set(matched.map(item => String(item && item.role || '').trim()).filter(Boolean)));
    return {
      usable: matched.length > 0,
      evidenceCount: matched.length,
      roles
    };
  };
  return {
    version: 1,
    generatedFrom: 'representativeEvidence',
    readiness: {
      freshness: buildReadiness('freshness'),
      identity: buildReadiness('identity'),
      contentUnderstanding: buildReadiness('contentUnderstanding')
    }
  };
}

function emitRepresentativeFactsReadinessAudit_(representativeEvidence, representativeFactsReadiness) {
  try {
    const readiness = representativeFactsReadiness && representativeFactsReadiness.readiness || {};
    const freshness = readiness.freshness || {};
    const identity = readiness.identity || {};
    const contentUnderstanding = readiness.contentUnderstanding || {};
    const rolesSet = new Set();
    [freshness, identity, contentUnderstanding].forEach(item => {
      (Array.isArray(item && item.roles) ? item.roles : []).forEach(role => {
        if (role) rolesSet.add(role);
      });
    });
    console.log('[DEBUG][REPRESENTATIVE_FACTS_READINESS_AUDIT]', JSON.stringify({
      hasRepresentativeEvidence: !!representativeEvidence,
      freshnessUsable: freshness.usable === true,
      identityUsable: identity.usable === true,
      contentUnderstandingUsable: contentUnderstanding.usable === true,
      freshnessEvidenceCount: Number(freshness.evidenceCount || 0),
      identityEvidenceCount: Number(identity.evidenceCount || 0),
      contentUnderstandingEvidenceCount: Number(contentUnderstanding.evidenceCount || 0),
      roles: Array.from(rolesSet)
    }));
  } catch (_) {}
}

function buildRepresentativeFactsBridgeV2Audit_(representativeFactsReadiness) {
  const readiness = representativeFactsReadiness && representativeFactsReadiness.readiness || {};
  const freshnessCanUse = readiness.freshness && readiness.freshness.usable === true;
  const identityCanUse = readiness.identity && readiness.identity.usable === true;
  const contentUnderstandingCanUse = readiness.contentUnderstanding && readiness.contentUnderstanding.usable === true;
  return {
    version: 1,
    generatedFrom: 'representativeFactsReadiness',
    candidates: {
      freshness: {
        canUseRepresentativeEvidence: freshnessCanUse,
        shouldSwitchNow: false,
        reason: freshnessCanUse
          ? 'article freshness evidence exists, but existing facts bridge is not switched in this phase'
          : 'representative freshness evidence is not available'
      },
      identity: {
        canUseRepresentativeEvidence: identityCanUse,
        shouldSwitchNow: false,
        reason: identityCanUse
          ? 'article identity evidence exists, but organization identity evidence is not implemented yet'
          : 'representative identity evidence is not available'
      },
      contentUnderstanding: {
        canUseRepresentativeEvidence: contentUnderstandingCanUse,
        shouldSwitchNow: false,
        reason: contentUnderstandingCanUse
          ? 'article content evidence exists, but site-level content evidence is not implemented yet'
          : 'representative content understanding evidence is not available'
      }
    }
  };
}

function emitRepresentativeFactsBridgeV2Audit_(representativeFactsReadiness, representativeFactsBridgeV2Audit) {
  try {
    const candidates = representativeFactsBridgeV2Audit && representativeFactsBridgeV2Audit.candidates || {};
    const freshness = candidates.freshness || {};
    const identity = candidates.identity || {};
    const contentUnderstanding = candidates.contentUnderstanding || {};
    console.log('[DEBUG][REPRESENTATIVE_FACTS_BRIDGE_V2_AUDIT]', JSON.stringify({
      hasRepresentativeFactsReadiness: !!representativeFactsReadiness,
      freshnessCanUseRepresentativeEvidence: freshness.canUseRepresentativeEvidence === true,
      identityCanUseRepresentativeEvidence: identity.canUseRepresentativeEvidence === true,
      contentUnderstandingCanUseRepresentativeEvidence: contentUnderstanding.canUseRepresentativeEvidence === true,
      shouldSwitchNowAny: freshness.shouldSwitchNow === true || identity.shouldSwitchNow === true || contentUnderstanding.shouldSwitchNow === true
    }));
  } catch (_) {}
}

function buildRepresentativeFactsDiffAuditV1_(representativeEvidence, opts = {}) {
  const items = Array.isArray(representativeEvidence && representativeEvidence.items) ? representativeEvidence.items : [];
  const freshnessItem = items.find(item => item && Array.isArray(item.usableFor) && item.usableFor.includes('freshness')) || null;
  const facts = freshnessItem && freshnessItem.facts && typeof freshnessItem.facts === 'object' ? freshnessItem.facts : {};
  const datePublished = freshnessItem ? (facts.datePublished || null) : null;
  const dateModified = freshnessItem ? (facts.dateModified || null) : null;
  const usable = !!(datePublished || dateModified);
  return {
    version: 1,
    generatedFrom: 'representativeEvidence',
    freshness: {
      representativeCandidate: {
        usable,
        datePublished,
        dateModified,
        evidencePath: freshnessItem && freshnessItem.path || '',
        evidenceRole: freshnessItem && freshnessItem.role || ''
      },
      currentRawAvailable: typeof (opts && opts.currentRawAvailable) === 'boolean' ? opts.currentRawAvailable : false,
      shouldSwitchNow: false,
      note: usable
        ? 'representative freshness candidate generated for audit only'
        : 'representative freshness candidate is not available'
    }
  };
}

function emitRepresentativeFactsDiffAudit_(representativeEvidence, representativeFactsDiffAudit) {
  try {
    const freshness = representativeFactsDiffAudit && representativeFactsDiffAudit.freshness || {};
    const candidate = freshness.representativeCandidate || {};
    console.log('[DEBUG][REPRESENTATIVE_FACTS_DIFF_AUDIT]', JSON.stringify({
      hasRepresentativeEvidence: !!representativeEvidence,
      freshnessCandidateUsable: candidate.usable === true,
      freshnessDatePublished: candidate.datePublished || null,
      freshnessDateModified: candidate.dateModified || null,
      freshnessEvidencePath: candidate.evidencePath || '',
      currentRawAvailable: freshness.currentRawAvailable === true,
      shouldSwitchNow: freshness.shouldSwitchNow === true
    }));
  } catch (_) {}
}

function buildRepresentativeFreshnessFactsCandidateV1_(representativeEvidence) {
  const items = Array.isArray(representativeEvidence && representativeEvidence.items) ? representativeEvidence.items : [];
  const freshnessItem = items.find(item => item && Array.isArray(item.usableFor) && item.usableFor.includes('freshness')) || null;
  const facts = freshnessItem && freshnessItem.facts && typeof freshnessItem.facts === 'object' ? freshnessItem.facts : {};
  const datePublished = freshnessItem ? (facts.datePublished || null) : null;
  const dateModified = freshnessItem ? (facts.dateModified || null) : null;
  return {
    usable: !!(datePublished || dateModified),
    source: 'representativeEvidence',
    datePublished,
    dateModified,
    evidencePath: freshnessItem && freshnessItem.path || '',
    evidenceRole: freshnessItem && freshnessItem.role || '',
    observedSignals: Array.isArray(freshnessItem && freshnessItem.observedSignals) ? freshnessItem.observedSignals.slice(0, 20) : []
  };
}

function buildFreshnessFactsBridgeV2DecisionAudit_(representativeFreshnessCandidate, opts = {}) {
  const representativeUsable = representativeFreshnessCandidate && representativeFreshnessCandidate.usable === true;
  const rawInput = opts && opts.rawFacts && typeof opts.rawFacts === 'object'
    ? opts.rawFacts
    : (opts && opts.freshnessOperationSignals && typeof opts.freshnessOperationSignals === 'object' ? opts.freshnessOperationSignals : {});
  const rawFacts = {
    hasDatePublished: rawInput.hasDatePublished === true || !!rawInput.datePublished,
    hasDateModified: rawInput.hasDateModified === true || !!rawInput.dateModified,
    datePublished: rawInput.datePublished || rawInput.publishedAt || null,
    dateModified: rawInput.dateModified || rawInput.modifiedAt || null,
    latestDate: rawInput.latestDate || null,
    freshnessChecked: rawInput.checked === true || rawInput.observed === true || rawInput.hasNewsDateEvidence === true || rawInput.hasUpdatedDateEvidence === true,
    freshnessUsable: rawInput.freshnessUsable === true || rawInput.hasNewsDateEvidence === true || rawInput.hasUpdatedDateEvidence === true || !!(rawInput.datePublished || rawInput.dateModified || rawInput.latestDate)
  };
  const currentRawAvailable = typeof (opts && opts.currentRawAvailable) === 'boolean'
    ? opts.currentRawAvailable
    : rawFacts.freshnessUsable === true;
  const representativeCandidate = {
    hasDatePublished: !!(representativeFreshnessCandidate && representativeFreshnessCandidate.datePublished),
    hasDateModified: !!(representativeFreshnessCandidate && representativeFreshnessCandidate.dateModified),
    datePublished: representativeFreshnessCandidate && representativeFreshnessCandidate.datePublished || null,
    dateModified: representativeFreshnessCandidate && representativeFreshnessCandidate.dateModified || null,
    evidencePagesCount: representativeUsable ? 1 : 0,
    source: 'representativeEvidence.article.facts'
  };
  const rawHasFreshnessEvidence = rawFacts.freshnessUsable === true;
  const representativeHasFreshnessEvidence = !!(representativeCandidate.datePublished || representativeCandidate.dateModified);
  const datePublishedMatches = !!(rawFacts.datePublished && representativeCandidate.datePublished && rawFacts.datePublished === representativeCandidate.datePublished);
  const dateModifiedMatches = !!(rawFacts.dateModified && representativeCandidate.dateModified && rawFacts.dateModified === representativeCandidate.dateModified);
  const representativeIsAdditive = !rawHasFreshnessEvidence && representativeHasFreshnessEvidence;
  const representativeIsMissingRawEvidence = rawHasFreshnessEvidence && !representativeHasFreshnessEvidence;
  const comparison = {
    rawHasFreshnessEvidence,
    representativeHasFreshnessEvidence,
    rawDatePublished: rawFacts.datePublished,
    representativeDatePublished: representativeCandidate.datePublished,
    rawDateModified: rawFacts.dateModified,
    representativeDateModified: representativeCandidate.dateModified,
    datePublishedMatches,
    dateModifiedMatches,
    representativeIsAdditive,
    representativeIsMissingRawEvidence,
    safeToSwitch: false
  };
  const decisionReason = !representativeHasFreshnessEvidence
    ? 'no_representative_candidate_raw_locked'
    : (representativeIsMissingRawEvidence
      ? 'representative_missing_raw_evidence_raw_locked'
      : (representativeIsAdditive
        ? 'representative_additive_but_raw_locked'
        : ((datePublishedMatches || dateModifiedMatches)
          ? 'representative_matches_raw_but_raw_locked'
          : 'phase1_compare_only_raw_locked')));
  return {
    version: 1,
    target: 'freshness',
    representativeUsable,
    currentRawAvailable,
    selectedSource: 'raw',
    wouldUseRepresentative: representativeUsable,
    switched: false,
    reason: representativeUsable
      ? 'representative freshness candidate is available, but raw facts remain selected in this phase'
      : 'representative freshness candidate is not available, raw facts remain selected',
    rawFacts,
    representativeCandidate,
    comparison,
    decisionReason,
    representative: {
      datePublished: representativeFreshnessCandidate && representativeFreshnessCandidate.datePublished || null,
      dateModified: representativeFreshnessCandidate && representativeFreshnessCandidate.dateModified || null,
      evidencePath: representativeFreshnessCandidate && representativeFreshnessCandidate.evidencePath || '',
      evidenceRole: representativeFreshnessCandidate && representativeFreshnessCandidate.evidenceRole || ''
    }
  };
}

function emitFreshnessFactsBridgeV2DecisionAudit_(freshnessFactsBridgeV2DecisionAudit) {
  try {
    const representative = freshnessFactsBridgeV2DecisionAudit && freshnessFactsBridgeV2DecisionAudit.representative || {};
    console.log('[DEBUG][FRESHNESS_FACTS_BRIDGE_V2_DECISION_AUDIT]', JSON.stringify(Object.assign({}, freshnessFactsBridgeV2DecisionAudit || {}, {
      representativeDatePublished: representative.datePublished || null,
      representativeDateModified: representative.dateModified || null,
      representativeEvidencePath: representative.evidencePath || ''
    })));
  } catch (_) {}
}

function buildRepresentativeArticleFactsBridgeAudit_(representativeEvidence, articleSignals) {
  const items = Array.isArray(representativeEvidence && representativeEvidence.items) ? representativeEvidence.items : [];
  const representativeItem = items.find(item => item && item.role === 'article' && item.facts && typeof item.facts === 'object') || null;
  const representativeFacts = representativeItem && representativeItem.facts || {};
  const jsonLd = articleSignals && articleSignals.jsonLd && typeof articleSignals.jsonLd === 'object' ? articleSignals.jsonLd : {};
  const meta = articleSignals && articleSignals.meta && typeof articleSignals.meta === 'object' ? articleSignals.meta : {};
  const currentArticleFacts = {
    headline: jsonLd.headline || null,
    datePublished: jsonLd.datePublished || meta.publishedTime || null,
    dateModified: jsonLd.dateModified || meta.modifiedTime || null,
    authorName: jsonLd.authorName || meta.author || null,
    publisherName: jsonLd.publisherName || null
  };
  const representativeArticleFacts = {
    headline: representativeItem ? (representativeFacts.headline || null) : null,
    datePublished: representativeItem ? (representativeFacts.datePublished || null) : null,
    dateModified: representativeItem ? (representativeFacts.dateModified || null) : null,
    author: representativeItem ? (representativeFacts.author || null) : null,
    publisher: representativeItem ? (representativeFacts.publisher || null) : null,
    evidencePath: representativeItem && representativeItem.path || '',
    evidenceRole: representativeItem && representativeItem.role || ''
  };
  const pairs = [
    ['headline', currentArticleFacts.headline, representativeArticleFacts.headline],
    ['datePublished', currentArticleFacts.datePublished, representativeArticleFacts.datePublished],
    ['dateModified', currentArticleFacts.dateModified, representativeArticleFacts.dateModified],
    ['author', currentArticleFacts.authorName, representativeArticleFacts.author],
    ['publisher', currentArticleFacts.publisherName, representativeArticleFacts.publisher]
  ];
  const fieldMatch_ = (currentValue, representativeValue) => !!(currentValue && representativeValue && currentValue === representativeValue);
  const representativeHasMoreInformation = pairs.some(([, currentValue, representativeValue]) => !currentValue && !!representativeValue);
  const representativeMissingInformation = pairs.some(([, currentValue, representativeValue]) => !!currentValue && !representativeValue);
  const allObservedFieldsMatch = pairs.every(([, currentValue, representativeValue]) => {
    if (!currentValue && !representativeValue) return true;
    return fieldMatch_(currentValue, representativeValue);
  });
  const comparison = {
    headlineMatches: fieldMatch_(currentArticleFacts.headline, representativeArticleFacts.headline),
    datePublishedMatches: fieldMatch_(currentArticleFacts.datePublished, representativeArticleFacts.datePublished),
    dateModifiedMatches: fieldMatch_(currentArticleFacts.dateModified, representativeArticleFacts.dateModified),
    authorMatches: fieldMatch_(currentArticleFacts.authorName, representativeArticleFacts.author),
    publisherMatches: fieldMatch_(currentArticleFacts.publisherName, representativeArticleFacts.publisher),
    representativeHasMoreInformation,
    representativeMissingInformation,
    safeToSwitch: false
  };
  const decisionReason = !representativeItem
    ? 'no_representative_article'
    : (representativeMissingInformation
      ? 'representative_missing_information'
      : (representativeHasMoreInformation
        ? 'representative_has_more_information'
        : (allObservedFieldsMatch
          ? 'representative_matches_articlesignals'
          : 'compare_only_phase1')));
  return {
    version: 1,
    target: 'article',
    generatedFrom: 'representativeEvidence',
    selectedSource: 'articleSignals',
    switched: false,
    currentArticleSignals: currentArticleFacts,
    representativeArticleFacts,
    comparison,
    decisionReason
  };
}

function emitRepresentativeArticleFactsBridgeAudit_(representativeArticleFactsBridgeAudit) {
  try {
    const audit = representativeArticleFactsBridgeAudit || {};
    const comparison = audit.comparison || {};
    const representative = audit.representativeArticleFacts || {};
    console.log('[DEBUG][REPRESENTATIVE_ARTICLE_FACTS_BRIDGE_AUDIT]', JSON.stringify({
      hasRepresentativeArticle: !!(representative.headline || representative.datePublished || representative.dateModified || representative.author || representative.publisher),
      selectedSource: audit.selectedSource || 'articleSignals',
      switched: audit.switched === true,
      decisionReason: audit.decisionReason || '',
      headlineMatches: comparison.headlineMatches === true,
      datePublishedMatches: comparison.datePublishedMatches === true,
      dateModifiedMatches: comparison.dateModifiedMatches === true,
      authorMatches: comparison.authorMatches === true,
      publisherMatches: comparison.publisherMatches === true,
      representativeHasMoreInformation: comparison.representativeHasMoreInformation === true,
      representativeMissingInformation: comparison.representativeMissingInformation === true,
      safeToSwitch: comparison.safeToSwitch === true,
      evidencePath: representative.evidencePath || ''
    }));
  } catch (_) {}
}

function buildRepresentativeArticleFacts_(representativeEvidence) {
  const items = Array.isArray(representativeEvidence && representativeEvidence.items) ? representativeEvidence.items : [];
  const articleItem = items.find(item => item && item.role === 'article' && item.facts && typeof item.facts === 'object') || null;
  const facts = articleItem && articleItem.facts || {};
  const out = {
    version: 1,
    generatedFrom: 'representativeEvidence',
    evidenceSource: 'representativeEvidence.article.facts',
    headline: articleItem ? (facts.headline || null) : null,
    datePublished: articleItem ? (facts.datePublished || null) : null,
    dateModified: articleItem ? (facts.dateModified || null) : null,
    authorName: articleItem ? (facts.author || null) : null,
    publisherName: articleItem ? (facts.publisher || null) : null,
    canonicalUrl: null,
    sourceUrl: articleItem ? (articleItem.url || null) : null,
    evidencePath: articleItem ? (articleItem.path || '') : '',
    connectedToFactsBridge: false,
    connectedToDiagnosis: false
  };
  out.missingKeys = [
    'headline',
    'datePublished',
    'dateModified',
    'authorName',
    'publisherName',
    'canonicalUrl',
    'sourceUrl'
  ].filter(key => out[key] == null || out[key] === '');
  return out;
}

function emitRepresentativeArticleFactsPhase2Audit_(representativeEvidence, representativeArticleFacts) {
  try {
    const facts = representativeArticleFacts || {};
    console.log('[DEBUG][REPRESENTATIVE_ARTICLE_FACTS_PHASE2_AUDIT]', JSON.stringify({
      hasRepresentativeEvidence: !!representativeEvidence,
      generated: !!representativeArticleFacts,
      headline: facts.headline || null,
      datePublished: facts.datePublished || null,
      dateModified: facts.dateModified || null,
      canonicalUrl: facts.canonicalUrl || null,
      sourceUrl: facts.sourceUrl || null,
      missingKeys: Array.isArray(facts.missingKeys) ? facts.missingKeys : [],
      generatedFrom: 'representativeEvidence',
      connectedToFactsBridge: false,
      connectedToDiagnosis: false
    }));
  } catch (_) {}
}

function buildRepresentativeArticleFactsAdoptionAudit_(representativeArticleFacts, articleSignals) {
  const comparableKeys = [
    'headline',
    'datePublished',
    'dateModified',
    'authorName',
    'publisherName',
    'canonicalUrl',
    'sourceUrl'
  ];
  const jsonLd = articleSignals && articleSignals.jsonLd && typeof articleSignals.jsonLd === 'object' ? articleSignals.jsonLd : {};
  const meta = articleSignals && articleSignals.meta && typeof articleSignals.meta === 'object' ? articleSignals.meta : {};
  const currentFacts = {
    headline: jsonLd.headline || null,
    datePublished: jsonLd.datePublished || meta.publishedTime || null,
    dateModified: jsonLd.dateModified || meta.modifiedTime || null,
    authorName: jsonLd.authorName || meta.author || null,
    publisherName: jsonLd.publisherName || null,
    canonicalUrl: null,
    sourceUrl: null
  };
  const representativeFacts = representativeArticleFacts && typeof representativeArticleFacts === 'object'
    ? representativeArticleFacts
    : null;
  const valueFor_ = (obj, key) => {
    const value = obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
    return value == null || value === '' ? null : value;
  };
  const representativeFilledKeys = comparableKeys.filter(key => valueFor_(representativeFacts, key) != null);
  const currentFilledKeys = comparableKeys.filter(key => valueFor_(currentFacts, key) != null);
  const representativeMissingKeys = comparableKeys.filter(key => valueFor_(representativeFacts, key) == null);
  const currentMissingKeys = comparableKeys.filter(key => valueFor_(currentFacts, key) == null);
  const matchingKeys = comparableKeys.filter(key => {
    const rv = valueFor_(representativeFacts, key);
    const cv = valueFor_(currentFacts, key);
    return rv != null && cv != null && rv === cv;
  });
  const differingKeys = comparableKeys.filter(key => {
    const rv = valueFor_(representativeFacts, key);
    const cv = valueFor_(currentFacts, key);
    return rv != null && cv != null && rv !== cv;
  });
  const representativeOnlyKeys = comparableKeys.filter(key => valueFor_(representativeFacts, key) != null && valueFor_(currentFacts, key) == null);
  const currentOnlyKeys = comparableKeys.filter(key => valueFor_(currentFacts, key) != null && valueFor_(representativeFacts, key) == null);
  const hasRepresentativeArticleFacts = !!representativeFacts;
  const hasCurrentArticleSignals = !!(articleSignals && typeof articleSignals === 'object');
  const hasIdentityField = !!(valueFor_(representativeFacts, 'headline') || valueFor_(representativeFacts, 'canonicalUrl') || valueFor_(representativeFacts, 'sourceUrl'));
  const hasDateField = !!(valueFor_(representativeFacts, 'datePublished') || valueFor_(representativeFacts, 'dateModified'));
  const adoptionCandidate = hasRepresentativeArticleFacts && hasIdentityField && hasDateField;
  const adoptionBlockedReason = !hasRepresentativeArticleFacts
    ? 'representative_article_facts_missing'
    : (!representativeFilledKeys.length
      ? 'representative_article_facts_empty'
      : (!hasIdentityField
        ? 'no_identity_fields'
        : (!hasDateField ? 'no_date_fields' : null)));
  return {
    version: 1,
    generatedFrom: 'representativeArticleFacts',
    target: 'articleSignals',
    connectedToFactsBridge: false,
    connectedToDiagnosis: false,
    wouldReplaceArticleSignals: false,
    hasRepresentativeArticleFacts,
    hasCurrentArticleSignals,
    comparableKeys,
    matchingKeys,
    differingKeys,
    representativeOnlyKeys,
    currentOnlyKeys,
    representativeFilledKeys,
    currentFilledKeys,
    representativeMissingKeys,
    currentMissingKeys,
    adoptionCandidate,
    adoptionBlockedReason
  };
}

function emitRepresentativeArticleFactsAdoptionAudit_(representativeArticleFactsAdoptionAudit) {
  try {
    const audit = representativeArticleFactsAdoptionAudit || {};
    console.log('[DEBUG][REPRESENTATIVE_ARTICLE_FACTS_ADOPTION_AUDIT]', JSON.stringify({
      hasRepresentativeArticleFacts: audit.hasRepresentativeArticleFacts === true,
      hasCurrentArticleSignals: audit.hasCurrentArticleSignals === true,
      adoptionCandidate: audit.adoptionCandidate === true,
      adoptionBlockedReason: audit.adoptionBlockedReason || null,
      representativeFilledKeys: Array.isArray(audit.representativeFilledKeys) ? audit.representativeFilledKeys : [],
      currentFilledKeys: Array.isArray(audit.currentFilledKeys) ? audit.currentFilledKeys : [],
      differingKeys: Array.isArray(audit.differingKeys) ? audit.differingKeys : [],
      connectedToFactsBridge: false,
      connectedToDiagnosis: false
    }));
  } catch (_) {}
}

function buildRepresentativeArticleFactsBridgeGateAudit_(representativeArticleFacts, representativeArticleFactsAdoptionAudit, articleSignals) {
  const facts = representativeArticleFacts && typeof representativeArticleFacts === 'object' ? representativeArticleFacts : null;
  const adoption = representativeArticleFactsAdoptionAudit && typeof representativeArticleFactsAdoptionAudit === 'object'
    ? representativeArticleFactsAdoptionAudit
    : {};
  const articleSummary = articleSignals && articleSignals.summary && typeof articleSignals.summary === 'object' ? articleSignals.summary : {};
  const valueFor_ = (obj, key) => {
    const value = obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
    return value == null || value === '' ? null : value;
  };
  const requiredIdentityPassed = !!(
    valueFor_(facts, 'headline') ||
    valueFor_(facts, 'canonicalUrl') ||
    valueFor_(facts, 'sourceUrl')
  );
  const requiredDatePassed = !!(
    valueFor_(facts, 'datePublished') ||
    valueFor_(facts, 'dateModified')
  );
  const adoptionCandidate = adoption.adoptionCandidate === true;
  const gatePassed = adoptionCandidate && !!facts && requiredIdentityPassed && requiredDatePassed;
  const gateBlockedReason = gatePassed
    ? null
    : (!adoptionCandidate
      ? 'adoption_candidate_false'
      : (!facts
        ? 'representative_article_facts_missing'
        : (!requiredIdentityPassed
          ? 'no_identity_fields'
          : (!requiredDatePassed ? 'no_date_fields' : null))));
  return {
    version: 1,
    generatedFrom: 'representativeArticleFactsAdoptionAudit',
    target: 'facts.articleSignals',
    connectedToFactsBridge: false,
    connectedToDiagnosis: false,
    wouldWriteFactsArticleSignals: false,
    gatePassed,
    gateBlockedReason,
    requiredIdentityPassed,
    requiredDatePassed,
    representativeFilledKeys: Array.isArray(adoption.representativeFilledKeys) ? adoption.representativeFilledKeys : [],
    representativeMissingKeys: Array.isArray(adoption.representativeMissingKeys) ? adoption.representativeMissingKeys : [],
    currentArticleSignalsChecked: articleSignals && articleSignals.checked === true,
    currentArticleSignalsHasArticleType: articleSummary.hasArticleType === true,
    adoptionCandidate,
    adoptionBlockedReason: adoption.adoptionBlockedReason || null
  };
}

function emitRepresentativeArticleFactsBridgeGateAudit_(representativeArticleFactsBridgeGateAudit) {
  try {
    const audit = representativeArticleFactsBridgeGateAudit || {};
    console.log('[DEBUG][REPRESENTATIVE_ARTICLE_FACTS_BRIDGE_GATE_AUDIT]', JSON.stringify({
      gatePassed: audit.gatePassed === true,
      gateBlockedReason: audit.gateBlockedReason || null,
      requiredIdentityPassed: audit.requiredIdentityPassed === true,
      requiredDatePassed: audit.requiredDatePassed === true,
      adoptionCandidate: audit.adoptionCandidate === true,
      adoptionBlockedReason: audit.adoptionBlockedReason || null,
      connectedToFactsBridge: false,
      connectedToDiagnosis: false,
      wouldWriteFactsArticleSignals: false
    }));
  } catch (_) {}
}

function buildLightweightSubpageSignalsSummary_(subpageSignals) {
  if (!subpageSignals || typeof subpageSignals !== 'object') return null;
  const summary = subpageSignals.summary || buildSubpageSignalsSummary_(subpageSignals.pages || []);
  return {
    observedCount: Number(subpageSignals.observedCount || 0),
    observedPageTypes: Array.isArray(summary.observedPageTypes) ? summary.observedPageTypes.slice(0, 20) : [],
    hasAnyJsonLd: summary.hasAnyJsonLd === true,
    hasAnyBreadcrumbList: summary.hasAnyBreadcrumbList === true,
    jsonLdTypesAll: Array.isArray(summary.jsonLdTypesAll) ? summary.jsonLdTypesAll.slice(0, 50) : [],
    pagesWithH1Count: Number(summary.pagesWithH1Count || 0),
    pagesWithJsonLdCount: Number(summary.pagesWithJsonLdCount || 0),
    pagesWithBreadcrumbListCount: Number(summary.pagesWithBreadcrumbListCount || 0)
  };
}

function pickBestLegalOperatorInfo_(pages) {
  const candidates = (Array.isArray(pages) ? pages : [])
    .map(page => page && page.legalOperatorInfo)
    .filter(info => info && info.observed === true);
  if (!candidates.length) return null;
  const scoreInfo = info => {
    let score = 0;
    if (info.hasOperatorInfo === true) score += 50;
    if (info.hasAddress === true) score += 20;
    if (info.hasTelephone === true) score += 20;
    if (info.hasOperatorName === true) score += 10;
    return score;
  };
  const best = candidates.slice().sort((a, b) => scoreInfo(b) - scoreInfo(a))[0];
  return {
    observed: true,
    pageType: 'legal',
    sourceUrl: String(best.sourceUrl || ''),
    operatorName: normalizeSubpageJsonLdText(best.operatorName).slice(0, 120),
    address: normalizeSubpageJsonLdText(best.address).slice(0, 160),
    telephone: normalizeSubpageJsonLdText(best.telephone).slice(0, 60),
    hasOperatorName: best.hasOperatorName === true,
    hasAddress: best.hasAddress === true,
    hasTelephone: best.hasTelephone === true,
    hasOperatorInfo: best.hasOperatorInfo === true,
    extractionMethod: String(best.extractionMethod || 'html_text').slice(0, 80),
    evidenceLabels: Array.isArray(best.evidenceLabels) ? best.evidenceLabels.slice(0, 10) : []
  };
}

async function attachCoverageSignalsToGeoSignalsLight_(geoSignalsV1, topUrl, opts = {}) {
  const normalized = normalizeDiscoverTopUrl(topUrl);
  const siteMode = inferSiteModeForRepresentativeObservation_(topUrl,
    opts && opts.siteMode ||
    geoSignalsV1 && (geoSignalsV1.siteMode || geoSignalsV1.siteType || geoSignalsV1.rawSiteType) ||
    'generic'
  );
  const subpageObservationMode = String(opts && opts.subpageObservationMode || '').toLowerCase();
  const normalizedSubpageObservationMode = subpageObservationMode.replace(/[^a-z]/g, '');
  const htmlFetchOnlySubpageObservation = normalizedSubpageObservationMode === 'htmlfetchonly';
  const scopedPlaywrightSubpageObservation = normalizedSubpageObservationMode === 'scopedplaywright';
  const staticCandidateSubpageObservation = htmlFetchOnlySubpageObservation || scopedPlaywrightSubpageObservation;
  const guardHost = (() => {
    try { return new URL(normalized.topUrl || normalized.url || topUrl || '').hostname; } catch (_) { return ''; }
  })();
  const hostMemoryGuardMatched = guardHost === 'ahamo.com' || guardHost === 'www.ahamo.com';
  const memoryGuardScopedProbeSubpageObservation = !staticCandidateSubpageObservation && hostMemoryGuardMatched;
  const effectiveStaticCandidateSubpageObservation = staticCandidateSubpageObservation || memoryGuardScopedProbeSubpageObservation;
  const debugHeavySite = opts && opts.debugHeavySite === true;
  const debugHeavySiteStartedAt = Number(opts && opts.debugHeavySiteStartedAt || Date.now()) || Date.now();
  const heavySiteMemorySnapshot = () => {
    try {
      const memory = process.memoryUsage();
      return {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers
      };
    } catch (_) {
      return null;
    }
  };
  const emitHeavySiteAudit = (phase, details = {}) => {
    if (!debugHeavySite) return;
    try {
      console.log('[DEBUG][HEAVY_SITE_INVESTIGATION_AUDIT]', JSON.stringify({
        phase,
        route: '/scrape',
        url: String(topUrl || ''),
        finalUrl: normalized && normalized.topUrl || '',
        origin: normalized && normalized.origin || '',
        signalsMode: opts && opts.signalsMode || '',
        siteMode,
        subpageObservationMode: opts && opts.subpageObservationMode || '',
        normalizedSubpageObservationMode,
        debugHeavySite: true,
        elapsedMs: Date.now() - debugHeavySiteStartedAt,
        memory: heavySiteMemorySnapshot(),
        details
      }));
    } catch (_) {}
  };
  const traceCoverageMemory = (phase, extra = {}) => {
    try {
      console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify(Object.assign({
        phase,
        browserCreated: false,
        contextCreated: false,
        pageCreated: false,
        candidateCount: 0,
        observeCount: 0
      }, extra)));
    } catch (_) {}
  };
  const logPayload = {
    url: String(topUrl || ''),
    origin: normalized && normalized.origin || '',
    attached: false,
    observedSubpageCount: 0,
    observedH1PageCount: 0,
    observedBreadcrumbPageCount: 0,
    hasObservedAboutPage: false,
    hasObservedBreadcrumbList: false,
    reason: ''
  };
  const reusePageForDiscover = !!(opts && opts.page);
  const reuseContextForObserve = !!(opts && opts.context);
  const maxObserve = effectiveStaticCandidateSubpageObservation
    ? 2
    : Math.max(1, Math.min(5, Number(opts && opts.maxObserve || 5) || 5));
  const auditPayload = {
    url: String(topUrl || ''),
    reusePageForDiscover,
    reuseContextForObserve,
    maxObserve,
    newBrowserCreatedForCoverage: !(reusePageForDiscover && reuseContextForObserve),
    observedSubpageCount: 0,
    attached: false
  };
  try {
    emitHeavySiteAudit('attach_start', {
      hasGeoSignalsV1: !!geoSignalsV1,
      maxObserve,
      reusePageForDiscover,
      reuseContextForObserve
    });
    traceCoverageMemory('attach_start', {
      candidateCount: 0,
      observeCount: 0
    });
    if (!geoSignalsV1 || typeof geoSignalsV1 !== 'object') {
      logPayload.reason = 'missing_geo_signals';
      traceCoverageMemory('attach_skip_missing_geo_signals');
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
        reason: logPayload.reason
      })));
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
      return null;
    }
    if (!normalized.ok) {
      logPayload.reason = normalized.error || 'invalid_top_url';
      traceCoverageMemory('attach_skip_invalid_top_url');
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
        reason: logPayload.reason
      })));
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
      return null;
    }
    if ((staticCandidateSubpageObservation || memoryGuardScopedProbeSubpageObservation) && hostMemoryGuardMatched) {
      emitHeavySiteAudit('guard_bypass', {
        guardHost,
        reason: memoryGuardScopedProbeSubpageObservation
          ? 'tls_ssl_scoped_fallback_probe'
          : (scopedPlaywrightSubpageObservation ? 'scoped_playwright' : 'html_fetch_only')
      });
      try {
        console.log('[DEBUG][REPRESENTATIVE_OBSERVATION_MEMORY_GUARD_BYPASS]', JSON.stringify({
          route: '/scrape',
          mode: 'signalsMode=light',
          origin: normalized.origin,
          subpageObservationMode: opts && opts.subpageObservationMode || '',
          reason: memoryGuardScopedProbeSubpageObservation
            ? 'tls_ssl_scoped_fallback_probe'
            : (scopedPlaywrightSubpageObservation ? 'scoped_playwright' : 'html_fetch_only')
        }));
      } catch (_) {}
    }
    if (!effectiveStaticCandidateSubpageObservation && hostMemoryGuardMatched) {
      const skipReason = 'memory_guard_ahamo_representative_observation';
      emitHeavySiteAudit('guard_memory', {
        guardHost,
        skipReason
      });
      const coverageSignals = {
        version: 'coverageSignalsV1',
        source: 'discover-and-observe-subpages-light',
        checked: true,
        skipped: true,
        skipReason,
        observedSubpageCount: 0,
        observedH1PageCount: 0,
        observedBreadcrumbPageCount: 0,
        hasObservedSubpageH1: false,
        hasObservedBreadcrumbList: false,
        hasObservedAboutPage: false,
        candidateSourceSummary: { sitemap: 0, nav: 0, footer: 0, other: 0 },
        candidatePageTypes: buildCoverageCandidatePageTypes_([]),
        representativePages: [],
        representativeObservationQuality: {
          summary: { strong: 0, partial: 0, weak: 0, failed: 0, timeout: 0 },
          pages: []
        },
        representativeExtractionDiagnostics: {
          total: 0,
          observed: 0,
          strong: 0,
          partial: 0,
          weak: 0,
          failed: 0,
          timeout: 0,
          fallbackUsed: 0,
          shadowAttempted: 0,
          shadowTimedOut: 0,
          errors: 0,
          skipped: true,
          skipReason
        },
        notes: [skipReason]
      };
      geoSignalsV1.coverageSignals = coverageSignals;
      logPayload.origin = normalized.origin;
      logPayload.attached = true;
      logPayload.reason = skipReason;
      auditPayload.attached = true;
      try {
        console.log('[DEBUG][REPRESENTATIVE_OBSERVATION_MEMORY_GUARD]', JSON.stringify({
          route: '/scrape',
          mode: 'signalsMode=light',
          origin: normalized.origin,
          skipped: true,
          reason: skipReason
        }));
      } catch (_) {}
      try {
        console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
          observedSubpageCount: 0,
          reason: skipReason
        })));
      } catch (_) {}
      try {
        console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
      } catch (_) {}
      return coverageSignals;
    }
    emitHeavySiteAudit('discover_start', {
      staticCandidateSubpageObservation: effectiveStaticCandidateSubpageObservation,
      memoryGuardScopedProbeSubpageObservation,
      reusePageForDiscover,
      reuseContextForObserve
    });
    traceCoverageMemory('discover_before', {
      browserCreated: effectiveStaticCandidateSubpageObservation ? false : !reusePageForDiscover,
      contextCreated: !effectiveStaticCandidateSubpageObservation,
      pageCreated: !effectiveStaticCandidateSubpageObservation,
      subpageObservationMode: scopedPlaywrightSubpageObservation ? 'scopedPlaywright' : (htmlFetchOnlySubpageObservation ? 'htmlFetchOnly' : '')
    });
    const discovered = effectiveStaticCandidateSubpageObservation
      ? buildHtmlFetchOnlyStaticSubpageCandidates_(
          normalized.topUrl,
          normalized.origin,
          scopedPlaywrightSubpageObservation ? 'scopedPlaywright' : 'htmlFetchOnly'
        )
      : await discoverSubpageCandidatesLightData_(normalized.topUrl, normalized.origin, 20, {
          siteMode,
          page: opts && opts.page,
          context: opts && opts.context,
          reuseBrowser: reusePageForDiscover || reuseContextForObserve
        });
    emitHeavySiteAudit('discover_end', {
      candidateCount: discovered.totalCandidates,
      sourceSummary: discovered.sourceSummary,
      staticCandidateSubpageObservation: effectiveStaticCandidateSubpageObservation,
      memoryGuardScopedProbeSubpageObservation
    });
    const prioritizedCandidates = sortCoverageObserveCandidates_(discovered.candidates, siteMode);
    const legacySelectedCandidates = prioritizedCandidates.slice(0, maxObserve);
    const roleBasedSelection = buildRoleBasedSelectedCandidates_(discovered.candidates, { siteMode, maxObserve });
    const roleBasedSelectedCandidates = Array.isArray(roleBasedSelection.candidates) ? roleBasedSelection.candidates : [];
    const selectedCandidates = roleBasedSelectedCandidates.length ? roleBasedSelectedCandidates : legacySelectedCandidates;
    const selectedPaths = selectedCandidates.map(getCoverageCandidatePath_).filter(Boolean);
    const legacySelectedPaths = legacySelectedCandidates.map(getCoverageCandidatePath_).filter(Boolean);
    const roleBasedSelectedPaths = roleBasedSelectedCandidates.map(getCoverageCandidatePath_).filter(Boolean);
    try {
      console.log('[DEBUG][ROLE_BASED_SELECTED_CANDIDATES_AUDIT]', JSON.stringify({
        origin: normalized.origin,
        mode: 'active_for_scrape_observation',
        siteTypeForRolePriority: roleBasedSelection.siteTypeForRolePriority || 'default',
        rolePriority: Array.isArray(roleBasedSelection.rolePriority) ? roleBasedSelection.rolePriority : [],
        legacySelectedPaths,
        roleBasedSelectedPaths,
        finalSelectedPaths: selectedPaths,
        finalSelectedPageTypes: selectedCandidates.map(candidate => inferDiscoverCandidatePageType_(candidate, siteMode)).filter(Boolean),
        usedRoleBasedSelection: roleBasedSelectedCandidates.length > 0,
        maxObserve,
        note: 'scrape_observation_input_switched_to_role_based'
      }));
    } catch (_) {}
    try {
      const selectedUrlSet = new Set(selectedCandidates.map(candidate => String(candidate && candidate.url || '')));
      const legalAuditCandidates = prioritizedCandidates
        .map((candidate, index) => {
          const url = String(candidate && candidate.url || '');
          const path = getCoverageCandidatePath_(candidate);
          const pageType = isLegalOperatorCandidatePath_(url) || isLegalOperatorCandidateText_(candidate && candidate.label || '')
            ? 'legal'
            : inferSubpageJsonLdPageType(url, siteMode, []);
          const selected = selectedUrlSet.has(url);
          return {
            index,
            url,
            path,
            pageType,
            score: Number(candidate && candidate.score || 0),
            sources: Array.isArray(candidate && candidate.sources) ? candidate.sources : (candidate && candidate.source ? [candidate.source] : []),
            representativePriority: getCoverageRepresentativePriority_(candidate, siteMode),
            selected,
            rejectReason: selected ? '' : (index >= maxObserve ? 'outside_max_observe' : 'not_selected')
          };
        })
        .filter(item => item.pageType === 'legal' || /\/(?:pages\/guide|pages\/faq|policies\/legal-notice)(?:\/|$)/i.test(item.path))
        .slice(0, 20);
      console.log('[DEBUG][LEGAL_REPRESENTATIVE_SELECTION_AUDIT]', JSON.stringify({
        url: normalized.topUrl,
        siteMode,
        maxObserve,
        candidateCount: discovered.totalCandidates,
        candidateLegal: prioritizedCandidates.some(candidate => isLegalOperatorCandidatePath_(candidate && candidate.url || '') || isLegalOperatorCandidateText_(candidate && candidate.label || '')),
        selectedPaths,
        candidates: legalAuditCandidates
      }));
    } catch (_) {}
    const skippedUtilityPaths = prioritizedCandidates
      .slice(maxObserve)
      .filter(candidate => getCoverageRepresentativePriority_(candidate, siteMode) === 3)
      .map(getCoverageCandidatePath_)
      .filter(Boolean)
      .slice(0, 10);
    try {
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_OBSERVE_SELECTION]', JSON.stringify({
        url: normalized.topUrl,
        maxObserve,
        selectedPaths,
        skippedUtilityPaths,
        candidateCount: discovered.totalCandidates
      }));
    } catch (_) {}
    emitHeavySiteAudit('candidate_selection', {
      candidateCount: discovered.totalCandidates,
      selectedCandidateUrls: selectedCandidates.map(candidate => candidate && candidate.url || '').slice(0, 10),
      selectedPaths,
      skippedUtilityPaths
    });
    traceCoverageMemory('discover_after', {
      browserCreated: effectiveStaticCandidateSubpageObservation ? false : !reusePageForDiscover,
      contextCreated: !effectiveStaticCandidateSubpageObservation,
      pageCreated: !effectiveStaticCandidateSubpageObservation,
      candidateCount: discovered.totalCandidates,
      observeCount: selectedCandidates.length,
      subpageObservationMode: scopedPlaywrightSubpageObservation ? 'scopedPlaywright' : (htmlFetchOnlySubpageObservation ? 'htmlFetchOnly' : '')
    });
    if (!selectedCandidates.length) {
      logPayload.origin = normalized.origin;
      logPayload.reason = 'no_subpage_candidates';
      emitHeavySiteAudit('attach_skip_no_candidates', {
        candidateCount: discovered.totalCandidates
      });
      traceCoverageMemory('attach_skip_no_candidates', {
        candidateCount: discovered.totalCandidates
      });
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
        reason: logPayload.reason
      })));
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
      return null;
    }
    traceCoverageMemory('observe_before', {
      browserCreated: !reuseContextForObserve,
      contextCreated: true,
      pageCreated: true,
      candidateCount: discovered.totalCandidates,
      observeCount: selectedCandidates.length
    });
    const scopedPages = [];
    if (scopedPlaywrightSubpageObservation) {
      emitHeavySiteAudit('scoped_playwright_start', {
        selectedCandidateUrls: selectedCandidates.map(candidate => candidate && candidate.url || '').slice(0, 10)
      });
      for (const candidate of selectedCandidates) {
        scopedPages.push(await fetchSubpagePlaywrightScopedLight(candidate && candidate.url || '', {
          siteMode,
          timeout: 8000,
          context: opts && opts.context,
          debugHeavySite: opts && opts.debugHeavySite === true
        }));
      }
      emitHeavySiteAudit('scoped_playwright_end', {
        observedCount: scopedPages.length,
        sample: scopedPages.slice(0, 5).map(page => ({
          url: page && page.url || '',
          finalUrl: page && page.finalUrl || '',
          ok: page && page.ok,
          status: page && page.status,
          title: page && page.title || '',
          h1Count: page && page.h1Count,
          bodyTextLength: page && page.bodyTextLength,
          error: page && page.error || null
        }))
      });
    }
    if (!scopedPlaywrightSubpageObservation) {
      emitHeavySiteAudit('html_fetch_start', {
        selectedCandidateUrls: selectedCandidates.map(candidate => candidate && candidate.url || '').slice(0, 10)
      });
      try {
        console.log('[DEBUG][SUBPAGE_HTML_FETCH_LIGHT_START]', JSON.stringify({
          route: '/scrape',
          mode: 'signalsMode=light',
          origin: normalized.origin,
          subpageObservationMode,
          urlCount: selectedCandidates.length,
          urls: selectedCandidates.slice(0, 5).map(candidate => candidate && candidate.url || '')
        }));
      } catch (_) {}
    }
    const htmlObserved = scopedPlaywrightSubpageObservation
      ? { pages: [] }
      : await fetchSubpageHtmlLightUrls_(selectedCandidates.map(candidate => candidate.url), {
          siteMode
        });
    if (!scopedPlaywrightSubpageObservation) {
      const htmlObservedItemsForAudit = Array.isArray(htmlObserved && htmlObserved.pages)
        ? htmlObserved.pages
        : (Array.isArray(htmlObserved && htmlObserved.observations) ? htmlObserved.observations : []);
      emitHeavySiteAudit('html_fetch_end', {
        observedCount: htmlObservedItemsForAudit.length,
        sample: htmlObservedItemsForAudit.slice(0, 5).map(page => ({
          url: page && page.url || '',
          finalUrl: page && page.finalUrl || '',
          ok: page && page.ok,
          status: page && page.status,
          title: page && page.title || '',
          h1Count: page && page.h1Count,
          bodyTextLength: page && page.bodyTextLength,
          errorStage: page && page.errorStage || null,
          error: page && page.error || null
        }))
      });
      try {
        const htmlObservedItems = Array.isArray(htmlObserved && htmlObserved.pages)
          ? htmlObserved.pages
          : (Array.isArray(htmlObserved && htmlObserved.observations) ? htmlObserved.observations : []);
        console.log('[DEBUG][SUBPAGE_HTML_FETCH_LIGHT_COMPLETE]', JSON.stringify({
          route: '/scrape',
          mode: 'signalsMode=light',
          origin: normalized.origin,
          subpageObservationMode,
          observedCount: htmlObservedItems.length,
          sample: htmlObservedItems.slice(0, 5).map(page => ({
            url: page && page.url || '',
            finalUrl: page && page.finalUrl || '',
            ok: page && page.ok,
            status: page && page.status,
            title: page && page.title || '',
            h1Count: page && page.h1Count,
            bodyTextLength: page && page.bodyTextLength,
            internalLinkCount: page && page.internalLinkCount,
            jsonLdCount: page && (page.jsonLdCount || page.jsonldCount) || 0,
            errorStage: page && page.errorStage || null,
            error: page && page.error || null
          }))
        }));
      } catch (_) {}
    }
    const htmlPages = Array.isArray(htmlObserved && htmlObserved.pages) ? htmlObserved.pages : [];
    const scopedFallbackCandidates = htmlFetchOnlySubpageObservation || scopedPlaywrightSubpageObservation
      ? []
      : selectedCandidates.filter((candidate, index) => {
          return isSubpageHtmlLightTlsSslFailure_(htmlPages[index]);
        });
    const scopedFallbackCandidateUrls = new Set(scopedFallbackCandidates.map(candidate => String(candidate && candidate.url || '')));
    const playwrightCandidates = htmlFetchOnlySubpageObservation || scopedPlaywrightSubpageObservation || memoryGuardScopedProbeSubpageObservation
      ? []
      : selectedCandidates.filter((candidate, index) => {
          const candidateUrl = String(candidate && candidate.url || '');
          return !scopedFallbackCandidateUrls.has(candidateUrl) && !isSubpageHtmlLightObservationSufficient_(htmlPages[index]);
        });
    const scopedFallbackPages = [];
    if (scopedFallbackCandidates.length) {
      emitHeavySiteAudit('scoped_playwright_start', {
        reason: 'html_fetch_tls_ssl_failure',
        selectedCandidateUrls: scopedFallbackCandidates.map(candidate => candidate && candidate.url || '').slice(0, 10)
      });
      for (const candidate of scopedFallbackCandidates) {
        scopedFallbackPages.push(await fetchSubpagePlaywrightScopedLight(candidate && candidate.url || '', {
          siteMode,
          timeout: 8000,
          context: opts && opts.context,
          debugHeavySite: opts && opts.debugHeavySite === true
        }));
      }
      emitHeavySiteAudit('scoped_playwright_end', {
        reason: 'html_fetch_tls_ssl_failure',
        observedCount: scopedFallbackPages.length,
        sample: scopedFallbackPages.slice(0, 5).map(page => ({
          url: page && page.url || '',
          finalUrl: page && page.finalUrl || '',
          ok: page && page.ok,
          status: page && page.status,
          title: page && page.title || '',
          h1Count: page && page.h1Count,
          bodyTextLength: page && page.bodyTextLength,
          error: page && page.error || null
        }))
      });
    }
    emitHeavySiteAudit('playwright_fallback_start', {
      candidateCount: playwrightCandidates.length,
      candidateUrls: playwrightCandidates.map(candidate => candidate && candidate.url || '').slice(0, 10)
    });
    const playwrightObserved = playwrightCandidates.length
      ? await observeSubpageJsonLdLightUrls_(playwrightCandidates.map(candidate => candidate.url), {
          siteMode,
          timeout: 8000,
          concurrency: reuseContextForObserve ? 1 : 3,
          context: opts && opts.context,
          reuseBrowser: reuseContextForObserve,
          sequential: reuseContextForObserve
        })
      : { pages: [] };
    emitHeavySiteAudit('playwright_fallback_end', {
      observedCount: Array.isArray(playwrightObserved && playwrightObserved.pages) ? playwrightObserved.pages.length : 0,
      sample: (Array.isArray(playwrightObserved && playwrightObserved.pages) ? playwrightObserved.pages : []).slice(0, 5).map(page => ({
        url: page && page.url || '',
        finalUrl: page && page.finalUrl || '',
        ok: page && page.ok,
        status: page && page.status,
        title: page && page.title || '',
        h1Count: page && page.h1Count,
        bodyTextLength: page && page.bodyTextLength,
        error: page && page.error || null
      }))
    });
    const playwrightPages = (Array.isArray(playwrightObserved && playwrightObserved.pages) ? playwrightObserved.pages : [])
      .map(page => Object.assign({}, page || {}, {
        observationMethod: 'playwright_light',
        observationSource: page && page.observationSource || 'playwright-light'
      }));
    const playwrightByUrl = new Map();
    playwrightPages.forEach(page => {
      if (page && page.url) playwrightByUrl.set(String(page.url), page);
    });
    const scopedFallbackByUrl = new Map();
    scopedFallbackPages.forEach(page => {
      if (page && page.url) scopedFallbackByUrl.set(String(page.url), page);
    });
    const observed = {
      pages: selectedCandidates.map((candidate, index) => {
        if (scopedPlaywrightSubpageObservation) {
          return scopedPages[index] || {
            url: candidate && candidate.url || '',
            finalUrl: candidate && candidate.url || '',
            status: null,
            ok: false,
            pageType: inferSubpageJsonLdPageType(candidate && candidate.url || '', 'generic', []),
            title: '',
            canonical: '',
            h1Count: 0,
            h1Texts: [],
            jsonldTypes: [],
            hasBreadcrumbJsonLd: false,
            hasBreadcrumbUi: false,
            observationMethod: 'playwright_scoped_light',
            error: 'subpage_scoped_observation_not_available'
          };
        }
        const htmlPage = htmlPages[index];
        const playwrightPage = playwrightByUrl.get(String(candidate && candidate.url || ''));
        const scopedFallbackPage = scopedFallbackByUrl.get(String(candidate && candidate.url || ''));
        if (playwrightPage && playwrightPage.ok === true) return playwrightPage;
        if (scopedFallbackPage && scopedFallbackPage.ok === true) return Object.assign({}, scopedFallbackPage, {
          observationMethod: 'playwright_scoped_light',
          observationSource: 'playwright-scoped-light-after-html-fetch-tls-ssl-failure',
          scopedFallbackAttempted: true
        });
        if (htmlPage && htmlPage.ok === true) return Object.assign({}, htmlPage, {
          observationMethod: 'html_fetch_light',
          observationSource: playwrightPage ? 'html-fetch-light-after-playwright-fallback' : 'html-fetch-light'
        });
        if (htmlPage && scopedFallbackPage) return Object.assign({}, htmlPage, {
          scopedFallbackAttempted: true,
          scopedFallbackError: scopedFallbackPage && scopedFallbackPage.error || null,
          scopedFallbackStatus: scopedFallbackPage && typeof scopedFallbackPage.status !== 'undefined' ? scopedFallbackPage.status : null,
          scopedFallbackObservationMethod: 'playwright_scoped_light'
        });
        return playwrightPage || htmlPage || {
          url: candidate && candidate.url || '',
          finalUrl: candidate && candidate.url || '',
          status: null,
          ok: false,
          pageType: inferSubpageJsonLdPageType(candidate && candidate.url || '', 'generic', []),
          title: '',
          canonical: '',
          h1Count: 0,
          h1Texts: [],
          jsonldTypes: [],
          hasBreadcrumbJsonLd: false,
          hasBreadcrumbUi: false,
          observationMethod: 'unknown',
          error: 'subpage_observation_not_available'
        };
      })
    };
    try {
      const observedItems = Array.isArray(observed && observed.pages)
        ? observed.pages
        : (Array.isArray(observed && observed.observations) ? observed.observations : []);
      console.log('[DEBUG][SUBPAGE_OBSERVATION_RESULT_AUDIT]', JSON.stringify({
        route: '/scrape',
        mode: 'signalsMode=light',
        origin: normalized.origin,
        selectedCandidates: selectedCandidates.slice(0, 5).map(candidate => ({
          url: candidate && candidate.url || '',
          path: candidate && candidate.path || '',
          pageType: candidate && candidate.pageType || '',
          score: candidate && candidate.score,
          source: candidate && candidate.source || '',
          candidateOnly: candidate && candidate.candidateOnly === true
        })),
        observedCount: observedItems.length,
        observedSample: observedItems.slice(0, 5).map(page => ({
          url: page && page.url || '',
          finalUrl: page && page.finalUrl || '',
          ok: page && page.ok,
          status: page && page.status,
          title: page && page.title || '',
          h1Count: page && page.h1Count,
          h1Texts: Array.isArray(page && page.h1Texts) ? page.h1Texts.slice(0, 3) : [],
          jsonLdCount: page && (page.jsonLdCount || page.jsonldCount || page.deepJsonLdScriptCount) || 0,
          jsonldTypes: page && (page.jsonldTypes || page.jsonLdTypes) || [],
          internalLinkCount: page && page.internalLinkCount,
          bodyTextLength: page && page.bodyTextLength,
          error: page && page.error || null
        }))
      }));
    } catch (_) {}
    traceCoverageMemory('observe_after', {
      browserCreated: !reuseContextForObserve,
      contextCreated: true,
      pageCreated: true,
      candidateCount: discovered.totalCandidates,
      observeCount: selectedCandidates.length
    });
    const observations = observed.pages.map(page => compactSubpageJsonLdObservation_(page));
    const payload = {
      topUrl: normalized.topUrl,
      origin: normalized.origin,
      siteMode,
      candidateSummary: {
        sourceSummary: discovered.sourceSummary,
        roleRepresentativeCandidates: discovered.roleRepresentativeCandidates,
        activeObservationInput: roleBasedSelectedCandidates.length ? 'role_based_selected_candidates' : 'legacy_selected_candidates',
        activeObservationInputChanged: roleBasedSelectedCandidates.length > 0,
        totalCandidates: discovered.totalCandidates,
        observedCount: observations.length
      },
      candidates: selectedCandidates,
      observations,
      subpageObservationMode: scopedPlaywrightSubpageObservation
        ? 'scopedPlaywright'
        : (htmlFetchOnlySubpageObservation ? 'htmlFetchOnly' : ''),
      notes: Array.isArray(discovered.notes) ? discovered.notes.slice(0, 10) : []
    };
    const subpageSignals = buildSubpageSignalsV1FromSubpageObservation_(payload);
    if (subpageSignals) {
      geoSignalsV1.subpageSignals = subpageSignals;
      try {
        console.log('[DEBUG][SUBPAGE_SIGNALS_LIGHT]', JSON.stringify({
          observedCount: subpageSignals.observedCount,
          observedPageTypes: subpageSignals.summary && subpageSignals.summary.observedPageTypes,
          pages: subpageSignals.pages.map(page => ({
            path: page.path,
            pageType: page.pageType,
            title: page.title,
            h1: page.h1,
            jsonLdTypes: page.jsonLdTypes,
            hasBreadcrumbList: page.hasBreadcrumbList,
            hasBreadcrumbUi: page.hasBreadcrumbUi,
            hasMain: page.hasMain
          })),
          summary: subpageSignals.summary
        }));
      } catch (_) {}
    }
    const coverageSignalsV1 = buildCoverageSignalsV1FromSubpageObservation_(Object.assign({}, payload, {
      candidates: discovered.candidates
    }));
    const legalOperatorInfo = pickBestLegalOperatorInfo_(observations);
    if (legalOperatorInfo) {
      geoSignalsV1.trustSignals = geoSignalsV1.trustSignals && typeof geoSignalsV1.trustSignals === 'object'
        ? geoSignalsV1.trustSignals
        : {};
      geoSignalsV1.trustSignals.legalOperatorInfo = legalOperatorInfo;
    }
    try {
      console.log('[DEBUG][COVERAGE_CANDIDATE_PAGE_TYPES]', JSON.stringify({
        url: normalized.topUrl,
        candidateCount: discovered.totalCandidates,
        candidatePageTypes: coverageSignalsV1.candidatePageTypes
      }));
    } catch (_) {}
    const coverageSignals = buildGeoSignalsCoverageSignals_(coverageSignalsV1);
    if (!coverageSignals) {
      logPayload.origin = normalized.origin;
      logPayload.reason = 'no_observed_subpages';
      emitHeavySiteAudit('attach_skip_no_observed_subpages', {
        candidateCount: discovered.totalCandidates,
        observeCount: selectedCandidates.length
      });
      traceCoverageMemory('attach_skip_no_observed_subpages', {
        candidateCount: discovered.totalCandidates,
        observeCount: selectedCandidates.length
      });
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
        observedSubpageCount: 0,
        reason: logPayload.reason
      })));
      console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
      return null;
    }
    try {
      const representativeQuality = coverageSignals.representativeObservationQuality || {};
      console.log('[DEBUG][REPRESENTATIVE_OBSERVATION_QUALITY_AUDIT]', JSON.stringify({
        route: '/scrape',
        mode: 'signalsMode=light',
        origin: normalized.origin,
        representativePagesCount: Array.isArray(coverageSignals.representativePages)
          ? coverageSignals.representativePages.length
          : 0,
        qualitySummary: representativeQuality.summary || {},
        pages: Array.isArray(representativeQuality.pages)
          ? representativeQuality.pages.slice(0, 10).map(page => ({
              path: page && page.path || '',
              pageType: page && page.pageType || '',
              quality: page && page.quality || '',
              reasons: Array.isArray(page && page.reasons) ? page.reasons.slice(0, 10) : [],
              observed: page && page.observed || {},
              diagnostics: page && page.diagnostics || {}
            }))
          : []
      }));
    } catch (_) {}
    try {
      console.log('[DEBUG][SUBPAGE_COVERAGE_SIGNALS_FINAL_AUDIT]', JSON.stringify({
        route: '/scrape',
        mode: 'signalsMode=light',
        origin: normalized.origin,
        hasCoverageSignals: !!coverageSignals,
        observedCount: coverageSignals && coverageSignals.observedCount,
        observedSubpageCount: coverageSignals && coverageSignals.observedSubpageCount,
        representativePagesCount: Array.isArray(coverageSignals && coverageSignals.representativePages)
          ? coverageSignals.representativePages.length
          : 0,
        representativePages: Array.isArray(coverageSignals && coverageSignals.representativePages)
          ? coverageSignals.representativePages.slice(0, 10).map(page => ({
              path: page && page.path || '',
              pageType: page && page.pageType || '',
              candidateOnly: page && page.candidateOnly === true,
              reached: page && page.reached === true
            }))
          : [],
        candidatePageTypes: coverageSignals && coverageSignals.candidatePageTypes || {}
      }));
    } catch (_) {}
    try {
      const matrixAudit = buildSubpageCardConnectionMatrixAudit_(coverageSignals);
      console.log('[DEBUG][SUBPAGE_CARD_CONNECTION_MATRIX_AUDIT]', JSON.stringify({
        route: '/scrape',
        mode: 'signalsMode=light',
        origin: normalized.origin,
        hasCoverageSignals: !!coverageSignals,
        sourceKeys: matrixAudit.sourceKeys || [],
        representativePagesCount: matrixAudit.representativePagesCount || 0,
        representativeObservationQualityCount: matrixAudit.representativeObservationQualityCount || 0,
        observedPages: matrixAudit.observedPages || [],
        matrix: matrixAudit.matrix || []
      }));
    } catch (_) {}
    const representativeSignals = buildRepresentativeSignalsV1_({
      siteMode,
      observations,
      subpageSignals,
      coverageSignals
    }, { siteMode });
    geoSignalsV1.representativeSignals = representativeSignals;
    emitRepresentativeSignalsArticleAudit_(representativeSignals);
    const representativeEvidence = buildRepresentativeEvidenceV1_(representativeSignals);
    geoSignalsV1.representativeEvidence = representativeEvidence;
    emitRepresentativeEvidenceArticleAudit_(representativeEvidence);
    const representativeArticleFactsBridgeAudit = buildRepresentativeArticleFactsBridgeAudit_(representativeEvidence, geoSignalsV1.articleSignals || geoSignalsV1.observed && geoSignalsV1.observed.articleSignals);
    geoSignalsV1.representativeArticleFactsBridgeAudit = representativeArticleFactsBridgeAudit;
    emitRepresentativeArticleFactsBridgeAudit_(representativeArticleFactsBridgeAudit);
    const representativeArticleFacts = buildRepresentativeArticleFacts_(representativeEvidence);
    geoSignalsV1.representativeArticleFacts = representativeArticleFacts;
    emitRepresentativeArticleFactsPhase2Audit_(representativeEvidence, representativeArticleFacts);
    const representativeArticleFactsAdoptionAudit = buildRepresentativeArticleFactsAdoptionAudit_(representativeArticleFacts, geoSignalsV1.articleSignals || geoSignalsV1.observed && geoSignalsV1.observed.articleSignals);
    geoSignalsV1.representativeArticleFactsAdoptionAudit = representativeArticleFactsAdoptionAudit;
    emitRepresentativeArticleFactsAdoptionAudit_(representativeArticleFactsAdoptionAudit);
    const representativeArticleFactsBridgeGateAudit = buildRepresentativeArticleFactsBridgeGateAudit_(representativeArticleFacts, representativeArticleFactsAdoptionAudit, geoSignalsV1.articleSignals || geoSignalsV1.observed && geoSignalsV1.observed.articleSignals);
    geoSignalsV1.representativeArticleFactsBridgeGateAudit = representativeArticleFactsBridgeGateAudit;
    emitRepresentativeArticleFactsBridgeGateAudit_(representativeArticleFactsBridgeGateAudit);
    const representativeFactsReadiness = buildRepresentativeFactsReadinessV1_(representativeEvidence);
    geoSignalsV1.representativeFactsReadiness = representativeFactsReadiness;
    emitRepresentativeFactsReadinessAudit_(representativeEvidence, representativeFactsReadiness);
    const representativeFactsBridgeV2Audit = buildRepresentativeFactsBridgeV2Audit_(representativeFactsReadiness);
    geoSignalsV1.representativeFactsBridgeV2Audit = representativeFactsBridgeV2Audit;
    emitRepresentativeFactsBridgeV2Audit_(representativeFactsReadiness, representativeFactsBridgeV2Audit);
    const representativeFactsDiffAudit = buildRepresentativeFactsDiffAuditV1_(representativeEvidence);
    geoSignalsV1.representativeFactsDiffAudit = representativeFactsDiffAudit;
    emitRepresentativeFactsDiffAudit_(representativeEvidence, representativeFactsDiffAudit);
    const representativeFreshnessFactsCandidate = buildRepresentativeFreshnessFactsCandidateV1_(representativeEvidence);
    const rawFreshnessFactsForAudit = geoSignalsV1.freshnessOperationSignals ||
      geoSignalsV1.observed && geoSignalsV1.observed.freshnessOperationSignals ||
      buildMediaArticleLinkFreshnessSignals_(geoSignalsV1, { siteMode, url: normalized.topUrl });
    const freshnessFactsBridgeV2DecisionAudit = buildFreshnessFactsBridgeV2DecisionAudit_(representativeFreshnessFactsCandidate, {
      rawFacts: rawFreshnessFactsForAudit
    });
    geoSignalsV1.freshnessFactsBridgeV2DecisionAudit = freshnessFactsBridgeV2DecisionAudit;
    emitFreshnessFactsBridgeV2DecisionAudit_(freshnessFactsBridgeV2DecisionAudit);
    geoSignalsV1.coverageSignals = coverageSignals;
    emitHeavySiteAudit('attach_done', {
      candidateCount: discovered.totalCandidates,
      selectedCount: selectedCandidates.length,
      observedSubpageCount: coverageSignals.observedSubpageCount,
      representativePagesCount: Array.isArray(coverageSignals.representativePages) ? coverageSignals.representativePages.length : 0
    });
    traceCoverageMemory('attach_done', {
      browserCreated: !(reusePageForDiscover && reuseContextForObserve),
      contextCreated: true,
      pageCreated: true,
      candidateCount: discovered.totalCandidates,
      observeCount: selectedCandidates.length
    });
    logPayload.origin = normalized.origin;
    logPayload.attached = true;
    logPayload.observedSubpageCount = coverageSignals.observedSubpageCount;
    logPayload.observedH1PageCount = coverageSignals.observedH1PageCount;
    logPayload.observedBreadcrumbPageCount = coverageSignals.observedBreadcrumbPageCount;
    logPayload.hasObservedAboutPage = coverageSignals.hasObservedAboutPage;
    logPayload.hasObservedBreadcrumbList = coverageSignals.hasObservedBreadcrumbList;
    logPayload.reason = 'attached';
    console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
      newBrowserCreatedForCoverage: !(reusePageForDiscover && reuseContextForObserve),
      observedSubpageCount: coverageSignals.observedSubpageCount,
      attached: true,
      reason: 'attached'
    })));
    console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
    return coverageSignals;
  } catch (e) {
    logPayload.reason = String(e && (e.message || e) || 'coverage_integration_failed').slice(0, 160);
    emitHeavySiteAudit('attach_error', {
      error: logPayload.reason
    });
    traceCoverageMemory('attach_error', {
      reason: logPayload.reason
    });
    console.log('[DEBUG][GEOSIGNALS_COVERAGE_REUSE_AUDIT]', JSON.stringify(Object.assign({}, auditPayload, {
      reason: logPayload.reason
    })));
    console.log('[DEBUG][GEOSIGNALS_COVERAGE_INTEGRATION]', JSON.stringify(logPayload));
    return null;
  }
}

async function observeSubpageJsonLdLightUrls_(urls, opts = {}) {
  const started = Date.now();
  const normalizedUrls = Array.isArray(urls) ? urls.slice(0, 20) : [];
  const siteMode = normalizeSubpageJsonLdText(opts.siteMode || 'generic').toLowerCase() || 'generic';
  const timeout = Math.max(1000, Math.min(15000, Number(opts.timeout || 8000) || 8000));
  const reuseContext = !!(opts && opts.context);
  const concurrency = reuseContext
    ? 1
    : Math.max(1, Math.min(5, Number(opts.concurrency || 4) || 4));
  const baseOrigin = normalizedUrls.length ? new URL(normalizedUrls[0]).origin : '';
  let browser = null;
  let context = opts && opts.context || null;
  const pages = new Array(normalizedUrls.length);
  try {
    try {
      console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
        phase: 'observe_launch_before',
        browserCreated: false,
        contextCreated: reuseContext,
        pageCreated: false,
        candidateCount: normalizedUrls.length,
        observeCount: normalizedUrls.length
      }));
    } catch (_) {}
    if (!reuseContext) {
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--no-zygote',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });
      try {
        console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
          phase: 'observe_browser_created',
          browserCreated: true,
          contextCreated: false,
          pageCreated: false,
          candidateCount: normalizedUrls.length,
          observeCount: normalizedUrls.length
        }));
      } catch (_) {}
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                   'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                   'Chrome/122.0.0.0 Safari/537.36',
        serviceWorkers: 'allow',
        viewport: { width: 1366, height: 900 },
        javaScriptEnabled: true,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        ignoreHTTPSErrors: true
      });
      try {
        console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
          phase: 'observe_context_created',
          browserCreated: true,
          contextCreated: true,
          pageCreated: false,
          candidateCount: normalizedUrls.length,
          observeCount: normalizedUrls.length
        }));
      } catch (_) {}
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
    } else {
      try {
        console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
          phase: 'observe_reuse_context',
          browserCreated: false,
          contextCreated: true,
          pageCreated: false,
          candidateCount: normalizedUrls.length,
          observeCount: normalizedUrls.length
        }));
      } catch (_) {}
    }
    let nextIndex = 0;
    const workerCount = Math.min(concurrency, normalizedUrls.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < normalizedUrls.length) {
        const index = nextIndex++;
        const url = normalizedUrls[index];
        try {
          let origin = '';
          try { origin = new URL(url).origin; } catch (_) {}
          if (baseOrigin && origin !== baseOrigin) {
            pages[index] = {
              url,
              finalUrl: url,
              status: null,
              ok: false,
              pageType: inferSubpageJsonLdPageType(url, siteMode, []),
              title: '',
              canonical: '',
              h1Count: 0,
              h1Texts: [],
              jsonldTypes: [],
              breadcrumbListCount: 0,
              listItemCount: 0,
              hasBreadcrumbJsonLd: false,
              hasProductJsonLd: false,
              hasFaqJsonLd: false,
              hasArticleJsonLd: false,
              hasBlogPostingJsonLd: false,
              hasBreadcrumbUi: false,
              error: 'origin_mismatch'
            };
            continue;
          }
          try {
            console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
              phase: 'observe_page_before',
              browserCreated: true,
              contextCreated: true,
              pageCreated: false,
              candidateCount: normalizedUrls.length,
              observeCount: normalizedUrls.length
            }));
          } catch (_) {}
          pages[index] = await fetchSubpageJsonLdLight(url, { siteMode, timeout, context });
          try {
            console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
              phase: 'observe_page_after',
              browserCreated: true,
              contextCreated: true,
              pageCreated: true,
              candidateCount: normalizedUrls.length,
              observeCount: normalizedUrls.length
            }));
          } catch (_) {}
        } catch (e) {
          pages[index] = {
            url,
            finalUrl: url,
            status: null,
            ok: false,
            pageType: inferSubpageJsonLdPageType(url, siteMode, []),
            title: '',
            canonical: '',
            h1Count: 0,
            h1Texts: [],
            jsonldTypes: [],
            breadcrumbListCount: 0,
            listItemCount: 0,
            hasBreadcrumbJsonLd: false,
            hasProductJsonLd: false,
            hasFaqJsonLd: false,
            hasArticleJsonLd: false,
            hasBlogPostingJsonLd: false,
            hasBreadcrumbUi: false,
            error: String(e && (e.message || e) || 'fetch_failed').slice(0, 160)
          };
        }
      }
    });
    await Promise.allSettled(workers);
  } catch (e) {
    normalizedUrls.forEach((url, index) => {
      pages[index] = pages[index] || {
        url,
        finalUrl: url,
        status: null,
        ok: false,
        pageType: inferSubpageJsonLdPageType(url, siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        breadcrumbListCount: 0,
        listItemCount: 0,
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: String(e && (e.message || e) || 'playwright_failed').slice(0, 160)
      };
    });
  } finally {
    try { if (context && !reuseContext) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
    try {
      console.log('[DEBUG][COVERAGE_MEMORY_TRACE]', JSON.stringify({
        phase: 'observe_closed',
        browserCreated: false,
        contextCreated: false,
        pageCreated: false,
        candidateCount: normalizedUrls.length,
        observeCount: normalizedUrls.length
      }));
    } catch (_) {}
  }
  const compactPages = pages.map(page => compactSubpageJsonLdObservation_(page));
  return {
    requestedCount: normalizedUrls.length,
    fetchedCount: compactPages.filter(page => page.ok === true).length,
    elapsedMs: Math.max(0, Date.now() - started),
    pages: compactPages,
    summary: {
      hasBreadcrumbJsonLdOnSubpage: compactPages.some(page => page.hasBreadcrumbJsonLd === true),
      hasProductJsonLdOnSubpage: compactPages.some(page => page.hasProductJsonLd === true),
      hasFaqJsonLdOnSubpage: compactPages.some(page => page.hasFaqJsonLd === true),
      hasArticleJsonLdOnSubpage: compactPages.some(page => page.hasArticleJsonLd === true),
      hasBlogPostingJsonLdOnSubpage: compactPages.some(page => page.hasBlogPostingJsonLd === true),
      hasBreadcrumbUiOnSubpage: compactPages.some(page => page.hasBreadcrumbUi === true)
    }
  };
}

app.post('/subpage-jsonld-light', async (req, res) => {
  const started = Date.now();
  const urls = req && req.body && Array.isArray(req.body.urls) ? req.body.urls : null;
  if (!urls) return res.status(400).json({ ok: false, error: 'urls must be an array' });
  if (urls.length > 5) return res.status(400).json({ ok: false, error: 'urls max is 5' });
  const normalizedUrls = [];
  for (const raw of urls) {
    try {
      const u = new URL(String(raw || ''));
      if (!/^https?:$/.test(u.protocol)) throw new Error('unsupported protocol');
      normalizedUrls.push(u.toString());
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'urls must contain only valid http/https URLs' });
    }
  }
  const siteMode = normalizeSubpageJsonLdText(req.body.siteMode || 'generic').toLowerCase() || 'generic';
  const timeout = Math.max(1000, Math.min(15000, Number(req.body.timeout || 8000) || 8000));
  const baseOrigin = normalizedUrls.length ? new URL(normalizedUrls[0]).origin : '';
  console.log('[SUBPAGE_JSONLD_LIGHT][START]', JSON.stringify({
    requestedCount: normalizedUrls.length,
    siteMode,
    timeout
  }));
  let browser = null;
  let context = null;
  let settled = [];
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                 'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                 'Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      ignoreHTTPSErrors: true
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const tasks = normalizedUrls.map(url => {
      let origin = '';
      try { origin = new URL(url).origin; } catch (_) {}
      if (baseOrigin && origin !== baseOrigin) {
        return Promise.resolve({
          url,
          finalUrl: url,
          status: null,
          ok: false,
          pageType: inferSubpageJsonLdPageType(url, siteMode, []),
          title: '',
          canonical: '',
          h1Count: 0,
          h1Texts: [],
          jsonldTypes: [],
          hasBreadcrumbJsonLd: false,
          hasProductJsonLd: false,
          hasFaqJsonLd: false,
          hasArticleJsonLd: false,
          hasBlogPostingJsonLd: false,
          hasBreadcrumbUi: false,
          error: 'origin_mismatch'
        });
      }
      return fetchSubpageJsonLdLight(url, { siteMode, timeout, context });
    });
    settled = await Promise.allSettled(tasks);
  } catch (e) {
    settled = normalizedUrls.map(url => ({
      status: 'fulfilled',
      value: {
        url,
        finalUrl: url,
        status: null,
        ok: false,
        pageType: inferSubpageJsonLdPageType(url, siteMode, []),
        title: '',
        canonical: '',
        h1Count: 0,
        h1Texts: [],
        jsonldTypes: [],
        hasBreadcrumbJsonLd: false,
        hasProductJsonLd: false,
        hasFaqJsonLd: false,
        hasArticleJsonLd: false,
        hasBlogPostingJsonLd: false,
        hasBreadcrumbUi: false,
        error: String(e && (e.message || e) || 'playwright_failed').slice(0, 160)
      }
    }));
  } finally {
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
  }
  const pages = settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const url = normalizedUrls[index] || '';
    return {
      url,
      finalUrl: url,
      status: null,
      ok: false,
      pageType: inferSubpageJsonLdPageType(url, siteMode, []),
      title: '',
      canonical: '',
      h1Count: 0,
      h1Texts: [],
      jsonldTypes: [],
      hasBreadcrumbJsonLd: false,
      hasProductJsonLd: false,
      hasFaqJsonLd: false,
      hasArticleJsonLd: false,
      hasBlogPostingJsonLd: false,
      hasBreadcrumbUi: false,
      error: String(result.reason && (result.reason.message || result.reason) || 'fetch_failed').slice(0, 160)
    };
  });
  pages.forEach(page => {
    console.log('[SUBPAGE_JSONLD_LIGHT][PAGE]', JSON.stringify({
      url: page.url,
      status: page.status,
      ok: page.ok,
      pageType: page.pageType,
      title: page.title,
      domJsonLdScriptCount: page.domJsonLdScriptCount,
      deepJsonLdScriptCount: page.deepJsonLdScriptCount,
      h1Count: page.h1Count,
      jsonldTypes: page.jsonldTypes,
      waitedMs: page.waitedMs,
      waitStrategy: page.waitStrategy,
      hasBreadcrumbJsonLd: page.hasBreadcrumbJsonLd,
      hasProductJsonLd: page.hasProductJsonLd,
      hasFaqJsonLd: page.hasFaqJsonLd,
      hasArticleJsonLd: page.hasArticleJsonLd,
      hasBlogPostingJsonLd: page.hasBlogPostingJsonLd,
      hasBreadcrumbUi: page.hasBreadcrumbUi,
      error: page.error
    }));
  });
  const summary = {
    hasBreadcrumbJsonLdOnSubpage: pages.some(page => page.hasBreadcrumbJsonLd === true),
    hasProductJsonLdOnSubpage: pages.some(page => page.hasProductJsonLd === true),
    hasFaqJsonLdOnSubpage: pages.some(page => page.hasFaqJsonLd === true),
    hasArticleJsonLdOnSubpage: pages.some(page => page.hasArticleJsonLd === true),
    hasBlogPostingJsonLdOnSubpage: pages.some(page => page.hasBlogPostingJsonLd === true),
    hasBreadcrumbUiOnSubpage: pages.some(page => page.hasBreadcrumbUi === true)
  };
  const payload = {
    ok: true,
    mode: 'subpageJsonLdLight',
    siteMode,
    requestedCount: normalizedUrls.length,
    fetchedCount: pages.filter(page => page.ok === true).length,
    elapsedMs: Math.max(0, Date.now() - started),
    pages: pages.map(page => {
      const out = Object.assign({}, page);
      delete out.parseErrors;
      delete out.domJsonLdScriptCount;
      delete out.deepJsonLdScriptCount;
      delete out.readyState;
      delete out.locationHref;
      delete out.bodyTextLength;
      delete out.htmlLength;
      delete out.scriptCount;
      delete out.moduleScriptCount;
      delete out.nextDataExists;
      delete out.nuxtDataExists;
      delete out.shadowHostCount;
      delete out.hydrationMetrics;
      delete out.webdriverValue;
      delete out.launchProfile;
      delete out.jsErrors;
      delete out.failedRequests;
      delete out.consoleErrors;
      delete out.waitedMs;
      delete out.waitStrategy;
      return out;
    }),
    summary
  };
  console.log('[SUBPAGE_JSONLD_LIGHT][DONE]', JSON.stringify({
    requestedCount: payload.requestedCount,
    fetchedCount: payload.fetchedCount,
    elapsedMs: payload.elapsedMs,
    summary
  }));
  console.log('[DEBUG][SUBPAGE_JSONLD_LIGHT_PLAYWRIGHT_OBSERVED]', JSON.stringify({
    requestedCount: payload.requestedCount,
    fetchedCount: payload.fetchedCount,
    elapsedMs: payload.elapsedMs,
    pages: pages.map(p => ({
      url: p.url,
      finalUrl: p.finalUrl,
      status: p.status,
      ok: p.ok,
      title: p.title,
      domJsonLdScriptCount: p.domJsonLdScriptCount,
      deepJsonLdScriptCount: p.deepJsonLdScriptCount,
      h1Count: p.h1Count,
      jsonldTypes: p.jsonldTypes,
      waitedMs: p.waitedMs,
      waitStrategy: p.waitStrategy,
      hasBreadcrumbJsonLd: p.hasBreadcrumbJsonLd,
      hasBreadcrumbUi: p.hasBreadcrumbUi,
      error: p.error
    }))
  }));
  pages.forEach(p => {
    console.log('[DEBUG][SUBPAGE_JSONLD_LIGHT_PAGE_DIAG]', JSON.stringify({
      url: p.url,
      finalUrl: p.finalUrl,
      status: p.status,
      ok: p.ok,
      readyState: p.readyState,
      locationHref: p.locationHref,
      title: p.title,
      domJsonLdScriptCount: p.domJsonLdScriptCount,
      deepJsonLdScriptCount: p.deepJsonLdScriptCount,
      h1Count: p.h1Count,
      bodyTextLength: p.bodyTextLength,
      htmlLength: p.htmlLength,
      scriptCount: p.scriptCount,
      moduleScriptCount: p.moduleScriptCount,
      nextDataExists: p.nextDataExists,
      nuxtDataExists: p.nuxtDataExists,
      shadowHostCount: p.shadowHostCount,
      hydrationMetrics: p.hydrationMetrics ? {
        waitMs: p.hydrationMetrics.waitMs,
        bodyTextBeforeWait: p.hydrationMetrics.bodyTextBeforeWait,
        bodyTextAfterWait: p.hydrationMetrics.bodyTextAfterWait,
        anchorCountBeforeWait: p.hydrationMetrics.anchorCountBeforeWait,
        anchorCountAfterWait: p.hydrationMetrics.anchorCountAfterWait,
        navLinkCountBeforeWait: p.hydrationMetrics.navLinkCountBeforeWait,
        navLinkCountAfterWait: p.hydrationMetrics.navLinkCountAfterWait,
        shadowHostCountBeforeWait: p.hydrationMetrics.shadowHostCountBeforeWait,
        shadowHostCountAfterWait: p.hydrationMetrics.shadowHostCountAfterWait,
        shadowJsonLdCountBeforeWait: p.hydrationMetrics.shadowJsonLdCountBeforeWait,
        shadowJsonLdCountAfterWait: p.hydrationMetrics.shadowJsonLdCountAfterWait,
        shadowH1CountBeforeWait: p.hydrationMetrics.shadowH1CountBeforeWait,
        shadowH1CountAfterWait: p.hydrationMetrics.shadowH1CountAfterWait,
        improvedBodyText: p.hydrationMetrics.improvedBodyText,
        improvedLinks: p.hydrationMetrics.improvedLinks,
        warningTextBeforeWait: p.hydrationMetrics.warningTextBeforeWait,
        warningTextAfterWait: p.hydrationMetrics.warningTextAfterWait,
        error: p.hydrationMetrics.error || null
      } : null,
      webdriverValue: p.webdriverValue,
      launchProfile: p.launchProfile,
      jsonldTypes: p.jsonldTypes,
      waitedMs: p.waitedMs,
      waitStrategy: p.waitStrategy,
      jsErrors: Array.isArray(p.jsErrors) ? p.jsErrors.slice(0, 10) : [],
      consoleErrors: Array.isArray(p.consoleErrors) ? p.consoleErrors.slice(0, 10) : [],
      failedRequests: Array.isArray(p.failedRequests) ? p.failedRequests.slice(0, 10) : [],
      error: p.error
    }));
  });
  return res.status(200).json(payload);
});

app.post('/discover-and-observe-subpages-light', async (req, res) => {
  const rawTopUrl = req && req.body && (req.body.topUrl || req.body.url);
  const normalized = normalizeDiscoverTopUrl(rawTopUrl);
  if (!normalized.ok) return res.status(400).json({ ok: false, error: normalized.error });
  const limit = Math.max(1, Math.min(20, Number(req.body && (req.body.maxObserve || req.body.limit) || 10) || 10));
  const candidateLimit = Math.max(
    limit,
    Math.min(50, Number(req.body && req.body.maxCandidates || 0) || Math.max(limit * 3, 20))
  );
  const siteMode = normalizeSubpageJsonLdText(req.body && req.body.siteMode || 'generic').toLowerCase() || 'generic';
  const discovered = await discoverSubpageCandidatesLightData_(normalized.topUrl, normalized.origin, candidateLimit, { siteMode });
  const legacySelectedCandidates = discovered.candidates.slice(0, limit);
  const roleBasedSelection = buildRoleBasedSelectedCandidates_(discovered.candidates, { siteMode, maxObserve: limit });
  const roleBasedSelectedCandidates = Array.isArray(roleBasedSelection.candidates) ? roleBasedSelection.candidates : [];
  const selectedCandidates = roleBasedSelectedCandidates.length ? roleBasedSelectedCandidates : legacySelectedCandidates;
  const selectedPaths = selectedCandidates.map(getCoverageCandidatePath_).filter(Boolean);
  const legacySelectedPaths = legacySelectedCandidates.map(getCoverageCandidatePath_).filter(Boolean);
  const roleBasedSelectedPaths = roleBasedSelectedCandidates.map(getCoverageCandidatePath_).filter(Boolean);
  try {
    console.log('[DEBUG][DISCOVER_OBSERVE_ROLE_BASED_SELECTED_CANDIDATES_AUDIT]', JSON.stringify({
      origin: normalized.origin,
      mode: 'active_for_discover_observe_observation',
      siteTypeForRolePriority: roleBasedSelection.siteTypeForRolePriority || 'default',
      rolePriority: Array.isArray(roleBasedSelection.rolePriority) ? roleBasedSelection.rolePriority : [],
      legacySelectedPaths,
      roleBasedSelectedPaths,
      finalSelectedPaths: selectedPaths,
      finalSelectedPageTypes: selectedCandidates.map(candidate => inferDiscoverCandidatePageType_(candidate, siteMode)).filter(Boolean),
      usedRoleBasedSelection: roleBasedSelectedCandidates.length > 0,
      limit,
      note: 'discover_observe_observation_input_switched_to_role_based'
    }));
  } catch (_) {}
  const urls = selectedCandidates.map(candidate => candidate.url);
  const observed = await observeSubpageJsonLdLightUrls_(urls, {
    siteMode,
    timeout: req.body && req.body.timeout,
    concurrency: 3
  });
  const observations = observed.pages.map(page => compactSubpageJsonLdObservation_(page));
  const observationErrors = observations
    .map((page, index) => {
      if (page && page.ok === true) return null;
      const candidate = selectedCandidates[index] || {};
      return {
        url: page && page.url || candidate.url || '',
        source: candidate.source || '',
        message: String(page && page.error || 'observation_failed').slice(0, 160)
      };
    })
    .filter(Boolean);
  const payload = {
    ok: true,
    mode: 'discoverAndObserveSubpagesLight',
    topUrl: normalized.topUrl,
    origin: normalized.origin,
    siteMode,
    limit,
    candidateSummary: {
      sourceSummary: discovered.sourceSummary,
      roleRepresentativeCandidates: discovered.roleRepresentativeCandidates,
      totalCandidates: discovered.totalCandidates,
      observedCount: observations.length
    },
    candidates: selectedCandidates,
    observations,
    errors: [].concat(discovered.errors || [], observationErrors)
  };
  payload.coverageSignalsV1 = buildCoverageSignalsV1FromSubpageObservation_(Object.assign({}, payload, {
    candidates: discovered.candidates
  }));
  const representativeSignals = buildRepresentativeSignalsV1_(payload, { siteMode });
  payload.coverageSignalsV1.representativeSignals = representativeSignals;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeSignals
  };
  emitRepresentativeSignalsArticleAudit_(representativeSignals);
  const representativeEvidence = buildRepresentativeEvidenceV1_(representativeSignals);
  payload.coverageSignalsV1.representativeEvidence = representativeEvidence;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeEvidence
  };
  emitRepresentativeEvidenceArticleAudit_(representativeEvidence);
  const representativeArticleFactsBridgeAudit = buildRepresentativeArticleFactsBridgeAudit_(representativeEvidence, payload.geoSignalsV1 && payload.geoSignalsV1.articleSignals || payload.geoSignalsV1 && payload.geoSignalsV1.observed && payload.geoSignalsV1.observed.articleSignals);
  payload.coverageSignalsV1.representativeArticleFactsBridgeAudit = representativeArticleFactsBridgeAudit;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeArticleFactsBridgeAudit
  };
  emitRepresentativeArticleFactsBridgeAudit_(representativeArticleFactsBridgeAudit);
  const representativeArticleFacts = buildRepresentativeArticleFacts_(representativeEvidence);
  payload.coverageSignalsV1.representativeArticleFacts = representativeArticleFacts;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeArticleFacts
  };
  emitRepresentativeArticleFactsPhase2Audit_(representativeEvidence, representativeArticleFacts);
  const representativeArticleFactsAdoptionAudit = buildRepresentativeArticleFactsAdoptionAudit_(representativeArticleFacts, payload.geoSignalsV1 && payload.geoSignalsV1.articleSignals || payload.geoSignalsV1 && payload.geoSignalsV1.observed && payload.geoSignalsV1.observed.articleSignals);
  payload.coverageSignalsV1.representativeArticleFactsAdoptionAudit = representativeArticleFactsAdoptionAudit;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeArticleFactsAdoptionAudit
  };
  emitRepresentativeArticleFactsAdoptionAudit_(representativeArticleFactsAdoptionAudit);
  const representativeArticleFactsBridgeGateAudit = buildRepresentativeArticleFactsBridgeGateAudit_(representativeArticleFacts, representativeArticleFactsAdoptionAudit, payload.geoSignalsV1 && payload.geoSignalsV1.articleSignals || payload.geoSignalsV1 && payload.geoSignalsV1.observed && payload.geoSignalsV1.observed.articleSignals);
  payload.coverageSignalsV1.representativeArticleFactsBridgeGateAudit = representativeArticleFactsBridgeGateAudit;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeArticleFactsBridgeGateAudit
  };
  emitRepresentativeArticleFactsBridgeGateAudit_(representativeArticleFactsBridgeGateAudit);
  const representativeFactsReadiness = buildRepresentativeFactsReadinessV1_(representativeEvidence);
  payload.coverageSignalsV1.representativeFactsReadiness = representativeFactsReadiness;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeFactsReadiness
  };
  emitRepresentativeFactsReadinessAudit_(representativeEvidence, representativeFactsReadiness);
  const representativeFactsBridgeV2Audit = buildRepresentativeFactsBridgeV2Audit_(representativeFactsReadiness);
  payload.coverageSignalsV1.representativeFactsBridgeV2Audit = representativeFactsBridgeV2Audit;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeFactsBridgeV2Audit
  };
  emitRepresentativeFactsBridgeV2Audit_(representativeFactsReadiness, representativeFactsBridgeV2Audit);
  const representativeFactsDiffAudit = buildRepresentativeFactsDiffAuditV1_(representativeEvidence);
  payload.coverageSignalsV1.representativeFactsDiffAudit = representativeFactsDiffAudit;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    representativeFactsDiffAudit
  };
  emitRepresentativeFactsDiffAudit_(representativeEvidence, representativeFactsDiffAudit);
  const representativeFreshnessFactsCandidate = buildRepresentativeFreshnessFactsCandidateV1_(representativeEvidence);
  const freshnessFactsBridgeV2DecisionAudit = buildFreshnessFactsBridgeV2DecisionAudit_(representativeFreshnessFactsCandidate);
  payload.coverageSignalsV1.freshnessFactsBridgeV2DecisionAudit = freshnessFactsBridgeV2DecisionAudit;
  payload.geoSignalsV1 = {
    ...(payload.geoSignalsV1 || {}),
    freshnessFactsBridgeV2DecisionAudit
  };
  emitFreshnessFactsBridgeV2DecisionAudit_(freshnessFactsBridgeV2DecisionAudit);
  try {
    const representativeQuality = payload.coverageSignalsV1.representativeObservationQuality || {};
    console.log('[DEBUG][REPRESENTATIVE_OBSERVATION_QUALITY_AUDIT]', JSON.stringify({
      route: '/discover-and-observe-subpages-light',
      mode: payload.mode,
      origin: payload.origin,
      representativePagesCount: Array.isArray(payload.coverageSignalsV1.representativePages)
        ? payload.coverageSignalsV1.representativePages.length
        : 0,
      qualitySummary: representativeQuality.summary || {},
      pages: Array.isArray(representativeQuality.pages)
        ? representativeQuality.pages.slice(0, 10).map(page => ({
            path: page && page.path || '',
            pageType: page && page.pageType || '',
            quality: page && page.quality || '',
            reasons: Array.isArray(page && page.reasons) ? page.reasons.slice(0, 10) : [],
            observed: page && page.observed || {},
            diagnostics: page && page.diagnostics || {}
          }))
        : []
    }));
  } catch (_) {}
  console.log('[DEBUG][COVERAGE_SIGNALS_V1_SUMMARY]', JSON.stringify({
    topUrl: payload.topUrl,
    origin: payload.origin,
    observedSubpageCount: payload.coverageSignalsV1.observedSubpageCount,
    observedH1PageCount: payload.coverageSignalsV1.observedH1PageCount,
    observedBreadcrumbPageCount: payload.coverageSignalsV1.observedBreadcrumbPageCount,
    hasObservedAboutPage: payload.coverageSignalsV1.hasObservedAboutPage,
    hasObservedBreadcrumbList: payload.coverageSignalsV1.hasObservedBreadcrumbList,
    representativePageCount: Array.isArray(payload.coverageSignalsV1.representativePages)
      ? payload.coverageSignalsV1.representativePages.length
      : 0
  }));
  return res.status(200).json(payload);
});

// -------------------- Simple in-memory cache --------------------
const CACHE_TTL_MS      = Number(process.env.SCRAPE_CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 既定6h
const CACHE_MAX_ENTRIES = Number(process.env.SCRAPE_CACHE_MAX   || 300);                 // 既定300件
const scrapeCache = new Map(); // key=url, val={ ts, json }

// LRU風に古いものを落とす
function cacheSet(url, json) {
  if (!url) return;
  if (scrapeCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = scrapeCache.keys().next().value; // Mapは挿入順
    if (firstKey) scrapeCache.delete(firstKey);
  }
  scrapeCache.set(url, { ts: Date.now(), json });
}
function cacheGet(url) {
  const entry = url ? scrapeCache.get(url) : null;
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age > CACHE_TTL_MS) { scrapeCache.delete(url); return null; }
  // LRU リフレッシュ
  scrapeCache.delete(url);
  scrapeCache.set(url, entry);
  return { age, json: entry.json };
}

// -------------------- ユーティリティ --------------------
function uniq(a){ return Array.from(new Set((a||[]).filter(Boolean))); }
function stripTags(s){ return String(s||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function digitsOnly(s){ return String(s||'').replace(/\D+/g,''); }

function normalizeJpPhone(raw){
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^\+81[-\s()]?/, '0');   // +81→0
  s = s.replace(/[^\d-]/g, '');
  const d = s.replace(/-/g,'');
  if (!/^0\d{8,10}$/.test(d)) return null;
  if (/^0[36]\d{8}$/.test(d)) return d.replace(/^(\d{2})(\d{4})(\d{4})$/, '$1-$2-$3'); // 03/06
  if (/^\d{11}$/.test(d))     return d.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1-$2-$3'); // 4-3-4
  if (/^\d{10}$/.test(d))     return d.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3'); // 3-3-4
  return d.replace(/^(\d{2,4})(\d{2,4})(\d{4})$/, '$1-$2-$3');
}
function looksLikeZip7(s){ return /^〒?\d{3}-?\d{4}$/.test(String(s).trim()); }
function decodeUnicodeEscapes(s){
  return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}
// ===== JSON-LD 抽出・正規化まわり =====

// URL 正規化（クエリ・ハッシュ除去）
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return String(u || '');
  }
}

// HTML文字列から <script type="application/ld+json"> を全部抜いて JSON.parse
function extractJsonLdFromHtml(html) {
  const out = [];
  if (!html) return out;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    try {
      // JSON-LD には配列とオブジェクトの両方が来る
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch(_) {}
  }
  return out;
}

// === [COVNAV][NODE-DETECT v1] HTMLから会社情報/サービス/お問い合わせ/FAQナビをざっくり検出 ===
function detectCoverageNavFromHtmlNode(html) {
  try {
    html = String(html || '');
    if (!html) {
      return {
        hasCompanyNav: false,
        hasServiceNav: false,
        hasContactNav: false,
        hasFaqNav:     false
      };
    }

    const htmlLower = html.toLowerCase();

    const hasJP = (re) => {
      try { return re.test(html); } catch { return false; }
    };
    const hasEN = (re) => {
      try { return re.test(htmlLower); } catch { return false; }
    };

    // 会社情報 / 企業情報 / コーポレート系
    const hasCompanyNav =
      hasJP(/会社情報|会社概要|企業情報|企業概要|会社案内/) ||
      hasEN(/corporate\s+profile|corporate\s+info|about\s+us|about\s+company/);

    // サービス / 事業内容 / ソリューション / 製品
    const hasServiceNav =
      hasJP(/サービス(一覧|紹介)?|事業内容|事業紹介|ソリューション|製品情報|プロダクト/) ||
      hasEN(/services|our\s+services|products|solutions/);

    // お問い合わせ / 資料請求 / CONTACT
    const hasContactNav =
      hasJP(/お問い合わせ|お問合せ|問合せ|お問い合せ|資料請求/) ||
      hasEN(/contact\s*us|contact/);

    // FAQ / よくある質問 / Q&A
    const hasFaqNav =
      hasJP(/FAQ|ＦＡＱ|よくある質問|よくあるご質問|Q＆A|Q&A/) ||
      hasEN(/faq/);

    return {
      hasCompanyNav: !!hasCompanyNav,
      hasServiceNav: !!hasServiceNav,
      hasContactNav: !!hasContactNav,
      hasFaqNav:     !!hasFaqNav
    };
  } catch {
    return {
      hasCompanyNav: false,
      hasServiceNav: false,
      hasContactNav: false,
      hasFaqNav:     false
    };
  }
}

// JSON-LD から Organization/Corporation 類や住所/電話/設立が入っていそうなノードだけを抽出
function pickOrgNodes(jsonldArray) {
  const arr = Array.isArray(jsonldArray) ? jsonldArray : [];
  const okType = /^(Organization|Corporation|LocalBusiness|NGO|EducationalOrganization|GovernmentOrganization)$/i;
  const picked = [];

  const flatten = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(flatten); return; }
    if (node['@graph']) { flatten(node['@graph']); }
    if (node['@type']) {
      const t = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type']||'');
      if (okType.test(t)) picked.push(node);
    }
  };

  arr.forEach(flatten);
  return picked.length ? picked : arr; // 見つからなければ全体を返す（比較用）
}

// GTM/外部タグの有無を検知（json-ld 注入のリスク記録用）
function hasGtmOrExternal(html) {
  if (!html) return false;
  return /googletagmanager\.com|googletagservices\.com|gtm\.js|google-analytics\.com/i.test(html);
}

// トップと /about の JSON-LD を比較して “/about 優先” の Organization 候補を返す
function preferAboutJsonLd(topArr, aboutArr) {
  const topOrg = pickOrgNodes(topArr);
  const aboutOrg = pickOrgNodes(aboutArr);
  if (aboutOrg && aboutOrg.length) return aboutOrg;  // /about を優先
  return topOrg || [];
}

// ====== PHONE scoring & picking (代表電話ラベル優先) ======
function isDummyPhone(n){
  if (!n) return true;
  const d = String(n).replace(/[^\d]/g, '');
  if (/^(012|000|007|017|089)/.test(d)) return true;         // 典型ダミー/π断片
  if (/(\d)\1{3,}/.test(d)) return true;                     // 3333, 0000 など
  if (n === '03-3333-3333') return true;                     // よくあるダミー
  return false;
}
function scorePhoneBasic(n){
  let s = 0;
  if (/^03-/.test(n)) s += 3;       // 都内
  else if (/^06-/.test(n)) s += 2;  // 大阪
  if (isDummyPhone(n)) s -= 10;
  return s;
}
function pickBestPhone({ telLinks=[], phones=[], labelHits=[], corpusText='' } = {}){
  const labeled = Array.from(new Set(labelHits
    .map(normalizeJpPhone)
    .filter(n => n && !isDummyPhone(n))));
  if (labeled.length) return labeled[0];
  const DUMMY_PREFIX = /^(007|017|089|000)/;
  for (const raw of telLinks) {
    const n = normalizeJpPhone(raw);
    if (!n) continue;
    const digits = n.replace(/-/g,'');
    if (DUMMY_PREFIX.test(digits)) continue;
    if (!isDummyPhone(n)) return n;
  }
  const cand = [];
  for (const raw of phones) {
    const n = normalizeJpPhone(raw);
    if (!n || isDummyPhone(n)) continue;
    const nd = (n||'').replace(/\D+/g,'');
    const cd = String(corpusText||'').replace(/\D+/g,'');
    const ctx = (nd && cd.includes(nd)) ? 25 : 0;
    cand.push({ n, s: scorePhoneBasic(n) + ctx });
  }
  cand.sort((a,b) => b.s - a.s);
  return cand.length ? cand[0].n : null;
}

const PREF_RE = /(北海道|東京都|(?:京都|大阪)府|..県)/;
function parseBestAddressFromLines(lines){
  if (!lines || !lines.length) return null;
  const cleaned = lines.map(stripTags).filter(Boolean);
  for (const line of cleaned){
    const mZip  = line.match(/〒?\s?(\d{3})-?(\d{4})/);
    const mPref = line.match(PREF_RE);
    if (!mZip || !mPref) continue;

    const postal = mZip[1] + '-' + mZip[2];
    const pref   = mPref[0];
    const afterPref = line.slice(line.indexOf(pref) + pref.length).trim();

    const locM = afterPref.match(/^([^\s、,，]+?(市|区|郡|町|村))/);
    const locality = locM ? locM[1] : '';

    let rest = afterPref.slice(locality.length).replace(/^、|^,|^，/, '').trim();
    rest = rest.replace(/^〒?\s?\d{3}-?\d{4}\s*/, '').trim();

    const addr = {
      postalCode: postal,
      addressRegion: pref,
      addressLocality: locality || undefined,
      streetAddress: rest || undefined,
      addressCountry: 'JP'
    };
    return addr;
  }
  return null;
}

// -------------------- 設立（STRICT: DOM/HTML構造のみ） --------------------
const FOUNDED_MODE = process.env.SCRAPE_FOUNDED_MODE || 'strict'; // 'strict' | 'off'

function parseJpDateToISO(input) {
  if (!input) return '';
  const t = String(input).replace(/\s+/g, '');
  const m = t.match(/((?:19|20)\d{2})\D{0,5}(\d{1,2})\D{0,5}(\d{1,2})/);
  if (!m) return '';
  const Y = String(m[1]).padStart(4, '0');
  const M = String(m[2]).padStart(2, '0');
  const D = String(m[3]).padStart(2, '0');
  const iso = `${Y}-${M}-${D}`;
  const dt = new Date(iso);
  return (!Number.isNaN(+dt) && (dt.getUTCMonth() + 1) === Number(M)) ? iso : '';
}

async function getFoundingFromDOM(page) {
  try {
    const txt = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      // 1) <dl><dt>設立</dt><dd>…</dd>
      for (const dt of Array.from(document.querySelectorAll('dl dt'))) {
        if (/設立|創業/.test(dt.textContent || '')) {
          const dd = dt.nextElementSibling;
          if (dd) return clean(dd.textContent || '');
        }
      }
      // 2) <table><th>設立</th><td>…</td>
      for (const th of Array.from(document.querySelectorAll('table th'))) {
        if (/設立|創業/.test(th.textContent || '')) {
          const td = th.nextElementSibling;
          if (td) return clean(td.textContent || '');
        }
      }
      return '';
    }).catch(() => '');
    return parseJpDateToISO(txt) || '';
  } catch { return ''; }
}

function getFoundingFromHTML(html) {
  if (!html) return '';
  const h = String(html);

  // dt/dd
  let m = h.match(/<dt[^>]*>\s*(?:設立|創業)\s*<\/dt>[\s\S]{0,200}?<dd[^>]*>\s*([\s\S]*?)\s*<\/dd>/i);
  if (m && m[1]) {
    const raw = m[1].replace(/<[^>]+>/g, ' ');
    const iso = parseJpDateToISO(raw);
    if (iso) return iso;
  }
  // th/td
  m = h.match(/<th[^>]*>\s*(?:設立|創業)\s*<\/th>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/i);
  if (m && m[1]) {
    const raw = m[1].replace(/<[^>]+>/g, ' ');
    const iso = parseJpDateToISO(raw);
    if (iso) return iso;
  }
  // タグ剥がし後の「設立/創業 19xx …」
  const flat = h.replace(/<[^>]+>/g, ' ');
  const near = flat.match(/(設立|創業)[^\d]{0,30}((?:19|20)\d{2})[^\d]{0,8}(\d{1,2})[^\d]{0,8}(\d{1,2})/);
  if (near) {
    return parseJpDateToISO(`${near[2]}-${near[3]}-${near[4]}`);
  }
  return '';
}

// ================== Scoring core (add to index.js) ==================
const cheerio = require('cheerio');

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function pct(x, min, max){
  if (max <= min) return 0;
  return clamp01((x - min) / (max - min));
}
function toScore(x){ return Math.round(clamp01(x) * 100); }
function safe(s){ return (s==null?'':String(s)); }

function parseJsonLdList(jsonldRaw) {
  // jsonldRaw は配列 or 文字列 or オブジェクトの可能性がある
  if (!jsonldRaw) return [];
  if (Array.isArray(jsonldRaw)) return jsonldRaw.filter(Boolean);
  if (typeof jsonldRaw === 'string') {
    try { 
      const v = JSON.parse(jsonldRaw);
      return Array.isArray(v) ? v : [v];
    } catch { return []; }
  }
  if (typeof jsonldRaw === 'object') return [jsonldRaw];
  return [];
}
function flatTypesFromJsonLd(arr) {
  const types = new Set();
  for (const node of arr) {
    const t = node && node['@type'];
    if (!t) continue;
    if (Array.isArray(t)) t.forEach(x => types.add(String(x)));
    else types.add(String(t));
    // @graph 内まで掘る
    if (node['@graph'] && Array.isArray(node['@graph'])) {
      for (const g of node['@graph']) {
        const tg = g && g['@type'];
        if (Array.isArray(tg)) tg.forEach(x => types.add(String(x)));
        else if (tg) types.add(String(tg));
      }
    }
  }
  return Array.from(types);
}
function classifyJsonLdTypesForSeo(types) {
  const rawTypes = Array.from(new Set((Array.isArray(types) ? types : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean))).slice(0, 80);
  const seoTypeAllowList = new Set([
    'organization', 'website', 'webpage', 'breadcrumblist', 'faqpage',
    'product', 'offer', 'aggregateoffer', 'article', 'newsarticle', 'blogposting',
    'localbusiness', 'corporation', 'service', 'contactpoint', 'postaladdress',
    'person', 'place', 'itemlist', 'imageobject', 'logo'
  ]);
  const telemetryTypes = [];
  const nonSeoTypes = [];
  const seoTypes = [];
  const excludedFromSeoTypes = [];
  rawTypes.forEach((type) => {
    const lower = String(type || '').trim().toLowerCase();
    const isTelemetry =
      /^type\.googleapis\.com\//i.test(type) ||
      /(^|[./])shopify\.event[./]/i.test(type) ||
      /buyerevent/i.test(type) ||
      /(analytics|telemetry|tracking|event)$/i.test(type);
    const isSeo = !isTelemetry && (seoTypeAllowList.has(lower) || /^https?:\/\/schema\.org\//i.test(type));
    if (isSeo) {
      seoTypes.push(type);
    } else {
      nonSeoTypes.push(type);
      excludedFromSeoTypes.push(type);
      if (isTelemetry) telemetryTypes.push(type);
    }
  });
  const seoSet = new Set(seoTypes.map((t) => String(t || '').toLowerCase().replace(/^https?:\/\/schema\.org\//i, '')));
  return {
    rawTypes,
    seoTypes: Array.from(new Set(seoTypes)).slice(0, 50),
    nonSeoTypes: Array.from(new Set(nonSeoTypes)).slice(0, 50),
    telemetryTypes: Array.from(new Set(telemetryTypes)).slice(0, 50),
    excludedFromSeoTypes: Array.from(new Set(excludedFromSeoTypes)).slice(0, 50),
    hasSeoJsonLd: seoTypes.length > 0,
    hasWebsite: seoSet.has('website'),
    hasOrganization: seoSet.has('organization') || seoSet.has('corporation') || seoSet.has('localbusiness'),
    hasBreadcrumbList: seoSet.has('breadcrumblist'),
    hasFAQPage: seoSet.has('faqpage'),
    typeClassificationSource: 'balanced_unified_schema_type_filter'
  };
}
function collectGeoThemeSignalsLight_(input = {}) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const uniq = (items, max = 20) => {
    const seen = new Set();
    const out = [];
    (Array.isArray(items) ? items : []).forEach((item) => {
      const v = clean(item);
      if (!v) return;
      const key = v.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(v);
    });
    return out.slice(0, max);
  };
  const clip = (v, max = 160) => clean(v).slice(0, max);
  const termsBySignal = {
    comparison_support: ['比較', '違い', '選び方', '比較表', '他社', '種類', 'おすすめ', 'compare', 'comparison'],
    scenario_support: ['利用シーン', 'こんな方', '用途', '目的別', 'ケース', 'example', 'use case'],
    evidence_support: ['実績', '事例', '導入', '利用者数', '口コミ', 'レビュー', 'No.1', '数値根拠', 'case study']
  };
  const headingTexts = uniq(input.headings || [], 30).map((text) => clip(text, 120));
  const navLinkTexts = uniq(input.navTexts || [], 50).map((text) => clip(text, 120));
  const bodyText = clip(input.bodyTextSample || '', 800);
  const bodyWindows = [];
  if (bodyText) {
    bodyWindows.push(bodyText);
    bodyText.split(/[。．.!?！？\n]/).map(clean).filter(Boolean).slice(0, 12).forEach((text) => bodyWindows.push(text));
  }
  const checkedTextLength = bodyText.length + headingTexts.join(' ').length + navLinkTexts.join(' ').length;
  const includesTerm = (text, term) => {
    const t = clean(term);
    if (!t) return false;
    return /^[a-z0-9\s./+-]+$/i.test(t)
      ? clean(text).toLowerCase().indexOf(t.toLowerCase()) >= 0
      : clean(text).indexOf(t) >= 0;
  };
  const findMatches = (texts, terms, maxItems, maxTextLen) => {
    const matches = [];
    const matchedTerms = [];
    (Array.isArray(texts) ? texts : []).forEach((text) => {
      const hitTerms = terms.filter((term) => includesTerm(text, term));
      if (!hitTerms.length) return;
      hitTerms.forEach((term) => {
        if (!matchedTerms.includes(term)) matchedTerms.push(term);
      });
      if (matches.length < maxItems) {
        matches.push({
          text: clip(text, maxTextLen || 160),
          terms: hitTerms.slice(0, 5)
        });
      }
    });
    return { matches, matchedTerms };
  };
  const buildSignal = (id, terms) => {
    const headingHit = findMatches(headingTexts, terms, 3, 120);
    const bodyHit = findMatches(bodyWindows, terms, 2, 160);
    const navHit = findMatches(navLinkTexts, terms, 2, 120);
    const matchedTerms = uniq([].concat(headingHit.matchedTerms, bodyHit.matchedTerms, navHit.matchedTerms), 12);
    const headingObserved = headingHit.matches.length > 0;
    const bodyObserved = bodyHit.matches.length > 0;
    const navObserved = navHit.matches.length > 0;
    const present = matchedTerms.length > 0;
    const confidence = headingObserved && bodyObserved
      ? 'high'
      : (headingObserved || bodyObserved ? 'medium' : (navObserved ? 'low' : 'none'));
    const sourceParts = [
      headingObserved ? 'heading' : '',
      bodyObserved ? 'body_snippet' : '',
      navObserved ? 'nav_link_text' : ''
    ].filter(Boolean);
    return {
      present,
      confidence,
      matchedTerms,
      matchedHeadings: headingHit.matches.map((m) => m.text).slice(0, 3),
      snippets: bodyHit.matches.map((m) => ({ text: m.text, source: 'body_snippet' })).slice(0, 2),
      source: 'heading_body_nav_scan',
      checkedTextLength,
      reason: present
        ? `matched ${matchedTerms.length} term(s) via ${sourceParts.join('+')}`
        : 'configured terms not observed in checked headings/body snippets/nav links'
    };
  };
  const signals = {};
  Object.keys(termsBySignal).forEach((id) => {
    signals[id] = buildSignal(id, termsBySignal[id]);
  });
  const signalIds = Object.keys(signals);
  const positiveSignals = signalIds.filter((id) => signals[id].present === true);
  const weakSignals = signalIds.filter((id) => signals[id].present !== true);
  const confidenceSummary = signalIds.reduce((acc, id) => {
    const key = signals[id].confidence || 'none';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    version: 'geoThemeSignalsV1',
    source: 'rendered_dom_text_light',
    checkedTextLength,
    checkedHeadingCount: headingTexts.length,
    checkedSnippetCount: bodyWindows.length,
    signals,
    summary: {
      positiveSignals,
      weakSignals,
      confidenceSummary
    }
  };
}
function countIf(arr, pred){ return arr.reduce((a,x)=>a+(pred(x)?1:0),0); }

function summarizeJsonLdTextsLight(texts, source) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const typeNames = (node) => {
    const t = node && node['@type'];
    const values = Array.isArray(t) ? t : (t ? [t] : []);
    return values.map((x) => clean(x).toLowerCase().replace(/^https?:\/\/schema\.org\//i, '')).filter(Boolean);
  };
  const hasOwnMeaningful = (node, key) => {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false;
    const v = node[key];
    if (Array.isArray(v)) return v.length > 0;
    if (v && typeof v === 'object') return Object.keys(v).length > 0;
    return clean(v).length > 0;
  };
  const sameAsValues = [];
  const sameAsValuesByType = {
    organization: [],
    website: [],
    person: []
  };
  const contactPointFieldPresence = {
    telephone: false,
    email: false,
    contactType: false
  };
  const orgFieldPresence = {
    name: false,
    url: false,
    logo: false,
    sameAs: false,
    address: false,
    telephone: false
  };
  let orgNodeObserved = false;
  let seoNodeObserved = false;
  const nodeTypes = [];
  const walkJsonLd = (node, depth = 0) => {
    if (depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walkJsonLd(item, depth + 1));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const t = node['@type'];
    if (Array.isArray(t)) t.forEach((x) => nodeTypes.push(clean(x)));
    else if (t) nodeTypes.push(clean(t));
    const types = typeNames(node);
    const isOrg = types.some((x) => ['organization', 'corporation', 'localbusiness'].includes(x));
    const isWebsite = types.includes('website');
    const isPerson = types.includes('person');
    const isContactPoint = types.includes('contactpoint');
    if (isOrg || isWebsite || types.includes('person')) seoNodeObserved = true;
    if (isOrg) {
      orgNodeObserved = true;
      Object.keys(orgFieldPresence).forEach((field) => {
        if (hasOwnMeaningful(node, field)) orgFieldPresence[field] = true;
      });
    }
    if (isContactPoint) {
      Object.keys(contactPointFieldPresence).forEach((field) => {
        if (hasOwnMeaningful(node, field)) contactPointFieldPresence[field] = true;
      });
    }
    const sameAs = node.sameAs;
    const sameAsList = Array.isArray(sameAs) ? sameAs : (sameAs ? [sameAs] : []);
    sameAsList.forEach((v) => {
      const s = clean(v);
      if (!/^https?:\/\//i.test(s)) return;
      sameAsValues.push(s);
      if (isOrg) sameAsValuesByType.organization.push(s);
      if (isWebsite) sameAsValuesByType.website.push(s);
      if (isPerson) sameAsValuesByType.person.push(s);
    });
    if (Array.isArray(node['@graph'])) node['@graph'].forEach((item) => walkJsonLd(item, depth + 1));
  };
  const rawTexts = (Array.isArray(texts) ? texts : []).map(clean).filter(Boolean);
  let parseableCount = 0;
  let parseErrorsCount = 0;
  rawTexts.forEach((txt) => {
    try {
      const parsed = JSON.parse(txt);
      parseableCount += 1;
      walkJsonLd(parsed);
    } catch (_) {
      parseErrorsCount += 1;
    }
  });
  const types = Array.from(new Set(nodeTypes.filter(Boolean))).slice(0, 50);
  const typeClass = classifyJsonLdTypesForSeo(types);
  const hasJsonLd = rawTexts.length > 0;
  const sameAsUnique = Array.from(new Set(sameAsValues)).slice(0, 20);
  const sameAsCountByType = {
    organization: Array.from(new Set(sameAsValuesByType.organization)).length,
    website: Array.from(new Set(sameAsValuesByType.website)).length,
    person: Array.from(new Set(sameAsValuesByType.person)).length
  };
  const orgMissingFields = orgNodeObserved
    ? Object.keys(orgFieldPresence).filter((field) => orgFieldPresence[field] !== true)
    : [];
  const contactPointObserved = hasJsonLd && (typeClass.hasSeoJsonLd || seoNodeObserved);
  const hasContactPoint = types.some((t) => clean(t).toLowerCase().replace(/^https?:\/\/schema\.org\//i, '') === 'contactpoint');
  const contactPointMissingFields = contactPointObserved && hasContactPoint
    ? Object.keys(contactPointFieldPresence).filter((field) => contactPointFieldPresence[field] !== true)
    : [];
  return {
    types,
    seoTypes: typeClass.seoTypes,
    nonSeoTypes: typeClass.nonSeoTypes,
    telemetryTypes: typeClass.telemetryTypes,
    excludedFromSeoTypes: typeClass.excludedFromSeoTypes,
    rawCount: rawTexts.length,
    parseableCount,
    parseErrorsCount,
    hasJsonLd,
    hasSeoJsonLd: hasJsonLd ? typeClass.hasSeoJsonLd : false,
    hasWebsite: hasJsonLd ? typeClass.hasWebsite : false,
    hasOrganization: hasJsonLd ? typeClass.hasOrganization : false,
    hasBreadcrumbList: hasJsonLd ? typeClass.hasBreadcrumbList : false,
    hasFAQPage: hasJsonLd ? typeClass.hasFAQPage : false,
    typeClassificationSource: typeClass.typeClassificationSource,
    breadcrumbObserved: hasJsonLd,
    breadcrumbMissing: hasJsonLd ? !typeClass.hasBreadcrumbList : null,
    organizationSummary: {
      observed: hasJsonLd,
      hasOrganization: hasJsonLd ? typeClass.hasOrganization : null,
      missingFields: orgMissingFields.slice(0, 12),
      source: 'seo_jsonld'
    },
    sameAsSummary: {
      observed: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd),
      count: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd) ? sameAsUnique.length : null,
      externalCount: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd) ? sameAsUnique.length : null,
      sameAsCountByType: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd) ? sameAsCountByType : null,
      hasOrganizationSameAs: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd) ? sameAsCountByType.organization > 0 : null,
      hasWebSiteSameAs: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd) ? sameAsCountByType.website > 0 : null,
      hasPersonSameAs: hasJsonLd && (seoNodeObserved || typeClass.hasSeoJsonLd) ? sameAsCountByType.person > 0 : null,
      valuesSample: sameAsUnique.slice(0, 8),
      source: 'seo_jsonld'
    },
    addressObserved: hasJsonLd && typeClass.hasOrganization,
    hasAddress: hasJsonLd && typeClass.hasOrganization ? orgFieldPresence.address === true : null,
    addressSource: 'seo_jsonld',
    contactPointObserved,
    hasContactPoint: contactPointObserved ? hasContactPoint : null,
    contactPointMissingFields: contactPointMissingFields.slice(0, 8),
    contactPointSource: 'seo_jsonld',
    source: source || 'jsonld_light'
  };
}

async function collectHtmlContentJsonLdSummaryLight(page) {
  try {
    const html = await page.content();
    const $ = cheerio.load(html || '');
    const texts = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      if (texts.length >= 80) return;
      const txt = String($(el).text() || '').trim();
      if (!txt) return;
      texts.push(txt.length > 300000 ? txt.slice(0, 300000) : txt);
    });
    const summary = summarizeJsonLdTextsLight(texts, 'html_content_ldjson_light');
    summary.htmlLength = String(html || '').length;
    summary.htmlContentLdJsonObserved = true;
    return summary;
  } catch (e) {
    return {
      types: [],
      rawCount: 0,
      parseableCount: 0,
      parseErrorsCount: 0,
      hasJsonLd: null,
      hasWebsite: null,
      hasOrganization: null,
      hasBreadcrumbList: null,
      hasFAQPage: null,
      source: 'html_content_ldjson_light',
      htmlLength: null,
      htmlContentLdJsonObserved: false,
      error: String(e && (e.message || e) || '').slice(0, 180)
    };
  }
}

function extractSchemaTypesFromScriptTextLight(text) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const body = String(text || '');
  const types = [];
  const patterns = [
    /["@]type["']?\s*:\s*["']([^"']{1,100})["']/gi,
    /\\"@type\\"\s*:\s*\\"([^"\\]{1,100})\\"/gi,
    /@type\\?["']?\s*[:=]\s*\\?["']([^"'\\]{1,100})/gi
  ];
  patterns.forEach((re) => {
    let m;
    while ((m = re.exec(body)) && types.length < 80) {
      const t = clean(m[1]);
      if (t) types.push(t);
    }
  });
  return Array.from(new Set(types)).slice(0, 50);
}

async function collectSameOriginScriptSrcJsonLdSummaryLight(page, url, opts = {}) {
  const MAX_SCRIPTS = Math.max(1, Math.min(10, Number(opts && opts.maxScripts || 10)));
  const MAX_BYTES_PER_SCRIPT = Math.max(100000, Math.min(1000000, Number(opts && opts.maxBytesPerScript || 1000000)));
  const REQUEST_TIMEOUT_MS = Math.max(500, Math.min(10000, Number(opts && opts.requestTimeoutMs || 10000)));
  const empty = {
    types: [],
    scriptSrcCount: 0,
    sameOriginScriptCount: 0,
    fetchedCount: 0,
    skippedLargeCount: 0,
    candidateCount: 0,
    parseableCount: 0,
    hasJsonLd: null,
    hasWebsite: null,
    hasOrganization: null,
    hasBreadcrumbList: null,
    hasFAQPage: null,
    observed: false,
    source: 'same_origin_script_src_jsonld_light',
    appIndexDetected: false,
    totalFetchedBytes: 0,
    maxScriptLength: 0,
    contactPathFound: null,
    contactPathSample: '',
    companyPathFound: null,
    companyPathSample: '',
    servicePathFound: null,
    servicePathSample: '',
    privacyPathFound: null,
    privacyPathSample: '',
    error: null,
    fetchErrorsCount: 0,
    fetchErrorsSample: []
  };
  try {
    const finalUrl = page && typeof page.url === 'function' ? page.url() : url;
    const renderedScriptSrcs = await page.evaluate(() => {
      const out = [];
      Array.from(document.querySelectorAll('script[src]')).forEach((s) => {
        const src = s && s.getAttribute && s.getAttribute('src');
        if (!src) return;
        try { out.push(new URL(src, location.href).toString()); } catch (_) {}
      });
      return out;
    }).catch(() => []);
    const html = await page.content().catch(() => '');
    const htmlScriptSrcs = [];
    try {
      const $ = cheerio.load(html || '');
      $('script[src]').each((_, el) => {
        const src = String($(el).attr('src') || '').trim();
        if (!src) return;
        try { htmlScriptSrcs.push(new URL(src, finalUrl || url).toString()); } catch (_) {}
      });
    } catch (_) {}
    const scriptSrcs = Array.from(new Set([].concat(renderedScriptSrcs || []).concat(htmlScriptSrcs || []).filter(Boolean)));
    let origin = '';
    try { origin = new URL(finalUrl || url).origin; } catch (_) {}
    const sameOriginScripts = scriptSrcs.filter((u) => {
      try { return new URL(u).origin === origin; } catch (_) { return false; }
    });
    const out = Object.assign({}, empty, {
      scriptSrcCount: scriptSrcs.length,
      sameOriginScriptCount: sameOriginScripts.length,
      observed: true,
      appIndexDetected: sameOriginScripts.some((u) => /\/app-index\.js(?:[?#]|$)/.test(String(u || '')))
    });
    const types = [];
    let scannedScriptForTrust = false;
    const pickTrustSample = (text, re) => {
      const match = String(text || '').match(re);
      return match ? String(match[0] || '').replace(/^["']+|["']+$/g, '').slice(0, 120) : '';
    };
    for (const scriptUrl of sameOriginScripts.slice(0, MAX_SCRIPTS)) {
      try {
        const r = await page.request.get(scriptUrl, { timeout: REQUEST_TIMEOUT_MS });
        const headers = typeof r.headers === 'function' ? r.headers() : {};
        const contentLength = Number(headers['content-length'] || headers['Content-Length'] || 0);
        if (contentLength > MAX_BYTES_PER_SCRIPT) {
          out.skippedLargeCount += 1;
          continue;
        }
        const text = await r.text();
        const len = String(text || '').length;
        out.totalFetchedBytes += len;
        out.maxScriptLength = Math.max(out.maxScriptLength, len);
        if (len > MAX_BYTES_PER_SCRIPT) {
          out.skippedLargeCount += 1;
          continue;
        }
        out.fetchedCount += 1;
        scannedScriptForTrust = true;
        if (out.contactPathFound !== true && /(?:\/|["'])?(contact|contacts|inquiry|support|help|お問い合わせ|お問合せ|問い合わせ|連絡|サポート)(?:\/|["']|$)/i.test(text)) {
          out.contactPathFound = true;
          out.contactPathSample = out.contactPathSample || pickTrustSample(text, /(?:\/|["'])?(contact|contacts|inquiry|support|help|お問い合わせ|お問合せ|問い合わせ|連絡|サポート)(?:\/|["']|$)/i);
        }
        if (out.companyPathFound !== true && /(?:\/|["'])?(company|about|corporate|profile|会社情報|会社概要|企業情報)(?:\/|["']|$)/i.test(text)) {
          out.companyPathFound = true;
          out.companyPathSample = out.companyPathSample || pickTrustSample(text, /(?:\/|["'])?(company|about|corporate|profile|会社情報|会社概要|企業情報)(?:\/|["']|$)/i);
        }
        if (out.servicePathFound !== true && /(?:\/|["'])?(service|business|solution|plan|services|事業|サービス|料金|プラン)(?:\/|["']|$)/i.test(text)) {
          out.servicePathFound = true;
          out.servicePathSample = out.servicePathSample || pickTrustSample(text, /(?:\/|["'])?(service|business|solution|plan|services|事業|サービス|料金|プラン)(?:\/|["']|$)/i);
        }
        if (out.privacyPathFound !== true && /(?:\/|["'])?(privacy|privacy-policy|privacypolicy|policy|プライバシー|個人情報)(?:\/|["']|$)/i.test(text)) {
          out.privacyPathFound = true;
          out.privacyPathSample = out.privacyPathSample || pickTrustSample(text, /(?:\/|["'])?(privacy|privacy-policy|privacypolicy|policy|プライバシー|個人情報)(?:\/|["']|$)/i);
        }
        const hasContext = /@context|\\"@context\\"/.test(text);
        const hasType = /@type|\\"@type\\"/.test(text);
        const hasSchemaOrg = /schema\.org/i.test(text);
        const scriptTypes = extractSchemaTypesFromScriptTextLight(text);
        if (hasContext || hasType || hasSchemaOrg || scriptTypes.length) {
          out.candidateCount += 1;
          scriptTypes.forEach((t) => types.push(t));
        }
      } catch (e) {
        out.fetchErrorsCount += 1;
        if (out.fetchErrorsSample.length < 5) {
          out.fetchErrorsSample.push({
            urlSample: String(scriptUrl || '').slice(0, 180),
            errorMessage: String(e && (e.message || e) || '').slice(0, 180)
          });
        }
      }
    }
    out.types = Array.from(new Set(types.filter(Boolean))).slice(0, 50);
    out.parseableCount = 0;
    out.hasJsonLd = out.candidateCount > 0;
    const typeClass = classifyJsonLdTypesForSeo(out.types);
    out.seoTypes = typeClass.seoTypes;
    out.nonSeoTypes = typeClass.nonSeoTypes;
    out.telemetryTypes = typeClass.telemetryTypes;
    out.excludedFromSeoTypes = typeClass.excludedFromSeoTypes;
    out.hasSeoJsonLd = out.hasJsonLd ? typeClass.hasSeoJsonLd : false;
    out.hasWebsite = out.hasJsonLd ? typeClass.hasWebsite : false;
    out.hasOrganization = out.hasJsonLd ? typeClass.hasOrganization : false;
    out.hasBreadcrumbList = out.hasJsonLd ? typeClass.hasBreadcrumbList : false;
    out.hasFAQPage = out.hasJsonLd ? typeClass.hasFAQPage : false;
    out.typeClassificationSource = typeClass.typeClassificationSource;
    if (scannedScriptForTrust) {
      if (out.contactPathFound !== true) out.contactPathFound = false;
      if (out.companyPathFound !== true) out.companyPathFound = false;
      if (out.servicePathFound !== true) out.servicePathFound = false;
      if (out.privacyPathFound !== true) out.privacyPathFound = false;
    }
    return out;
  } catch (e) {
    return Object.assign({}, empty, {
      error: String(e && (e.message || e) || '').slice(0, 180)
    });
  }
}

function normalizeFreshnessDateYmd_(value) {
  const m = String(value || '').match(/\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\b/);
  if (!m) return '';
  const y = m[1];
  const mm = String(m[2]).padStart(2, '0');
  const dd = String(m[3]).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function buildMediaArticleLinkFreshnessSignals_(geoSignalsV1, opts = {}) {
  const siteMode = normalizeSubpageJsonLdText(opts.siteMode || '').toLowerCase();
  if (siteMode !== 'media') return null;
  const g = geoSignalsV1 && typeof geoSignalsV1 === 'object' ? geoSignalsV1 : {};
  const existing = g.freshnessOperationSignals && typeof g.freshnessOperationSignals === 'object'
    ? g.freshnessOperationSignals
    : null;
  if (existing && (existing.hasNewsDateEvidence === true || existing.latestDate || existing.hasUpdatedDateEvidence === true)) return existing;
  const observed = g.observed && typeof g.observed === 'object' ? g.observed : {};
  const links = observed.links && Array.isArray(observed.links.internalLinksSample)
    ? observed.links.internalLinksSample
    : [];
  const dateRe = /\b20\d{2}[.\-\/]\d{1,2}[.\-\/]\d{1,2}\b/g;
  const articleUrlRe = /\/(?:post|posts|article|articles|news|story|stories|entry|entries|contents?)\/|\/20\d{2}\/\d{1,2}\//i;
  const picked = [];
  const seen = new Set();
  const addDate_ = (date, source, text, href) => {
    const normalized = normalizeFreshnessDateYmd_(date);
    if (!normalized || seen.has(`${source}:${normalized}:${href || ''}`)) return;
    seen.add(`${source}:${normalized}:${href || ''}`);
    picked.push({
      date: normalized,
      source,
      text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      href: String(href || '').slice(0, 220)
    });
  };
  links.forEach((link) => {
    const text = String(link && (link.text || link.label) || '');
    const href = String(link && (link.href || link.url) || '');
    if (!articleUrlRe.test(href)) return;
    const matches = text.match(dateRe) || [];
    matches.forEach((date) => addDate_(date, 'internal_link_date', text, href));
  });
  if (!picked.length) {
    const bodySample = String(observed.body && observed.body.sample || '');
    const matches = bodySample.match(dateRe) || [];
    matches.slice(0, 10).forEach((date) => addDate_(date, 'body_sample_date', bodySample, ''));
  }
  if (!picked.length) return null;
  const sampleDates = Array.from(new Set(picked.map((item) => item.date))).sort();
  const latestDate = sampleDates[sampleDates.length - 1] || null;
  const primarySource = picked.some((item) => item.source === 'internal_link_date')
    ? 'media_article_links'
    : 'media_body_sample';
  return {
    observed: true,
    hasNewsDateEvidence: true,
    newsDateEvidenceCount: sampleDates.length,
    latestDate,
    freshnessEvidenceSources: [primarySource === 'media_article_links' ? 'internal_link_date' : 'body_sample_date'],
    sampleDates: sampleDates.slice(-10),
    evidenceSamples: picked.slice(0, 10),
    source: primarySource,
    extractionMethod: primarySource === 'media_article_links' ? 'internal_links_sample' : 'body_sample'
  };
}

function attachMediaArticleLinkFreshnessSignals_(geoSignalsV1, lightweightSummary, opts = {}) {
  const signals = buildMediaArticleLinkFreshnessSignals_(geoSignalsV1, opts);
  if (!signals) return null;
  geoSignalsV1.freshnessOperationSignals = geoSignalsV1.freshnessOperationSignals || signals;
  geoSignalsV1.observed = geoSignalsV1.observed || {};
  geoSignalsV1.observed.freshnessOperationSignals = geoSignalsV1.observed.freshnessOperationSignals || signals;
  if (lightweightSummary && typeof lightweightSummary === 'object') {
    lightweightSummary.freshnessOperationSignals = lightweightSummary.freshnessOperationSignals || signals;
    lightweightSummary.hasNewsDateEvidence = lightweightSummary.hasNewsDateEvidence == null ? signals.hasNewsDateEvidence : lightweightSummary.hasNewsDateEvidence;
    lightweightSummary.newsDateEvidenceCount = lightweightSummary.newsDateEvidenceCount == null ? signals.newsDateEvidenceCount : lightweightSummary.newsDateEvidenceCount;
    lightweightSummary.latestDate = lightweightSummary.latestDate || signals.latestDate;
  }
  return signals;
}

async function buildGeoSignalsV1(page, url, opts = {}) {
  const generatedAt = new Date().toISOString();
  const startedAt = Date.now();
  const balancedMode = !!(opts && opts.balancedMode);
  const shortFastMode = !!(opts && opts.shortFastMode);
  const siteMode = normalizeSubpageJsonLdText(opts && opts.siteMode || '').toLowerCase();
  const debugHeavySite = opts && opts.debugHeavySite === true;
  const debugHeavySiteStartedAt = Number(opts && opts.debugHeavySiteStartedAt || startedAt) || startedAt;
  const boundedHydrationWaitMs = Number(opts && opts.boundedHydrationWaitMs || 0);
  const hydrationMetrics = opts && opts.hydrationMetrics && typeof opts.hydrationMetrics === 'object'
    ? opts.hydrationMetrics
    : {};
  const phaseTimings = {
    gotoMs: typeof opts.gotoMs === 'number' ? opts.gotoMs : null,
    basicDomMs: null,
    structuredDataMs: null,
    linksMs: null,
    multimodalMs: null,
    totalMs: null
  };
  const buildGeoMemorySnapshot = () => {
    try {
      const memory = process.memoryUsage();
      return {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers
      };
    } catch (_) {
      return null;
    }
  };
  const logHeavySiteBuildGeoAudit = (phase, details = {}) => {
    if (!debugHeavySite) return;
    try {
      console.log('[DEBUG][HEAVY_SITE_BUILD_GEOSIGNALS_AUDIT]', JSON.stringify({
        phase,
        url: String(url || ''),
        finalUrl: page && typeof page.url === 'function' ? page.url() : '',
        elapsedMs: Date.now() - debugHeavySiteStartedAt,
        memory: buildGeoMemorySnapshot(),
        details
      }));
    } catch (_) {}
  };
  try {
    logHeavySiteBuildGeoAudit('build_start', {
      balancedMode,
      shortFastMode,
      boundedHydrationWaitMs
    });
    const basicDomStart = Date.now();
    logHeavySiteBuildGeoAudit('shadow_dom_or_deep_query_start', {
      source: 'initial_rendered_dom_evaluate'
    });
    const observed = await page.evaluate(({ inputUrl, balancedMode, shortFastMode }) => {
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const uniq = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).filter(Boolean)));
      const limit = (arr, n) => uniq(arr).slice(0, n);
      const browserPhaseTimings = { linksMs: null, multimodalMs: null };
      const absUrl = (href) => {
        try { return new URL(href, location.href).toString(); } catch (_) { return clean(href); }
      };
      const queryAllDeep = (selector) => {
        const out = [];
        const seen = new Set();
        const walk = (root, depth = 0) => {
          if (!root || depth > 6 || !root.querySelectorAll) return;
          Array.from(root.querySelectorAll(selector)).forEach((el) => {
            if (!el || seen.has(el)) return;
            seen.add(el);
            out.push(el);
          });
          Array.from(root.querySelectorAll('*')).forEach((el) => {
            if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
          });
        };
        walk(document, 0);
        return out;
      };
      const nodeTypes = [];
      const firstJsonLdTextValue = (value, depth = 0) => {
        if (depth > 5 || value == null) return '';
        if (typeof value === 'string' || typeof value === 'number') return clean(value);
        if (Array.isArray(value)) {
          for (const item of value) {
            const got = firstJsonLdTextValue(item, depth + 1);
            if (got) return got;
          }
          return '';
        }
        if (typeof value === 'object') {
          return firstJsonLdTextValue(value.url || value.contentUrl || value['@id'] || value.href || value.name, depth + 1);
        }
        return '';
      };
      const multimodalJsonLd = {
        hasStructuredLogo: false,
        structuredLogoUrl: '',
        structuredImageCount: 0,
        imageObjectCount: 0,
        primaryImageOfPage: '',
        structuredImageTypes: []
      };
      const sameAsValues = [];
      const sameAsValuesByType = { organization: [], website: [], person: [] };
      const walkJsonLd = (node, depth = 0) => {
        if (depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((item) => walkJsonLd(item, depth + 1));
          return;
        }
        if (!node || typeof node !== 'object') return;
        const t = node['@type'];
        const currentTypes = [];
        if (Array.isArray(t)) t.forEach((x) => {
          const type = clean(x);
          if (type) {
            nodeTypes.push(type);
            currentTypes.push(type);
          }
        });
        else if (t) {
          const type = clean(t);
          if (type) {
            nodeTypes.push(type);
            currentTypes.push(type);
          }
        }
        const logoValue = firstJsonLdTextValue(node.logo);
        const imageValue = firstJsonLdTextValue(node.image);
        const primaryImageValue = firstJsonLdTextValue(node.primaryImageOfPage);
        if (logoValue) {
          multimodalJsonLd.hasStructuredLogo = true;
          if (!multimodalJsonLd.structuredLogoUrl) multimodalJsonLd.structuredLogoUrl = absUrl(logoValue);
        }
        if (imageValue || logoValue || primaryImageValue) {
          multimodalJsonLd.structuredImageCount += 1;
          currentTypes.forEach((type) => multimodalJsonLd.structuredImageTypes.push(type));
        }
        if (currentTypes.some((type) => /^ImageObject$/i.test(type))) multimodalJsonLd.imageObjectCount += 1;
        if (primaryImageValue && !multimodalJsonLd.primaryImageOfPage) {
          multimodalJsonLd.primaryImageOfPage = absUrl(primaryImageValue);
        }
        const normalizedTypes = currentTypes.map((type) => clean(type).toLowerCase().replace(/^https?:\/\/schema\.org\//i, ''));
        const sameAs = node.sameAs;
        const sameAsList = Array.isArray(sameAs) ? sameAs : (sameAs ? [sameAs] : []);
        sameAsList.forEach((value) => {
          const url = clean(value);
          if (!/^https?:\/\//i.test(url)) return;
          sameAsValues.push(url);
          if (normalizedTypes.some((type) => ['organization', 'corporation', 'localbusiness'].includes(type))) sameAsValuesByType.organization.push(url);
          if (normalizedTypes.includes('website')) sameAsValuesByType.website.push(url);
          if (normalizedTypes.includes('person')) sameAsValuesByType.person.push(url);
        });
        if (Array.isArray(node['@graph'])) node['@graph'].forEach((item) => walkJsonLd(item, depth + 1));
      };
      const rawJsonLd = queryAllDeep('script[type*="ld+json" i]')
        .map((s) => clean(s.textContent || ''))
        .filter(Boolean);
      let parseableJsonLdCount = 0;
      let parseErrorsCount = 0;
      rawJsonLd.forEach((txt) => {
        try {
          const parsed = JSON.parse(txt);
          parseableJsonLdCount += 1;
          walkJsonLd(parsed);
        } catch (_) {
          parseErrorsCount += 1;
        }
      });
      const typeList = limit(nodeTypes, 50);
      const typeSet = new Set(typeList.map((t) => String(t || '').toLowerCase()));
      const hasJsonLd = rawJsonLd.length > 0;

      const titleValue = clean(document.title || '');
      const metaEl = document.querySelector('meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]');
      const metaValue = clean(metaEl && metaEl.getAttribute('content'));
      const h1 = limit(queryAllDeep('h1').map((el) => clean(el.innerText || el.textContent)), 10);
      const h2 = limit(queryAllDeep('h2').map((el) => clean(el.innerText || el.textContent)), 20);
      const h3 = limit(queryAllDeep('h3').map((el) => clean(el.innerText || el.textContent)), 20);
      const mainH1 = limit(queryAllDeep('main h1,[role="main"] h1,#main h1,#main-content h1').map((el) => clean(el.innerText || el.textContent)), 10);
      const mainH2 = limit(queryAllDeep('main h2,[role="main"] h2,#main h2,#main-content h2').map((el) => clean(el.innerText || el.textContent)), 20);
      const collectHeadingsIn = (selector, h1Limit = 10, h2Limit = 20) => {
        const roots = queryAllDeep(selector || '');
        const h1Vals = [];
        const h2Vals = [];
        roots.forEach((root) => {
          if (!root || !root.querySelectorAll) return;
          Array.from(root.querySelectorAll('h1')).forEach((el) => h1Vals.push(clean(el.innerText || el.textContent)));
          Array.from(root.querySelectorAll('h2')).forEach((el) => h2Vals.push(clean(el.innerText || el.textContent)));
        });
        return {
          rootCount: roots.length,
          h1: limit(h1Vals, h1Limit),
          h2: limit(h2Vals, h2Limit)
        };
      };
      const appRootHeadings = balancedMode
        ? collectHeadingsIn('#app,#root,#__next,[data-reactroot],[id*="app" i]', 10, 20)
        : { rootCount: 0, h1: [], h2: [] };
      const heroHeadings = balancedMode
        ? collectHeadingsIn('main [class*="hero" i],main [id*="hero" i],main [class*="kv" i],main [id*="kv" i],main [class*="mainvisual" i],main [id*="mainvisual" i],section[class*="hero" i],section[id*="hero" i],section[class*="kv" i],section[id*="kv" i],section[class*="mainvisual" i],section[id*="mainvisual" i]', 10, 20)
        : { rootCount: 0, h1: [], h2: [] };
      const iframeSameOriginHeadings = { iframeCount: 0, accessibleCount: 0, blockedCount: 0, h1: [], h2: [], error: null };
      if (balancedMode && !shortFastMode) {
        try {
          const frames = Array.from(document.querySelectorAll('iframe'));
          iframeSameOriginHeadings.iframeCount = frames.length;
          frames.forEach((frame) => {
            try {
              const doc = frame && frame.contentDocument;
              if (!doc) {
                iframeSameOriginHeadings.blockedCount += 1;
                return;
              }
              iframeSameOriginHeadings.accessibleCount += 1;
              Array.from(doc.querySelectorAll('h1')).forEach((el) => iframeSameOriginHeadings.h1.push(clean(el.innerText || el.textContent)));
              Array.from(doc.querySelectorAll('h2')).forEach((el) => iframeSameOriginHeadings.h2.push(clean(el.innerText || el.textContent)));
            } catch (_) {
              iframeSameOriginHeadings.blockedCount += 1;
            }
          });
          iframeSameOriginHeadings.h1 = limit(iframeSameOriginHeadings.h1, 10);
          iframeSameOriginHeadings.h2 = limit(iframeSameOriginHeadings.h2, 20);
        } catch (e) {
          iframeSameOriginHeadings.error = String(e && (e.message || e) || '').slice(0, 160);
        }
      }
      const shadowHeadings = { h1: [], h2: [], h3: [], hostCount: 0, observed: false, error: null };
      if (balancedMode && !shortFastMode) {
        try {
          const walkShadow = (root, depth = 0) => {
            if (!root || depth > 4) return;
            const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
            nodes.forEach((el) => {
              if (!el) return;
              const tag = String(el.tagName || '').toLowerCase();
              if (tag === 'h1') shadowHeadings.h1.push(clean(el.innerText || el.textContent));
              else if (tag === 'h2') shadowHeadings.h2.push(clean(el.innerText || el.textContent));
              else if (tag === 'h3') shadowHeadings.h3.push(clean(el.innerText || el.textContent));
              if (el.shadowRoot) {
                shadowHeadings.hostCount += 1;
                walkShadow(el.shadowRoot, depth + 1);
              }
            });
          };
          walkShadow(document, 0);
          shadowHeadings.h1 = limit(shadowHeadings.h1, 10);
          shadowHeadings.h2 = limit(shadowHeadings.h2, 20);
          shadowHeadings.h3 = limit(shadowHeadings.h3, 20);
          shadowHeadings.observed = true;
        } catch (e) {
          shadowHeadings.error = String(e && (e.message || e) || '').slice(0, 160);
        }
      }
      const mainCandidates = [
        { source: 'dom_main', selector: 'main', confidence: 'high' },
        { source: 'dom_role_main', selector: '[role="main"]', confidence: 'high' },
        { source: 'dom_id_main', selector: '#main,#main-content', confidence: 'medium' },
        { source: 'dom_id_contains_main', selector: '[id*="main" i]', confidence: 'low' }
      ];
      let mainLandmark = {
        hasMainLandmark: null,
        hasMainLandmark_final: null,
        mainLandmarkSource: 'not_observed',
        mainLandmarkConfidence: 'low',
        mainLandmarkTextsSample: [],
        mainLandmarkObservationLimited: true
      };
      for (const candidate of mainCandidates) {
        const nodes = Array.from(document.querySelectorAll(candidate.selector || '') || []);
        if (!nodes.length) continue;
        const sample = limit(nodes.map((el) => clean(el.innerText || el.textContent).slice(0, 220)), 3);
        mainLandmark = {
          hasMainLandmark: true,
          hasMainLandmark_final: true,
          mainLandmarkSource: candidate.source,
          mainLandmarkConfidence: candidate.confidence,
          mainLandmarkTextsSample: sample,
          mainLandmarkObservationLimited: false
        };
        break;
      }
      const mainLandmarkCandidate = {
        mainLandmarkCandidateFound: false,
        mainLandmarkCandidateSource: 'not_observed',
        mainLandmarkCandidateConfidence: 'low',
        mainLandmarkCandidateTextsSample: []
      };
      if (balancedMode && mainLandmark.hasMainLandmark !== true) {
        const setMainCandidate = (source, confidence, nodes) => {
          if (mainLandmarkCandidate.mainLandmarkCandidateFound) return;
          const sample = limit((nodes || []).map((el) => clean(el && (el.innerText || el.textContent)).slice(0, 220)).filter((txt) => txt.length >= 40), 3);
          if (!sample.length) return;
          mainLandmarkCandidate.mainLandmarkCandidateFound = true;
          mainLandmarkCandidate.mainLandmarkCandidateSource = source;
          mainLandmarkCandidate.mainLandmarkCandidateConfidence = confidence;
          mainLandmarkCandidate.mainLandmarkCandidateTextsSample = sample;
        };
        setMainCandidate('dom_app_root_candidate', 'medium', Array.from(document.querySelectorAll('#app,#root,#__next,[data-reactroot],app-index,[id*="app" i],[id*="content" i]') || []));
        if (!mainLandmarkCandidate.mainLandmarkCandidateFound && !shortFastMode) {
          try {
            const shadowCandidates = [];
            const shadowRootTextSamples = [];
            const walkShadowMain = (root, depth = 0) => {
              if (!root || depth > 4 || shadowCandidates.length >= 8) return;
              const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
              nodes.forEach((el) => {
                if (!el || shadowCandidates.length >= 8) return;
                if (el.matches && el.matches('main,[role="main"],#main,#content,#app,app-index,[id*="main" i],[id*="content" i]')) {
                  shadowCandidates.push(el);
                }
                if (el.shadowRoot) {
                  const rootText = clean(el.shadowRoot.textContent || '').slice(0, 220);
                  if (rootText.length >= 80 && shadowRootTextSamples.length < 3) {
                    shadowRootTextSamples.push(rootText);
                  }
                  walkShadowMain(el.shadowRoot, depth + 1);
                }
              });
            };
            walkShadowMain(document, 0);
            setMainCandidate('open_shadow_dom_main_candidate', 'medium', shadowCandidates);
            if (!mainLandmarkCandidate.mainLandmarkCandidateFound && shadowRootTextSamples.length) {
              mainLandmarkCandidate.mainLandmarkCandidateFound = true;
              mainLandmarkCandidate.mainLandmarkCandidateSource = 'open_shadow_dom_app_candidate';
              mainLandmarkCandidate.mainLandmarkCandidateConfidence = 'low';
              mainLandmarkCandidate.mainLandmarkCandidateTextsSample = shadowRootTextSamples;
            }
          } catch (_) {}
        }
      }
      const anchors = queryAllDeep('a[href]').map((a) => ({
        text: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title')),
        href: absUrl(a.getAttribute('href') || ''),
        navLike: !!a.closest('nav,[role="navigation"],header,footer'),
        footerLike: !!a.closest('footer,[role="contentinfo"]'),
        source: (a.getRootNode && a.getRootNode() instanceof ShadowRoot) ? 'open_shadow_dom' : 'dom'
      })).filter((a) => a.href);
      const shadowTextParts = [];
      const linksPhaseStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      if (balancedMode) {
        try {
          const maxDepth = shortFastMode ? 2 : 4;
          const maxAnchors = shortFastMode ? 120 : 300;
          const maxShadowTextParts = shortFastMode ? 30 : 80;
          const collectShadowAnchors = (root, depth = 0) => {
            if (!root || depth > maxDepth || anchors.length >= maxAnchors) return;
            const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
            nodes.forEach((el) => {
              if (!el || anchors.length >= maxAnchors) return;
              if (shadowTextParts.length < maxShadowTextParts) {
                const text = clean(el.innerText || el.textContent);
                if (text && text.length >= 2) shadowTextParts.push(text.slice(0, shortFastMode ? 220 : 500));
              }
              if (String(el.tagName || '').toLowerCase() === 'a' && el.getAttribute && el.getAttribute('href')) {
                anchors.push({
                  text: clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title')),
                  href: absUrl(el.getAttribute('href') || ''),
                  navLike: !!el.closest('nav,[role="navigation"],header,footer'),
                  source: 'open_shadow_dom'
                });
              }
              if (el.shadowRoot) collectShadowAnchors(el.shadowRoot, depth + 1);
            });
          };
          collectShadowAnchors(document, 0);
        } catch (_) {}
      }
      const textHref = (a) => `${a.text} ${a.href}`.toLowerCase();
      const hasLike = (re) => anchors.length ? anchors.some((a) => re.test(textHref(a))) : null;
      const firstLikeLink = (re) => {
        const hit = anchors.find((a) => re.test(textHref(a)));
        return hit ? { text: hit.text, href: hit.href } : null;
      };
      const profileHostRe = /(?:^|\/\/|\.)(facebook\.com|instagram\.com|note\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|tiktok\.com|wantedly\.com|github\.com)\b/i;
      const navTexts = anchors.filter((a) => a.navLike && a.text).map((a) => a.text);
      const ctaIgnoreRe = /^(home|top|menu|close|prev|previous|next|share|facebook|instagram|x|twitter|youtube|line|linkedin|tiktok|ホーム|トップ|メニュー|閉じる|前へ|次へ|共有)$/i;
      const ctaCandidateRe = /(?:お問い合わせ|お問合せ|問い合わせ|相談|資料請求|見積|申し込|申込|購入|詳しく見る|詳細を見る|採用情報|エントリー|contact|inquiry|consult|request|quote|apply|entry|buy|purchase|learn more|read more|details)/i;
      const ctaTextFrom = (el) => {
        if (!el) return '';
        const tag = String(el.tagName || '').toLowerCase();
        const raw = tag === 'input'
          ? (el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || '')
          : (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
        return clean(raw).slice(0, 80);
      };
      const ctaElements = queryAllDeep('a[href],button,[role="button"],input[type="submit"],input[type="button"]');
      const ctaTexts = limit(Array.from(new Set(ctaElements
        .map(ctaTextFrom)
        .filter((text) => text && text.length <= 80 && !ctaIgnoreRe.test(text) && ctaCandidateRe.test(text)))), 10);
      const internal = anchors.filter((a) => {
        try { return new URL(a.href).origin === location.origin; } catch (_) { return false; }
      }).map((a) => ({ text: a.text, href: a.href }));
      const externalProfileItems = limit(anchors.filter((a) => profileHostRe.test(a.href)).map((a) => a.href), 10);
      const footerExternalProfileItems = limit(anchors.filter((a) => a.footerLike && profileHostRe.test(a.href)).map((a) => a.href), 10);
      const semanticHeaderCount = queryAllDeep('header,[role="banner"]').length;
      const semanticNavCount = queryAllDeep('nav,[role="navigation"]').length;
      const semanticFooterCount = queryAllDeep('footer,[role="contentinfo"]').length;
      const semanticElements = {
        hasHeaderElement: semanticHeaderCount > 0,
        hasNavElement: semanticNavCount > 0,
        hasFooterElement: semanticFooterCount > 0,
        headerCount: semanticHeaderCount,
        navCount: semanticNavCount,
        footerCount: semanticFooterCount,
        semanticElementsObserved: true,
        source: 'rendered_dom_light'
      };
      const breadcrumbEl = queryAllDeep([
        '[aria-label*="breadcrumb" i]',
        '[class*="breadcrumb" i]',
        '[id*="breadcrumb" i]',
        'nav[aria-label*="パンくず" i]',
        '[class*="パンくず" i]'
      ].join(','))[0] || null;
      const breadcrumbText = clean(breadcrumbEl && (breadcrumbEl.innerText || breadcrumbEl.textContent));
      const footerAnchors = anchors.filter((a) => a.footerLike);
      const footerHay = footerAnchors.map((a) => `${a.text} ${a.href}`).join(' ').toLowerCase();
      const legalRe = /legal|law|特定商取引|特商法|法務/;
      const termsRe = /terms|利用規約|規約/;
      const privacyPolicyRe = /privacy|privacy\s*policy|プライバシーポリシー|個人情報保護方針|個人情報/;
      const faqRe = /(?:\bfaq\b|よくあるご?質問|q\s*&\s*a|q＆a|ヘルプ|help)/i;
      const legalLike = hasLike(legalRe);
      const termsLike = hasLike(termsRe);
      const faqLink = hasLike(faqRe);
      const faqNav = anchors.length ? anchors.some((a) => a.navLike && faqRe.test(textHref(a))) : null;
      const faqSectionEl = queryAllDeep([
        'section[aria-label*="faq" i]',
        'section[aria-label*="よくある質問" i]',
        'section[id*="faq" i]',
        'section[class*="faq" i]',
        '[id*="faq" i]',
        '[class*="faq" i]'
      ].join(',')).find((el) => {
        const text = clean(el && (el.innerText || el.textContent)).slice(0, 200);
        return faqRe.test(text || '');
      }) || null;
      const faqHeadingEl = queryAllDeep('h1,h2,h3,h4,[role="heading"]').find((el) => {
        const text = clean(el && (el.innerText || el.textContent));
        return faqRe.test(text || '');
      }) || null;
      const faqSectionText = clean((faqSectionEl || faqHeadingEl) && ((faqSectionEl || faqHeadingEl).innerText || (faqSectionEl || faqHeadingEl).textContent));
      const footerObserved = footerAnchors.length > 0 || semanticFooterCount > 0;
      const footerSignals = {
        observed: footerObserved,
        linkCount: footerObserved ? footerAnchors.length : null,
        hasPrivacyLink: footerObserved ? privacyPolicyRe.test(footerHay) : null,
        hasCompanyLink: footerObserved ? /company|about|corporate|会社|企業|運営|概要/.test(footerHay) : null,
        hasCompanyProfileLink: footerObserved ? /company|about|corporate|profile|会社概要|企業情報|会社情報|企業|運営|概要/.test(footerHay) : null,
        hasContactLink: footerObserved ? /contact|inquiry|support|お問い合わせ|問い合わせ|連絡|サポート/.test(footerHay) : null,
        hasLegalLink: footerObserved ? legalRe.test(footerHay) : null,
        hasTermsLink: footerObserved ? termsRe.test(footerHay) : null,
        sampleTexts: footerAnchors.map((a) => a.text).filter(Boolean).slice(0, 8),
        externalProfileLinksSample: footerExternalProfileItems.slice(0, 10),
        socialLinksSample: footerExternalProfileItems.slice(0, 10),
        footerExternalLinksSample: footerExternalProfileItems.slice(0, 10),
        source: 'rendered_dom_footer_scan'
      };
      browserPhaseTimings.linksMs = Math.max(0, Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - linksPhaseStart));
      const multimodalPhaseStart = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const firstMetaContent = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const value = clean(el && el.getAttribute('content'));
          if (value) return absUrl(value);
        }
        return '';
      };
      const firstLinkHref = (selectors) => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const value = clean(el && el.getAttribute('href'));
          if (value) return absUrl(value);
        }
        return '';
      };
      const ogImageUrl = firstMetaContent([
        'meta[property="og:image"]',
        'meta[property="og:image:url"]',
        'meta[property="og:image:secure_url"]'
      ]);
      const twitterImageUrl = firstMetaContent([
        'meta[name="twitter:image"]',
        'meta[name="twitter:image:src"]'
      ]);
      const faviconUrl = firstLinkHref([
        'link[rel~="icon"][href]',
        'link[rel="shortcut icon"][href]'
      ]);
      const appleTouchIconUrl = firstLinkHref([
        'link[rel~="apple-touch-icon"][href]',
        'link[rel="apple-touch-icon-precomposed"][href]'
      ]);
      const imgNodes = queryAllDeep('img');
      const primaryImageCandidate = ogImageUrl || twitterImageUrl || multimodalJsonLd.primaryImageOfPage || multimodalJsonLd.structuredLogoUrl ||
        absUrl((imgNodes.find((img) => clean(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src'))) || {}).currentSrc ||
          (imgNodes.find((img) => clean(img.getAttribute && (img.getAttribute('src') || img.getAttribute('data-src')))) || {}).getAttribute?.('src') ||
          '');
      const contactRe = /contact|inquiry|support|help|お問い合わせ|お問合せ|問い合わせ|連絡|サポート|相談/;
      const companyRe = /company|about|corporate|profile|会社|企業|運営|概要|会社情報|企業情報/;
      const serviceRe = /service|business|solution|plan|サービス|事業|料金|プラン/;
      const privacyRe = /privacy|policy|プライバシー|個人情報|プライバシーポリシー|個人情報保護方針/;
      const trustSignals = {
        hasContactLink: hasLike(contactRe),
        contactPathFound: hasLike(contactRe),
        contactObservedFromDom: hasLike(contactRe),
        contactObservedFromScriptHint: false,
        contactPathHintOnly: false,
        contactConfidence: hasLike(contactRe) ? 'high' : 'unknown',
        contactLinkSample: firstLikeLink(contactRe),
        contactLinkSource: hasLike(contactRe) ? 'dom' : 'not_observed',
        hasCompanyLink: hasLike(companyRe),
        companyLinkSource: hasLike(companyRe) ? 'dom' : 'not_observed',
        companyLinkSample: firstLikeLink(companyRe),
        hasServiceLink: hasLike(serviceRe),
        serviceLinkSource: hasLike(serviceRe) ? 'dom' : 'not_observed',
        serviceLinkSample: firstLikeLink(serviceRe),
        hasPrivacyPolicyLink: hasLike(privacyRe),
        privacyLinkSource: hasLike(privacyRe) ? 'dom' : 'not_observed',
        privacyLinkSample: firstLikeLink(privacyRe),
        hasLegalLink: legalLike,
        legalLinkSource: legalLike === true ? 'dom' : (legalLike === false ? 'not_observed' : 'not_observed'),
        legalLinkSample: firstLikeLink(legalRe),
        hasTermsLink: termsLike,
        termsLinkSource: termsLike === true ? 'dom' : (termsLike === false ? 'not_observed' : 'not_observed'),
        termsLinkSample: firstLikeLink(termsRe),
        source: 'balanced_light'
      };
      const multimodalSignals = {
        checked: true,
        hasImage: !!(ogImageUrl || twitterImageUrl || faviconUrl || appleTouchIconUrl || imgNodes.length || multimodalJsonLd.structuredImageCount),
        hasStructured: !!(multimodalJsonLd.hasStructuredLogo || multimodalJsonLd.structuredImageCount || multimodalJsonLd.imageObjectCount),
        hasOgImage: !!ogImageUrl,
        hasTwitterImage: !!twitterImageUrl,
        hasFavicon: !!faviconUrl,
        hasAppleTouchIcon: !!appleTouchIconUrl,
        hasStructuredLogo: !!multimodalJsonLd.hasStructuredLogo,
        imageObjectCount: multimodalJsonLd.imageObjectCount,
        structuredImageCount: multimodalJsonLd.structuredImageCount,
        imgCount: imgNodes.length,
        primaryImageOfPage: primaryImageCandidate || '',
        sampleImageUrls: [ogImageUrl, twitterImageUrl, multimodalJsonLd.primaryImageOfPage, multimodalJsonLd.structuredLogoUrl].filter(Boolean).slice(0, 5),
        source: 'balanced_light'
      };
      const claritySignals = {
        ctaTexts,
        ctaCandidatesCount: ctaTexts.length,
        ctaObserved: true,
        source: 'balanced_light'
      };
      browserPhaseTimings.multimodalMs = Math.max(0, Math.round((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - multimodalPhaseStart));
      const domBodyText = clean(document.body && (document.body.innerText || document.body.textContent));
      const bodyText = clean([domBodyText].concat(shadowTextParts).join(' ')).slice(0, 100000);

      return {
        finalUrl: location.href,
        title: titleValue,
        metaDescription: metaValue,
        h1,
        h2,
        h3,
        mainHeadings: {
          h1: mainH1,
          h2: mainH2
        },
        appRootHeadings,
        heroHeadings,
        iframeSameOriginHeadings,
        shadowHeadings,
        links: {
          navTextsSample: limit(navTexts, 50),
          internalLinksSample: internal.slice(0, 50),
          externalProfileLinksSample: externalProfileItems.slice(0, 10),
          socialLinksSample: externalProfileItems.slice(0, 10),
          footerExternalLinksSample: footerExternalProfileItems.slice(0, 10),
          externalLinksSample: externalProfileItems.slice(0, 10),
          hasCompanyLikeLink: hasLike(/company|about|corporate|会社|企業|運営|概要/),
          hasServiceLikeLink: hasLike(/service|business|solution|plan|サービス|事業|料金|プラン/),
          hasContactLikeLink: hasLike(/contact|inquiry|support|お問い合わせ|問い合わせ|連絡|サポート/),
          hasPrivacyLikeLink: hasLike(/privacy|プライバシー|個人情報/),
          hasLegalLikeLink: legalLike,
          hasTermsLikeLink: termsLike,
          contactLinkSource: hasLike(/contact|inquiry|support|お問い合わせ|問い合わせ|連絡|サポート/) ? 'dom' : 'not_observed',
          companyLinkSource: hasLike(/company|about|corporate|会社|企業|運営|概要/) ? 'dom' : 'not_observed',
          serviceLinkSource: hasLike(/service|business|solution|plan|サービス|事業|料金|プラン/) ? 'dom' : 'not_observed',
          privacyLinkSource: hasLike(/privacy|プライバシー|個人情報/) ? 'dom' : 'not_observed',
          legalLinkSource: legalLike === true ? 'dom' : 'not_observed',
          termsLinkSource: termsLike === true ? 'dom' : 'not_observed'
        },
        multimodalSignals,
        clarity: claritySignals,
        trustSignals,
        coverage: {
          semanticElements,
          hasFaqLink: faqLink,
          hasFaqNav: faqNav,
          hasFaqSection: !!(faqSectionEl || faqHeadingEl),
          faqLinkSource: faqLink === true ? 'dom_link_text' : 'not_observed',
          faqLinkSample: firstLikeLink(faqRe),
          faqSectionSource: (faqSectionEl || faqHeadingEl) ? 'dom_heading_or_section' : 'not_observed',
          faqSectionTextSample: faqSectionText ? faqSectionText.slice(0, 120) : '',
          breadcrumbUiObserved: true,
          hasBreadcrumbUi: !!breadcrumbEl,
          breadcrumbUiSource: 'dom_scan',
          breadcrumbUiTextSample: breadcrumbText ? breadcrumbText.slice(0, 120) : '',
          footerSignals,
          source: 'rendered_dom_light'
        },
        structuredData: {
          types: typeList,
          rawCount: rawJsonLd.length,
          parseableCount: parseableJsonLdCount,
          hasJsonLd,
          hasWebsite: hasJsonLd ? typeSet.has('website') : false,
          hasOrganization: hasJsonLd ? (typeSet.has('organization') || typeSet.has('corporation') || typeSet.has('localbusiness')) : false,
          hasBreadcrumbList: hasJsonLd ? typeSet.has('breadcrumblist') : false,
          hasFAQPage: hasJsonLd ? typeSet.has('faqpage') : false,
          source: 'rendered_dom_jsonld_light',
          confidence: 'medium',
          observationLimited: true,
          observationScope: 'rendered_dom_only',
          renderedDomObserved: true,
          organizationSummary: {
            observed: hasJsonLd,
            hasOrganization: hasJsonLd ? (typeSet.has('organization') || typeSet.has('corporation') || typeSet.has('localbusiness')) : null,
            missingFields: [],
            source: 'seo_jsonld'
          },
          sameAsSummary: {
            observed: hasJsonLd,
            count: limit(sameAsValues, 20).length,
            externalCount: limit(sameAsValues, 20).length,
            sameAsCountByType: {
              organization: limit(sameAsValuesByType.organization, 20).length,
              website: limit(sameAsValuesByType.website, 20).length,
              person: limit(sameAsValuesByType.person, 20).length
            },
            hasOrganizationSameAs: limit(sameAsValuesByType.organization, 20).length > 0,
            hasWebSiteSameAs: limit(sameAsValuesByType.website, 20).length > 0,
            hasPersonSameAs: limit(sameAsValuesByType.person, 20).length > 0,
            valuesSample: limit(sameAsValues, 8),
            source: 'seo_jsonld'
          },
          htmlScanSkipped: true,
          jsScanSkipped: true,
          chunkScanSkipped: true,
          parseErrorsCount
        },
        landmarks: Object.assign({}, mainLandmark, mainLandmarkCandidate),
        body: {
          textLength: bodyText.length,
          sample: bodyText.slice(0, 500)
        },
        phaseTimings: browserPhaseTimings
      };
    }, { inputUrl: String(url || ''), balancedMode, shortFastMode });
    phaseTimings.basicDomMs = Math.max(0, Date.now() - basicDomStart);
    logHeavySiteBuildGeoAudit('shadow_dom_or_deep_query_end', {
      basicDomMs: phaseTimings.basicDomMs,
      finalUrl: observed && observed.finalUrl,
      titleLength: String(observed && observed.title || '').length,
      bodyTextLength: observed && observed.body && observed.body.textLength,
      rawJsonLdCount: observed && observed.structuredData && observed.structuredData.rawCount,
      h1Count: Array.isArray(observed && observed.h1) ? observed.h1.length : null,
      h2Count: Array.isArray(observed && observed.h2) ? observed.h2.length : null,
      linksMs: observed && observed.phaseTimings && observed.phaseTimings.linksMs,
      multimodalMs: observed && observed.phaseTimings && observed.phaseTimings.multimodalMs
    });
    logHeavySiteBuildGeoAudit('structured_data_end', {
      source: 'initial_rendered_dom_evaluate',
      rawCount: observed && observed.structuredData && observed.structuredData.rawCount,
      parseableCount: observed && observed.structuredData && observed.structuredData.parseableCount,
      hasJsonLd: observed && observed.structuredData && observed.structuredData.hasJsonLd,
      hasWebsite: observed && observed.structuredData && observed.structuredData.hasWebsite,
      hasOrganization: observed && observed.structuredData && observed.structuredData.hasOrganization
    });
    logHeavySiteBuildGeoAudit('headings_end', {
      source: 'initial_rendered_dom_evaluate',
      h1Count: Array.isArray(observed && observed.h1) ? observed.h1.length : null,
      h2Count: Array.isArray(observed && observed.h2) ? observed.h2.length : null,
      h3Count: Array.isArray(observed && observed.h3) ? observed.h3.length : null,
      shadowObserved: observed && observed.shadowHeadings && observed.shadowHeadings.observed,
      shadowHostCount: observed && observed.shadowHeadings && observed.shadowHeadings.hostCount
    });
    logHeavySiteBuildGeoAudit('links_end', {
      source: 'initial_rendered_dom_evaluate',
      linksMs: observed && observed.phaseTimings && observed.phaseTimings.linksMs,
      navTextsCount: observed && observed.links && Array.isArray(observed.links.navTextsSample) ? observed.links.navTextsSample.length : null,
      internalLinksSampleCount: observed && observed.links && Array.isArray(observed.links.internalLinksSample) ? observed.links.internalLinksSample.length : null,
      externalProfileLinksSampleCount: observed && observed.links && Array.isArray(observed.links.externalProfileLinksSample) ? observed.links.externalProfileLinksSample.length : null
    });
    logHeavySiteBuildGeoAudit('social_external_links_end', {
      source: 'initial_rendered_dom_evaluate',
      externalProfileLinksSampleCount: observed && observed.links && Array.isArray(observed.links.externalProfileLinksSample) ? observed.links.externalProfileLinksSample.length : null,
      socialLinksSampleCount: observed && observed.links && Array.isArray(observed.links.socialLinksSample) ? observed.links.socialLinksSample.length : null
    });
    logHeavySiteBuildGeoAudit('footer_links_end', {
      source: 'initial_rendered_dom_evaluate',
      footerObserved: observed && observed.coverage && observed.coverage.footerSignals && observed.coverage.footerSignals.observed,
      footerLinkCount: observed && observed.coverage && observed.coverage.footerSignals && observed.coverage.footerSignals.linkCount
    });
    logHeavySiteBuildGeoAudit('trust_signals_end', {
      source: 'initial_rendered_dom_evaluate',
      hasContactLink: observed && observed.trustSignals && observed.trustSignals.hasContactLink,
      hasCompanyLink: observed && observed.trustSignals && observed.trustSignals.hasCompanyLink,
      hasPrivacyPolicyLink: observed && observed.trustSignals && observed.trustSignals.hasPrivacyPolicyLink
    });
    if (observed && observed.phaseTimings) {
      phaseTimings.linksMs = typeof observed.phaseTimings.linksMs === 'number' ? observed.phaseTimings.linksMs : null;
      phaseTimings.multimodalMs = typeof observed.phaseTimings.multimodalMs === 'number' ? observed.phaseTimings.multimodalMs : null;
    }

    const normalizeHeadingText = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const uniqueHeadingTexts = (arr, limitCount) => {
      const out = [];
      const seen = new Set();
      for (const v of (Array.isArray(arr) ? arr : [])) {
        const s = normalizeHeadingText(v);
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= limitCount) break;
      }
      return out;
    };
    const domH1 = Array.isArray(observed.h1) ? observed.h1 : [];
    const domH2 = Array.isArray(observed.h2) ? observed.h2 : [];
    const domH3 = Array.isArray(observed.h3) ? observed.h3 : [];
    const mainHeadings = observed.mainHeadings && typeof observed.mainHeadings === 'object' ? observed.mainHeadings : {};
    const appRootHeadings = observed.appRootHeadings && typeof observed.appRootHeadings === 'object' ? observed.appRootHeadings : {};
    const heroHeadings = observed.heroHeadings && typeof observed.heroHeadings === 'object' ? observed.heroHeadings : {};
    const iframeSameOriginHeadings = observed.iframeSameOriginHeadings && typeof observed.iframeSameOriginHeadings === 'object' ? observed.iframeSameOriginHeadings : {};
    const shadowHeadings = observed.shadowHeadings && typeof observed.shadowHeadings === 'object' ? observed.shadowHeadings : {};
    const headingExclusions = [];
    const normalizeHostname = (v) => String(v || '').toLowerCase().replace(/^www\./, '');
    const getUrlParts = (v) => {
      try {
        const u = new URL(String(v || ''));
        return {
          protocol: u.protocol,
          hostname: normalizeHostname(u.hostname)
        };
      } catch (_) {
        return { protocol: '', hostname: '' };
      }
    };
    const inputUrlParts = getUrlParts(url);
    const finalUrlParts = getUrlParts(observed.finalUrl);
    const browserErrorPageUrl = /^chrome-error:|^about:/i.test(String(observed.finalUrl || '')) ||
      /^chrome-error:|^about:/i.test(String(page.url && page.url() || ''));
    const finalUrlOriginMismatch = !!(
      inputUrlParts.hostname &&
      finalUrlParts.hostname &&
      inputUrlParts.hostname !== finalUrlParts.hostname &&
      !inputUrlParts.hostname.endsWith('.' + finalUrlParts.hostname) &&
      !finalUrlParts.hostname.endsWith('.' + inputUrlParts.hostname)
    );
    const addHeadingExclusion = (text, reason) => {
      headingExclusions.push({
        reason,
        text: normalizeHeadingText(text).slice(0, 160)
      });
    };
    const isBrowserOrExtensionBlockHeading = (text) => {
      const s = normalizeHeadingText(text);
      if (!s) return false;
      return /ERR_BLOCKED_BY_CLIENT|ブロックされています|拡張機能によってブロック|chrome-error:\/\/|about:blank/i.test(s);
    };
    const filterHeadingTexts = (arr) => {
      const out = [];
      for (const text of (Array.isArray(arr) ? arr : [])) {
        if (browserErrorPageUrl || finalUrlOriginMismatch) {
          addHeadingExclusion(text, browserErrorPageUrl ? 'browser_error_page_url' : 'page_origin_mismatch');
          continue;
        }
        if (isBrowserOrExtensionBlockHeading(text)) {
          addHeadingExclusion(text, 'browser_or_extension_block_page');
          continue;
        }
        out.push(text);
      }
      return out;
    };
    const a11yHeadings = {
      h1: [],
      h2: [],
      h3: [],
      all: [],
      observed: false,
      error: null
    };
    const domHeadingObservedCount = domH1.length + domH2.length + domH3.length;
    if (shortFastMode) {
      a11yHeadings.error = 'skipped_short_fast';
    } else if (domHeadingObservedCount > 0) {
      a11yHeadings.error = 'skipped_dom_headings_already_observed';
      logHeavySiteBuildGeoAudit('headings_a11y_skip', {
        reason: 'dom_headings_already_observed',
        domH1Count: domH1.length,
        domH2Count: domH2.length,
        domH3Count: domH3.length
      });
    } else {
      try {
        logHeavySiteBuildGeoAudit('headings_start', {
          source: 'a11y_get_by_role_heading'
        });
        const allText = await page.getByRole('heading').allTextContents().catch(() => []);
        const h1Text = await page.getByRole('heading', { level: 1 }).allTextContents().catch(() => []);
        const h2Text = await page.getByRole('heading', { level: 2 }).allTextContents().catch(() => []);
        const h3Text = await page.getByRole('heading', { level: 3 }).allTextContents().catch(() => []);
        a11yHeadings.all = uniqueHeadingTexts(allText, 30);
        a11yHeadings.h1 = uniqueHeadingTexts(h1Text, 10);
        a11yHeadings.h2 = uniqueHeadingTexts(h2Text, 20);
        a11yHeadings.h3 = uniqueHeadingTexts(h3Text, 20);
        a11yHeadings.observed = true;
        logHeavySiteBuildGeoAudit('headings_end', {
          source: 'a11y_get_by_role_heading',
          allCount: a11yHeadings.all.length,
          h1Count: a11yHeadings.h1.length,
          h2Count: a11yHeadings.h2.length,
          h3Count: a11yHeadings.h3.length
        });
      } catch (e) {
        a11yHeadings.error = String(e && (e.message || e) || '').slice(0, 160);
        logHeavySiteBuildGeoAudit('headings_end', {
          source: 'a11y_get_by_role_heading',
          error: a11yHeadings.error
        });
      }
    }
    const filteredDomH1 = filterHeadingTexts(domH1);
    const filteredDomH2 = filterHeadingTexts(domH2);
    const filteredDomH3 = filterHeadingTexts(domH3);
    const filteredMainH1 = filterHeadingTexts(Array.isArray(mainHeadings.h1) ? mainHeadings.h1 : []);
    const filteredMainH2 = filterHeadingTexts(Array.isArray(mainHeadings.h2) ? mainHeadings.h2 : []);
    const filteredAppRootH1 = filterHeadingTexts(Array.isArray(appRootHeadings.h1) ? appRootHeadings.h1 : []);
    const filteredAppRootH2 = filterHeadingTexts(Array.isArray(appRootHeadings.h2) ? appRootHeadings.h2 : []);
    const filteredHeroH1 = filterHeadingTexts(Array.isArray(heroHeadings.h1) ? heroHeadings.h1 : []);
    const filteredHeroH2 = filterHeadingTexts(Array.isArray(heroHeadings.h2) ? heroHeadings.h2 : []);
    const filteredIframeH1 = filterHeadingTexts(Array.isArray(iframeSameOriginHeadings.h1) ? iframeSameOriginHeadings.h1 : []);
    const filteredIframeH2 = filterHeadingTexts(Array.isArray(iframeSameOriginHeadings.h2) ? iframeSameOriginHeadings.h2 : []);
    const filteredShadowH1 = filterHeadingTexts(Array.isArray(shadowHeadings.h1) ? shadowHeadings.h1 : []);
    const filteredShadowH2 = filterHeadingTexts(Array.isArray(shadowHeadings.h2) ? shadowHeadings.h2 : []);
    const filteredShadowH3 = filterHeadingTexts(Array.isArray(shadowHeadings.h3) ? shadowHeadings.h3 : []);
    const filteredA11yH1 = filterHeadingTexts(a11yHeadings.h1);
    const filteredA11yH2 = filterHeadingTexts(a11yHeadings.h2);
    const filteredA11yH3 = filterHeadingTexts(a11yHeadings.h3);
    const filteredA11yAll = filterHeadingTexts(a11yHeadings.all);
    const excludedHeadingReasons = Array.from(new Set(headingExclusions.map(x => x.reason).filter(Boolean)));
    const mergedH1 = filteredMainH1.length
      ? uniqueHeadingTexts(filteredMainH1, 10)
      : (filteredAppRootH1.length
        ? uniqueHeadingTexts(filteredAppRootH1, 10)
        : (filteredHeroH1.length
          ? uniqueHeadingTexts(filteredHeroH1, 10)
          : (filteredDomH1.length
            ? uniqueHeadingTexts(filteredDomH1, 10)
            : (filteredShadowH1.length
              ? uniqueHeadingTexts(filteredShadowH1, 10)
              : (filteredIframeH1.length ? uniqueHeadingTexts(filteredIframeH1, 10) : filteredA11yH1.slice(0, 10))))));
    const mergedH2 = uniqueHeadingTexts(filteredMainH2.concat(filteredAppRootH2).concat(filteredHeroH2).concat(filteredDomH2).concat(filteredShadowH2).concat(filteredIframeH2).concat(filteredA11yH2), 20);
    const mergedH3 = uniqueHeadingTexts(filteredDomH3.concat(filteredShadowH3).concat(filteredA11yH3), 20);
    const h1Source = filteredMainH1.length ? 'main_dom'
      : (filteredAppRootH1.length ? 'app_root_dom'
        : (filteredHeroH1.length ? 'hero_dom'
          : (filteredDomH1.length ? 'dom'
            : (filteredShadowH1.length ? 'open_shadow_dom'
              : (filteredIframeH1.length ? 'iframe_same_origin'
                : (filteredA11yH1.length ? 'a11y' : 'not_observed'))))));
    const headingSourceParts = [];
    if (filteredDomH1.length || filteredDomH2.length || filteredDomH3.length) headingSourceParts.push('dom');
    if (filteredMainH1.length || filteredMainH2.length) headingSourceParts.push('main_dom');
    if (filteredAppRootH1.length || filteredAppRootH2.length) headingSourceParts.push('app_root_dom');
    if (filteredHeroH1.length || filteredHeroH2.length) headingSourceParts.push('hero_dom');
    if (filteredShadowH1.length || filteredShadowH2.length || filteredShadowH3.length) headingSourceParts.push('open_shadow_dom');
    if (filteredIframeH1.length || filteredIframeH2.length) headingSourceParts.push('iframe_same_origin');
    if (a11yHeadings.observed) headingSourceParts.push('a11y');
    const headingSource = headingSourceParts.length ? Array.from(new Set(headingSourceParts)).join('+') : 'not_observed';
    const headingObservationLimited = !filteredDomH1.length && !filteredA11yH1.length;
    const headingTextsMerged = uniqueHeadingTexts(mergedH1.concat(mergedH2).concat(mergedH3).concat(filteredA11yAll), 30);
    const titleTextForCandidate = normalizeHeadingText(observed.title);
    const metaTextForCandidate = normalizeHeadingText(observed.metaDescription);
    const isStrongPrimaryHeadingText = (text) => {
      const s = normalizeHeadingText(text);
      if (!s || s.length < 12) return false;
      if (titleTextForCandidate && (titleTextForCandidate.indexOf(s) >= 0 || s.indexOf(titleTextForCandidate) >= 0)) return true;
      if (metaTextForCandidate && metaTextForCandidate.indexOf(s) >= 0) return true;
      return false;
    };
    const pickSectionHeadingCandidate = () => {
      const sources = [
        { texts: filteredMainH2, source: 'main_h2', confidence: 'medium' },
        { texts: filteredHeroH2, source: 'hero_h2', confidence: 'medium' },
        { texts: filteredAppRootH2, source: 'app_root_h2', confidence: 'medium' },
        { texts: filteredShadowH2, source: 'open_shadow_dom_h2', confidence: 'medium' },
        { texts: filteredA11yH2, source: 'a11y_h2', confidence: 'medium' },
        { texts: filteredDomH2, source: 'dom_h2', confidence: 'low' },
        { texts: filteredShadowH3, source: 'open_shadow_dom_h3', confidence: 'low' },
        { texts: filteredA11yH3, source: 'a11y_h3', confidence: 'low' },
        { texts: filteredDomH3, source: 'dom_h3', confidence: 'low' }
      ];
      for (const item of sources) {
        const text = uniqueHeadingTexts(item.texts, 1)[0];
        if (!text || text.length < 2) continue;
        return {
          text,
          source: item.source,
          confidence: item.confidence
        };
      }
      return {
        text: '',
        source: 'not_observed',
        confidence: 'low'
      };
    };
    const pickPrimaryHeadingCandidate = () => {
      const sources = [
        { texts: mergedH1, source: h1Source === 'not_observed' ? 'h1' : h1Source, confidence: 'high', h1Equivalent: true, requireStrong: false },
        { texts: filteredMainH2, source: 'main_h2', confidence: 'medium', h1Equivalent: true, requireStrong: true },
        { texts: filteredHeroH2, source: 'hero_h2', confidence: 'medium', h1Equivalent: true, requireStrong: true },
        { texts: filteredAppRootH2, source: 'app_root_h2', confidence: 'medium', h1Equivalent: true, requireStrong: true },
        { texts: [observed.title], source: 'title', confidence: 'low', h1Equivalent: false },
        { texts: [observed.metaDescription], source: 'meta_description', confidence: 'low', h1Equivalent: false }
      ];
      for (const item of sources) {
        const text = uniqueHeadingTexts(item.texts, 1)[0];
        if (!text || text.length < 2) continue;
        if (item.requireStrong && !isStrongPrimaryHeadingText(text)) continue;
        return {
          text,
          source: item.source,
          confidence: item.confidence,
          h1Equivalent: !!item.h1Equivalent
        };
      }
      return {
        text: '',
        source: 'not_observed',
        confidence: 'low',
        h1Equivalent: false
      };
    };
    const sectionHeadingCandidate = pickSectionHeadingCandidate();
    const primaryHeadingCandidate = pickPrimaryHeadingCandidate();
    const h1EquivalentCandidateFound = mergedH1.length === 0 && !!(primaryHeadingCandidate.text && primaryHeadingCandidate.h1Equivalent);
    const domLandmarks = observed.landmarks && typeof observed.landmarks === 'object'
      ? observed.landmarks
      : {};
    const a11yMain = {
      count: 0,
      texts: [],
      observed: false,
      error: null
    };
    const bodyTextLengthForMain = Number(observed && observed.body && observed.body.textLength || 0);
    const domHasMainLikeElement = !!(
      domLandmarks.hasMainLandmark === true ||
      domLandmarks.mainLandmarkCandidateFound === true ||
      bodyTextLengthForMain >= 800
    );
    if (shortFastMode) {
      a11yMain.error = 'skipped_short_fast';
    } else if (domHasMainLikeElement) {
      a11yMain.error = 'skipped_dom_main_or_body_text_already_observed';
      logHeavySiteBuildGeoAudit('main_a11y_skip', {
        reason: 'dom_main_or_body_text_already_observed',
        bodyTextLength: bodyTextLengthForMain,
        hasMainLikeElement: domHasMainLikeElement,
        hasMain: domLandmarks.hasMainLandmark === true,
        hasArticle: domLandmarks.mainLandmarkSource === 'dom_article',
        hasRoleMain: domLandmarks.mainLandmarkSource === 'dom_role_main',
        mainLandmarkSource: domLandmarks.mainLandmarkSource || null,
        mainLandmarkCandidateFound: domLandmarks.mainLandmarkCandidateFound === true,
        mainLandmarkCandidateSource: domLandmarks.mainLandmarkCandidateSource || null
      });
    } else {
      try {
        logHeavySiteBuildGeoAudit('shadow_dom_or_deep_query_start', {
          source: 'a11y_get_by_role_main'
        });
        const mainLocator = page.getByRole('main');
        const mainTexts = await mainLocator.allTextContents().catch(() => []);
        a11yMain.texts = uniqueHeadingTexts(mainTexts.map((v) => String(v || '').slice(0, 220)), 3);
        a11yMain.count = a11yMain.texts.length;
        a11yMain.observed = true;
        logHeavySiteBuildGeoAudit('shadow_dom_or_deep_query_end', {
          source: 'a11y_get_by_role_main',
          count: a11yMain.count,
          observed: a11yMain.observed
        });
      } catch (e) {
        a11yMain.error = String(e && (e.message || e) || '').slice(0, 160);
        logHeavySiteBuildGeoAudit('shadow_dom_or_deep_query_end', {
          source: 'a11y_get_by_role_main',
          error: a11yMain.error
        });
      }
    }
    const hasDomMain = domLandmarks.hasMainLandmark === true;
    const hasA11yMain = a11yMain.count > 0;
    const mainLandmarkSource = hasDomMain
      ? (domLandmarks.mainLandmarkSource || 'dom_main')
      : (hasA11yMain ? 'a11y_main' : 'not_observed');
    const mainLandmarkConfidence = hasDomMain
      ? (domLandmarks.mainLandmarkConfidence || 'high')
      : (hasA11yMain ? 'medium' : 'low');
    const mainLandmarkTextsSample = hasDomMain
      ? (Array.isArray(domLandmarks.mainLandmarkTextsSample) ? domLandmarks.mainLandmarkTextsSample.slice(0, 3) : [])
      : a11yMain.texts.slice(0, 3);
    const mainLandmarkCandidateFound = domLandmarks.mainLandmarkCandidateFound === true;
    const mainLandmarkCandidateSource = domLandmarks.mainLandmarkCandidateSource || 'not_observed';
    const mainLandmarkCandidateConfidence = domLandmarks.mainLandmarkCandidateConfidence || 'low';
    const mainLandmarkCandidateTextsSample = Array.isArray(domLandmarks.mainLandmarkCandidateTextsSample)
      ? domLandmarks.mainLandmarkCandidateTextsSample.slice(0, 3)
      : [];
    const hasMainLandmarkFinal = hasDomMain || hasA11yMain
      ? true
      : null;
    const mainLandmarkObservationLimited = !(hasDomMain || hasA11yMain);
    const structuredDataStart = Date.now();
    logHeavySiteBuildGeoAudit('jsonld_parse_start', {
      source: 'html_content_and_same_origin_script_src'
    });
    logHeavySiteBuildGeoAudit('structured_data_start', {
      source: 'html_content_and_same_origin_script_src',
      balancedMode
    });
    const htmlContentJsonLdSummary = balancedMode
      ? await collectHtmlContentJsonLdSummaryLight(page)
      : null;
    const scriptSrcJsonLdSummary = balancedMode
      ? await collectSameOriginScriptSrcJsonLdSummaryLight(page, url, shortFastMode
        ? { maxScripts: 3, maxBytesPerScript: 512000 }
        : {})
      : null;
    phaseTimings.structuredDataMs = Math.max(0, Date.now() - structuredDataStart);
    logHeavySiteBuildGeoAudit('jsonld_parse_end', {
      source: 'html_content_and_same_origin_script_src',
      structuredDataMs: phaseTimings.structuredDataMs,
      htmlRawCount: htmlContentJsonLdSummary && htmlContentJsonLdSummary.rawCount,
      htmlParseableCount: htmlContentJsonLdSummary && htmlContentJsonLdSummary.parseableCount,
      scriptSrcCandidateCount: scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.candidateCount,
      scriptSrcFetchedCount: scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.fetchedCount,
      scriptSrcError: scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.error || null,
      htmlContentError: htmlContentJsonLdSummary && htmlContentJsonLdSummary.error || null
    });
    logHeavySiteBuildGeoAudit('structured_data_end', {
      source: 'html_content_and_same_origin_script_src',
      structuredDataMs: phaseTimings.structuredDataMs,
      htmlRawCount: htmlContentJsonLdSummary && htmlContentJsonLdSummary.rawCount,
      scriptSrcCandidateCount: scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.candidateCount
    });
    const renderedStructured = observed.structuredData && typeof observed.structuredData === 'object' ? observed.structuredData : {};
    const renderedTypes = Array.isArray(renderedStructured.types) ? renderedStructured.types : [];
    const htmlTypes = htmlContentJsonLdSummary && Array.isArray(htmlContentJsonLdSummary.types) ? htmlContentJsonLdSummary.types : [];
    const scriptSrcTypes = scriptSrcJsonLdSummary && Array.isArray(scriptSrcJsonLdSummary.types) ? scriptSrcJsonLdSummary.types : [];
    const mergedJsonLdTypes = Array.from(new Set(renderedTypes.concat(htmlTypes).concat(scriptSrcTypes).filter(Boolean))).slice(0, 50);
    const renderedRawCount = typeof renderedStructured.rawCount === 'number' ? renderedStructured.rawCount : 0;
    const htmlRawCount = htmlContentJsonLdSummary && typeof htmlContentJsonLdSummary.rawCount === 'number' ? htmlContentJsonLdSummary.rawCount : 0;
    const scriptSrcCandidateCount = scriptSrcJsonLdSummary && typeof scriptSrcJsonLdSummary.candidateCount === 'number' ? scriptSrcJsonLdSummary.candidateCount : 0;
    const renderedParseableCount = typeof renderedStructured.parseableCount === 'number' ? renderedStructured.parseableCount : 0;
    const htmlParseableCount = htmlContentJsonLdSummary && typeof htmlContentJsonLdSummary.parseableCount === 'number' ? htmlContentJsonLdSummary.parseableCount : 0;
    const scriptSrcParseableCount = scriptSrcJsonLdSummary && typeof scriptSrcJsonLdSummary.parseableCount === 'number' ? scriptSrcJsonLdSummary.parseableCount : 0;
    const renderedParseErrorsCount = typeof renderedStructured.parseErrorsCount === 'number' ? renderedStructured.parseErrorsCount : 0;
    const htmlParseErrorsCount = htmlContentJsonLdSummary && typeof htmlContentJsonLdSummary.parseErrorsCount === 'number' ? htmlContentJsonLdSummary.parseErrorsCount : 0;
    const observedMultimodalSignals = observed.multimodalSignals && typeof observed.multimodalSignals === 'object'
      ? observed.multimodalSignals
      : null;
    const observedTrustSignals = observed.trustSignals && typeof observed.trustSignals === 'object'
      ? observed.trustSignals
      : null;
    const observedCoverageSignals = observed.coverage && typeof observed.coverage === 'object'
      ? observed.coverage
      : null;
    const scriptTrustObserved = scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.observed;
    const domContactObserved = observedTrustSignals && typeof observedTrustSignals.contactPathFound === 'boolean'
      ? observedTrustSignals.contactPathFound
      : (observedTrustSignals && typeof observedTrustSignals.hasContactLink === 'boolean' ? observedTrustSignals.hasContactLink : null);
    const scriptContactHint = scriptTrustObserved && scriptSrcJsonLdSummary.contactPathFound === true;
    const domCompanyObserved = observedTrustSignals && typeof observedTrustSignals.hasCompanyLink === 'boolean'
      ? observedTrustSignals.hasCompanyLink
      : null;
    const domPrivacyObserved = observedTrustSignals && typeof observedTrustSignals.hasPrivacyPolicyLink === 'boolean'
      ? observedTrustSignals.hasPrivacyPolicyLink
      : null;
    const domLegalObserved = observedTrustSignals && typeof observedTrustSignals.hasLegalLink === 'boolean'
      ? observedTrustSignals.hasLegalLink
      : null;
    const domTermsObserved = observedTrustSignals && typeof observedTrustSignals.hasTermsLink === 'boolean'
      ? observedTrustSignals.hasTermsLink
      : null;
    const scriptCompanyHint = scriptTrustObserved && scriptSrcJsonLdSummary.companyPathFound === true;
    const scriptServiceHint = scriptTrustObserved && scriptSrcJsonLdSummary.servicePathFound === true;
    const scriptPrivacyHint = scriptTrustObserved && scriptSrcJsonLdSummary.privacyPathFound === true;
    const trustSignalsLight = {
      hasContactLink: domContactObserved,
      contactPathFound: domContactObserved,
      contactObservedFromDom: domContactObserved,
      contactObservedFromScriptHint: !!scriptContactHint,
      contactPathHintOnly: domContactObserved !== true && !!scriptContactHint,
      contactConfidence: domContactObserved === true ? 'high' : (scriptContactHint ? 'hint_only' : 'unknown'),
      contactLinkSource: domContactObserved === true ? 'dom' : (scriptContactHint ? 'script_hint' : 'not_observed'),
      contactLinkSample: observedTrustSignals && observedTrustSignals.contactLinkSample
        ? observedTrustSignals.contactLinkSample
        : (scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.contactPathSample ? { text: 'same-origin script path', href: scriptSrcJsonLdSummary.contactPathSample } : null),
      hasCompanyLink: domCompanyObserved,
      companyObservedFromScriptHint: !!scriptCompanyHint,
      companyLinkSource: domCompanyObserved === true ? 'dom' : (scriptCompanyHint ? 'script_hint' : 'not_observed'),
      companyLinkSample: observedTrustSignals && observedTrustSignals.companyLinkSample
        ? observedTrustSignals.companyLinkSample
        : (scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.companyPathSample ? { text: 'same-origin script path', href: scriptSrcJsonLdSummary.companyPathSample } : null),
      hasServiceLink: observedTrustSignals && typeof observedTrustSignals.hasServiceLink === 'boolean'
        ? observedTrustSignals.hasServiceLink
        : null,
      serviceObservedFromScriptHint: !!scriptServiceHint,
      serviceLinkSource: observedTrustSignals && observedTrustSignals.hasServiceLink === true ? 'dom' : (scriptServiceHint ? 'script_hint' : 'not_observed'),
      serviceLinkSample: observedTrustSignals && observedTrustSignals.serviceLinkSample
        ? observedTrustSignals.serviceLinkSample
        : (scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.servicePathSample ? { text: 'same-origin script path', href: scriptSrcJsonLdSummary.servicePathSample } : null),
      hasPrivacyPolicyLink: domPrivacyObserved,
      privacyObservedFromScriptHint: !!scriptPrivacyHint,
      privacyLinkSource: domPrivacyObserved === true ? 'dom' : (scriptPrivacyHint ? 'script_hint' : 'not_observed'),
      privacyLinkSample: observedTrustSignals && observedTrustSignals.privacyLinkSample
        ? observedTrustSignals.privacyLinkSample
        : (scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.privacyPathSample ? { text: 'same-origin script path', href: scriptSrcJsonLdSummary.privacyPathSample } : null),
      hasLegalLink: domLegalObserved,
      legalLinkSource: domLegalObserved === true ? 'dom' : 'not_observed',
      legalLinkSample: observedTrustSignals && observedTrustSignals.legalLinkSample
        ? observedTrustSignals.legalLinkSample
        : null,
      hasTermsLink: domTermsObserved,
      termsLinkSource: domTermsObserved === true ? 'dom' : 'not_observed',
      termsLinkSample: observedTrustSignals && observedTrustSignals.termsLinkSample
        ? observedTrustSignals.termsLinkSample
        : null,
      scriptSrcTrustObserved: !!scriptTrustObserved,
      source: scriptTrustObserved ? 'balanced_light_dom_plus_script_src' : 'balanced_light'
    };
    const pickStructuredBool = (key) => {
      const renderedVal = typeof renderedStructured[key] === 'boolean' ? renderedStructured[key] : null;
      const htmlVal = htmlContentJsonLdSummary && typeof htmlContentJsonLdSummary[key] === 'boolean' ? htmlContentJsonLdSummary[key] : null;
      const scriptVal = scriptSrcJsonLdSummary && typeof scriptSrcJsonLdSummary[key] === 'boolean' ? scriptSrcJsonLdSummary[key] : null;
      if (renderedVal === true || htmlVal === true || scriptVal === true) return true;
      if (renderedVal === false && (htmlVal === false || htmlVal == null) && (scriptVal === false || scriptVal == null)) return false;
      if (htmlVal === false && (renderedVal === false || renderedVal == null) && (scriptVal === false || scriptVal == null)) return false;
      if (scriptVal === false && (renderedVal === false || renderedVal == null) && (htmlVal === false || htmlVal == null)) return false;
      return null;
    };
    const mergedJsonLdTypeClass = classifyJsonLdTypesForSeo(mergedJsonLdTypes);
    const structuredDataLight = {
      types: mergedJsonLdTypes,
      seoTypes: mergedJsonLdTypeClass.seoTypes,
      nonSeoTypes: mergedJsonLdTypeClass.nonSeoTypes,
      telemetryTypes: mergedJsonLdTypeClass.telemetryTypes,
      excludedFromSeoTypes: mergedJsonLdTypeClass.excludedFromSeoTypes,
      rawCount: balancedMode ? (renderedRawCount + htmlRawCount + scriptSrcCandidateCount) : renderedRawCount,
      parseableCount: balancedMode ? (renderedParseableCount + htmlParseableCount + scriptSrcParseableCount) : renderedParseableCount,
      hasJsonLd: balancedMode ? pickStructuredBool('hasJsonLd') : (typeof renderedStructured.hasJsonLd === 'boolean' ? renderedStructured.hasJsonLd : null),
      hasSeoJsonLd: (balancedMode || renderedRawCount > 0) ? mergedJsonLdTypeClass.hasSeoJsonLd : null,
      hasWebsite: balancedMode ? mergedJsonLdTypeClass.hasWebsite : (observed.structuredData ? observed.structuredData.hasWebsite : null),
      hasOrganization: balancedMode ? mergedJsonLdTypeClass.hasOrganization : (observed.structuredData ? observed.structuredData.hasOrganization : null),
      hasBreadcrumbList: balancedMode ? mergedJsonLdTypeClass.hasBreadcrumbList : (observed.structuredData ? observed.structuredData.hasBreadcrumbList : null),
      hasFAQPage: balancedMode ? mergedJsonLdTypeClass.hasFAQPage : (observed.structuredData ? observed.structuredData.hasFAQPage : null),
      typeClassificationSource: mergedJsonLdTypeClass.typeClassificationSource,
      source: balancedMode ? 'rendered_dom_plus_html_ldjson_plus_script_src_jsonld_light' : (observed.structuredData && observed.structuredData.source ? observed.structuredData.source : 'rendered_dom_jsonld_light'),
      confidence: observed.structuredData && observed.structuredData.confidence ? observed.structuredData.confidence : 'medium',
      observationLimited: true,
      observationScope: balancedMode ? 'rendered_dom_plus_html_ldjson_plus_script_src_jsonld_only' : (observed.structuredData && observed.structuredData.observationScope ? observed.structuredData.observationScope : 'rendered_dom_only'),
      renderedDomObserved: observed.structuredData && typeof observed.structuredData.renderedDomObserved === 'boolean' ? observed.structuredData.renderedDomObserved : true,
      htmlContentLdJsonObserved: balancedMode ? !!(htmlContentJsonLdSummary && htmlContentJsonLdSummary.htmlContentLdJsonObserved) : false,
      htmlContentRawCount: balancedMode ? htmlRawCount : 0,
      htmlContentParseableCount: balancedMode ? htmlParseableCount : 0,
      scriptSrcJsonLdObserved: balancedMode ? !!(scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.observed) : false,
      scriptSrcCandidateCount: balancedMode ? Number(scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.sameOriginScriptCount || 0) : 0,
      scriptSrcFetchedCount: balancedMode ? Number(scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.fetchedCount || 0) : 0,
      scriptSrcJsonLdCandidateCount: balancedMode ? scriptSrcCandidateCount : 0,
      scriptSrcJsonLdTypes: balancedMode ? scriptSrcTypes.slice(0, 50) : [],
      scriptSrcSkippedLargeCount: balancedMode ? Number(scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.skippedLargeCount || 0) : 0,
      scriptSrcAppIndexDetected: balancedMode ? !!(scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.appIndexDetected) : false,
      renderedDomRawCount: renderedRawCount,
      renderedDomParseableCount: renderedParseableCount,
      organizationSummary: renderedStructured.organizationSummary || (htmlContentJsonLdSummary && htmlContentJsonLdSummary.organizationSummary) || null,
      sameAsSummary: renderedStructured.sameAsSummary || (htmlContentJsonLdSummary && htmlContentJsonLdSummary.sameAsSummary) || null,
      htmlScanSkipped: true,
      jsScanSkipped: true,
      chunkScanSkipped: observed.structuredData && typeof observed.structuredData.chunkScanSkipped === 'boolean' ? observed.structuredData.chunkScanSkipped : true,
      parseErrorsCount: balancedMode ? Math.max(renderedParseErrorsCount, htmlParseErrorsCount) : renderedParseErrorsCount,
      htmlContentParseErrorsCount: balancedMode ? htmlParseErrorsCount : 0,
      scriptSrcError: scriptSrcJsonLdSummary && scriptSrcJsonLdSummary.error || null,
      htmlContentError: htmlContentJsonLdSummary && htmlContentJsonLdSummary.error || null
    };
    const articleSignals = await collectArticleSignalsFromPageLight_(page, url);
    console.log('[DEBUG][ARTICLE_SIGNALS_AUDIT]', JSON.stringify({
      checked: articleSignals.checked === true,
      hasArticleType: articleSignals.summary && articleSignals.summary.hasArticleType,
      hasHeadline: articleSignals.summary && articleSignals.summary.hasHeadline,
      hasPublishedDate: articleSignals.summary && articleSignals.summary.hasPublishedDate,
      hasModifiedDate: articleSignals.summary && articleSignals.summary.hasModifiedDate,
      hasAuthor: articleSignals.summary && articleSignals.summary.hasAuthor,
      hasPublisher: articleSignals.summary && articleSignals.summary.hasPublisher,
      jsonLdTypes: articleSignals.jsonLd && Array.isArray(articleSignals.jsonLd.types) ? articleSignals.jsonLd.types : [],
      metaKeys: articleSignals.meta ? Object.keys(articleSignals.meta).filter(key => {
        const value = articleSignals.meta[key];
        return Array.isArray(value) ? value.length > 0 : !!value;
      }) : []
    }));

    const geoSignalsV1 = {
      version: 'geoSignalsV1',
      generatedAt,
      url: String(url || ''),
      structuredData: structuredDataLight,
      articleSignals,
      headings: {
        h1Count: mergedH1.length,
        h2Count: mergedH2.length,
        h3Count: mergedH3.length,
        hasH1: mergedH1.length > 0,
        hasSingleH1: mergedH1.length === 1,
        h1Texts: mergedH1.slice(0, 5),
        headingTexts: headingTextsMerged,
        primaryHeadingCandidate: primaryHeadingCandidate.text || '',
        primaryHeadingCandidateSource: primaryHeadingCandidate.source,
        primaryHeadingConfidence: primaryHeadingCandidate.confidence,
        h1EquivalentCandidateFound,
        sectionHeadingCandidate: sectionHeadingCandidate.text || '',
        sectionHeadingCandidateSource: sectionHeadingCandidate.source,
        sectionHeadingConfidence: sectionHeadingCandidate.confidence,
        source: headingSource,
        h1Source,
        headingObservationLimited,
        excludedHeadingCount: headingExclusions.length,
        excludedHeadingReasons,
        a11yObserved: !!a11yHeadings.observed
      },
      balanced: {
        enabled: balancedMode,
        shadowHeadingScan: !!(balancedMode && !shortFastMode),
        shadowHeadingObserved: !!(shadowHeadings && shadowHeadings.observed),
        shadowHostCount: Number(shadowHeadings && shadowHeadings.hostCount || 0),
        shadowHeadingError: shadowHeadings && shadowHeadings.error || null,
        mainH1Texts: filteredMainH1.slice(0, 5),
        mainH2Texts: filteredMainH2.slice(0, 10),
        appRootH1Texts: filteredAppRootH1.slice(0, 5),
        appRootH2Texts: filteredAppRootH2.slice(0, 10),
        heroH1Texts: filteredHeroH1.slice(0, 5),
        heroH2Texts: filteredHeroH2.slice(0, 10),
        shadowH1Texts: filteredShadowH1.slice(0, 5),
        shadowH2Texts: filteredShadowH2.slice(0, 10),
        iframeSameOriginH1Texts: filteredIframeH1.slice(0, 5),
        iframeSameOriginH2Texts: filteredIframeH2.slice(0, 10),
        primaryHeadingCandidate: primaryHeadingCandidate.text || '',
        primaryHeadingCandidateSource: primaryHeadingCandidate.source,
        primaryHeadingConfidence: primaryHeadingCandidate.confidence,
        h1EquivalentCandidateFound,
        sectionHeadingCandidate: sectionHeadingCandidate.text || '',
        sectionHeadingCandidateSource: sectionHeadingCandidate.source,
        sectionHeadingConfidence: sectionHeadingCandidate.confidence,
        boundedWaitMs: boundedHydrationWaitMs,
        hydration: {
          waitMs: Number(hydrationMetrics.waitMs || 0),
          bodyTextBeforeWait: Number(hydrationMetrics.bodyTextBeforeWait || 0),
          bodyTextAfterWait: Number(hydrationMetrics.bodyTextAfterWait || 0),
          anchorCountBeforeWait: Number(hydrationMetrics.anchorCountBeforeWait || 0),
          anchorCountAfterWait: Number(hydrationMetrics.anchorCountAfterWait || 0),
          navLinkCountBeforeWait: Number(hydrationMetrics.navLinkCountBeforeWait || 0),
          navLinkCountAfterWait: Number(hydrationMetrics.navLinkCountAfterWait || 0),
          improvedBodyText: !!hydrationMetrics.improvedBodyText,
          improvedLinks: !!hydrationMetrics.improvedLinks,
          warningTextBeforeWait: !!hydrationMetrics.warningTextBeforeWait,
          warningTextAfterWait: !!hydrationMetrics.warningTextAfterWait
        },
        h1Attempts: {
          dom: { count: filteredDomH1.length, source: 'dom' },
          main: { count: filteredMainH1.length, source: 'main_dom' },
          appRoot: {
            count: filteredAppRootH1.length,
            rootCount: Number(appRootHeadings.rootCount || 0),
            source: 'app_root_dom'
          },
          hero: {
            count: filteredHeroH1.length,
            rootCount: Number(heroHeadings.rootCount || 0),
            source: 'hero_dom'
          },
          shadow: {
            count: filteredShadowH1.length,
            hostCount: Number(shadowHeadings && shadowHeadings.hostCount || 0),
            observed: !!(shadowHeadings && shadowHeadings.observed),
            error: shadowHeadings && shadowHeadings.error || null,
            source: 'open_shadow_dom'
          },
          a11y: {
            count: filteredA11yH1.length,
            observed: !!a11yHeadings.observed,
            error: a11yHeadings.error,
            source: 'a11y'
          },
          iframeSameOrigin: {
            count: filteredIframeH1.length,
            iframeCount: Number(iframeSameOriginHeadings.iframeCount || 0),
            accessibleCount: Number(iframeSameOriginHeadings.accessibleCount || 0),
            blockedCount: Number(iframeSameOriginHeadings.blockedCount || 0),
            error: iframeSameOriginHeadings.error || null,
            source: 'iframe_same_origin'
          }
        }
      },
      landmarks: {
        hasMainLandmark: hasMainLandmarkFinal,
        hasMainLandmark_final: hasMainLandmarkFinal,
        mainLandmarkSource,
        mainLandmarkConfidence,
        mainLandmarkTextsSample,
        mainLandmarkCandidateFound,
        mainLandmarkCandidateSource,
        mainLandmarkCandidateConfidence,
        mainLandmarkCandidateTextsSample,
        mainLandmarkObservationLimited,
        a11yObserved: !!a11yMain.observed,
        a11yMainCount: a11yMain.count,
        a11yError: a11yMain.error
      },
      multimodalSignals: observedMultimodalSignals || {
        checked: !!balancedMode,
        hasImage: null,
        hasStructured: null,
        source: 'balanced_light'
      },
      clarity: observed.clarity || {
        ctaTexts: [],
        ctaCandidatesCount: null,
        ctaObserved: null,
        source: 'not_observed'
      },
      trustSignals: trustSignalsLight,
      coverage: observedCoverageSignals || {
        semanticElements: {
          hasHeaderElement: null,
          hasNavElement: null,
          hasFooterElement: null,
          headerCount: null,
          navCount: null,
          footerCount: null,
          semanticElementsObserved: null,
          source: 'not_observed'
        },
        hasFaqLink: null,
        hasFaqNav: null,
        hasFaqSection: null,
        faqLinkSource: 'not_observed',
        faqLinkSample: null,
        faqSectionSource: 'not_observed',
        faqSectionTextSample: '',
        breadcrumbUiObserved: null,
        hasBreadcrumbUi: null,
        breadcrumbUiSource: 'not_observed',
        breadcrumbUiTextSample: '',
        footerSignals: {
          observed: null,
          linkCount: null,
          hasPrivacyLink: null,
          hasCompanyLink: null,
          hasCompanyProfileLink: null,
          hasContactLink: null,
          hasLegalLink: null,
          hasTermsLink: null,
          sampleTexts: [],
          externalProfileLinksSample: [],
          socialLinksSample: [],
          footerExternalLinksSample: [],
          source: 'not_observed'
        },
        source: 'not_observed'
      },
      observed: {
        title: {
          value: observed.title || null,
          observed: !!observed.title,
          source: 'rendered_dom',
          confidence: observed.title ? 'high' : 'low'
        },
        metaDescription: {
          value: observed.metaDescription || null,
          observed: !!observed.metaDescription,
          source: 'rendered_dom',
          confidence: observed.metaDescription ? 'high' : 'low'
        },
        h1: {
          values: mergedH1.slice(0, 5),
          count: mergedH1.length,
          observed: domH1.length > 0 || a11yHeadings.observed,
          source: h1Source,
          confidence: mergedH1.length ? 'high' : (a11yHeadings.observed ? 'medium' : 'low'),
          hasH1: mergedH1.length > 0,
          hasSingleH1: mergedH1.length === 1,
          headingObservationLimited
        },
        headings: {
          h1: mergedH1.slice(0, 5),
          h2: mergedH2.slice(0, 10),
          h3: mergedH3.slice(0, 10),
          headingTexts: headingTextsMerged,
          primaryHeadingCandidate: primaryHeadingCandidate.text || '',
          primaryHeadingCandidateSource: primaryHeadingCandidate.source,
          primaryHeadingConfidence: primaryHeadingCandidate.confidence,
          h1EquivalentCandidateFound,
          sectionHeadingCandidate: sectionHeadingCandidate.text || '',
          sectionHeadingCandidateSource: sectionHeadingCandidate.source,
          sectionHeadingConfidence: sectionHeadingCandidate.confidence,
          source: headingSource,
          h1Source,
          headingObservationLimited,
          a11y: {
            h1: filteredA11yH1.slice(0, 5),
            h2: filteredA11yH2.slice(0, 10),
            h3: filteredA11yH3.slice(0, 10),
            observed: !!a11yHeadings.observed,
            error: a11yHeadings.error
          },
          main: {
            h1: filteredMainH1.slice(0, 5),
            h2: filteredMainH2.slice(0, 10)
          },
          appRoot: {
            h1: filteredAppRootH1.slice(0, 5),
            h2: filteredAppRootH2.slice(0, 10),
            rootCount: Number(appRootHeadings.rootCount || 0)
          },
          hero: {
            h1: filteredHeroH1.slice(0, 5),
            h2: filteredHeroH2.slice(0, 10),
            rootCount: Number(heroHeadings.rootCount || 0)
          },
          shadow: {
            h1: filteredShadowH1.slice(0, 5),
            h2: filteredShadowH2.slice(0, 10),
            h3: filteredShadowH3.slice(0, 10),
            observed: !!(shadowHeadings && shadowHeadings.observed),
            hostCount: Number(shadowHeadings && shadowHeadings.hostCount || 0),
            error: shadowHeadings && shadowHeadings.error || null
          },
          iframeSameOrigin: {
            h1: filteredIframeH1.slice(0, 5),
            h2: filteredIframeH2.slice(0, 10),
            iframeCount: Number(iframeSameOriginHeadings.iframeCount || 0),
            accessibleCount: Number(iframeSameOriginHeadings.accessibleCount || 0),
            blockedCount: Number(iframeSameOriginHeadings.blockedCount || 0),
            error: iframeSameOriginHeadings.error || null
          },
          excludedHeadingCount: headingExclusions.length,
          excludedHeadingReasons,
          confidence: headingTextsMerged.length ? 'high' : 'low'
        },
        links: {
          navTextsSample: observed.links && Array.isArray(observed.links.navTextsSample) ? observed.links.navTextsSample.slice(0, 50) : [],
          internalLinksSample: observed.links && Array.isArray(observed.links.internalLinksSample) ? observed.links.internalLinksSample.slice(0, 50) : [],
          externalProfileLinksSample: observed.links && Array.isArray(observed.links.externalProfileLinksSample) ? observed.links.externalProfileLinksSample.slice(0, 10) : [],
          socialLinksSample: observed.links && Array.isArray(observed.links.socialLinksSample) ? observed.links.socialLinksSample.slice(0, 10) : [],
          footerExternalLinksSample: observed.links && Array.isArray(observed.links.footerExternalLinksSample) ? observed.links.footerExternalLinksSample.slice(0, 10) : [],
          externalLinksSample: observed.links && Array.isArray(observed.links.externalLinksSample) ? observed.links.externalLinksSample.slice(0, 10) : [],
          hasCompanyLikeLink: observed.links ? observed.links.hasCompanyLikeLink : null,
          hasServiceLikeLink: observed.links ? observed.links.hasServiceLikeLink : null,
          hasContactLikeLink: observed.links ? observed.links.hasContactLikeLink : null,
          hasPrivacyLikeLink: observed.links ? observed.links.hasPrivacyLikeLink : null,
          source: 'rendered_dom',
          confidence: 'medium'
        },
        structuredData: {
          types: structuredDataLight.types,
          seoTypes: structuredDataLight.seoTypes,
          nonSeoTypes: structuredDataLight.nonSeoTypes,
          telemetryTypes: structuredDataLight.telemetryTypes,
          excludedFromSeoTypes: structuredDataLight.excludedFromSeoTypes,
          rawCount: structuredDataLight.rawCount,
          parseableCount: structuredDataLight.parseableCount,
          hasJsonLd: structuredDataLight.hasJsonLd,
          hasSeoJsonLd: structuredDataLight.hasSeoJsonLd,
          hasWebsite: structuredDataLight.hasWebsite,
          hasOrganization: structuredDataLight.hasOrganization,
          hasBreadcrumbList: structuredDataLight.hasBreadcrumbList,
          hasFAQPage: structuredDataLight.hasFAQPage,
          typeClassificationSource: structuredDataLight.typeClassificationSource,
          source: structuredDataLight.source,
          confidence: structuredDataLight.confidence,
          observationLimited: structuredDataLight.observationLimited,
          observationScope: structuredDataLight.observationScope,
          renderedDomObserved: structuredDataLight.renderedDomObserved,
          htmlContentLdJsonObserved: structuredDataLight.htmlContentLdJsonObserved,
          htmlContentRawCount: structuredDataLight.htmlContentRawCount,
          htmlContentParseableCount: structuredDataLight.htmlContentParseableCount,
          scriptSrcJsonLdObserved: structuredDataLight.scriptSrcJsonLdObserved,
          scriptSrcCandidateCount: structuredDataLight.scriptSrcCandidateCount,
          scriptSrcFetchedCount: structuredDataLight.scriptSrcFetchedCount,
          scriptSrcJsonLdCandidateCount: structuredDataLight.scriptSrcJsonLdCandidateCount,
          scriptSrcJsonLdTypes: structuredDataLight.scriptSrcJsonLdTypes,
          scriptSrcSkippedLargeCount: structuredDataLight.scriptSrcSkippedLargeCount,
          scriptSrcAppIndexDetected: structuredDataLight.scriptSrcAppIndexDetected,
          renderedDomRawCount: structuredDataLight.renderedDomRawCount,
          renderedDomParseableCount: structuredDataLight.renderedDomParseableCount,
          htmlScanSkipped: structuredDataLight.htmlScanSkipped,
          jsScanSkipped: structuredDataLight.jsScanSkipped,
          chunkScanSkipped: structuredDataLight.chunkScanSkipped,
          parseErrorsCount: structuredDataLight.parseErrorsCount,
          scriptSrcError: structuredDataLight.scriptSrcError
        },
        articleSignals,
        landmarks: {
          hasMainLandmark: hasMainLandmarkFinal,
          hasMainLandmark_final: hasMainLandmarkFinal,
          mainLandmarkSource,
          mainLandmarkConfidence,
          mainLandmarkTextsSample,
          mainLandmarkCandidateFound,
          mainLandmarkCandidateSource,
          mainLandmarkCandidateConfidence,
          mainLandmarkCandidateTextsSample,
          mainLandmarkObservationLimited,
          source: mainLandmarkSource,
          confidence: mainLandmarkConfidence
        },
        multimodalSignals: observedMultimodalSignals || null,
        clarity: observed.clarity || null,
        trustSignals: trustSignalsLight,
        coverage: observedCoverageSignals || null,
        body: {
          textLength: observed.body && typeof observed.body.textLength === 'number' ? observed.body.textLength : 0,
          sample: observed.body && typeof observed.body.sample === 'string' ? observed.body.sample : '',
          source: 'rendered_dom',
          confidence: 'medium'
        }
      },
      diagnostics: {
        evaluateCount: 1,
        balancedMode,
        shortFastMode,
        boundedHydrationWaitMs,
        hydrationWaitMs: Number(hydrationMetrics.waitMs || boundedHydrationWaitMs || 0),
        bodyTextBeforeWait: Number(hydrationMetrics.bodyTextBeforeWait || 0),
        bodyTextAfterWait: Number(hydrationMetrics.bodyTextAfterWait || 0),
        hydrationImprovedBodyText: !!hydrationMetrics.improvedBodyText,
        hydrationImprovedLinks: !!hydrationMetrics.improvedLinks,
        warningTextBeforeWait: !!hydrationMetrics.warningTextBeforeWait,
        warningTextAfterWait: !!hydrationMetrics.warningTextAfterWait,
        jsBundleAnalysis: false,
        resourceChunkScan: false,
        shadowHeadingScan: !!(balancedMode && !shortFastMode),
        a11yHeadingScan: !shortFastMode,
        appRootHeadingScan: !!balancedMode,
        heroHeadingScan: !!balancedMode,
        iframeHeadingScan: !!(balancedMode && !shortFastMode),
        primaryHeadingScan: !!balancedMode,
        shadowPrimaryHeadingScan: !!(balancedMode && !shortFastMode),
        mainCandidateScan: !!balancedMode,
        htmlContentLdJsonScan: !!balancedMode,
        skippedScans: shortFastMode
          ? ['deep_shadow_heading_scan', 'a11y_heading_scan', 'a11y_main_scan', 'iframe_heading_scan']
          : [],
        phaseTimings: Object.assign({}, phaseTimings, {
          totalMs: Math.max(0, Date.now() - startedAt)
        })
      }
    };
    attachMediaArticleLinkFreshnessSignals_(geoSignalsV1, null, { siteMode, url });
    try {
      console.log('[PW][GEO_SIGNALS_V1]', JSON.stringify({
        h1Count: geoSignalsV1.observed.h1.count,
        h1Source: geoSignalsV1.headings && geoSignalsV1.headings.h1Source,
        headingObservationLimited: geoSignalsV1.headings && geoSignalsV1.headings.headingObservationLimited,
        hasMainLandmark: geoSignalsV1.landmarks && geoSignalsV1.landmarks.hasMainLandmark,
        mainLandmarkSource: geoSignalsV1.landmarks && geoSignalsV1.landmarks.mainLandmarkSource,
        mainLandmarkObservationLimited: geoSignalsV1.landmarks && geoSignalsV1.landmarks.mainLandmarkObservationLimited,
        jsonldCount: geoSignalsV1.observed.structuredData.rawCount,
        jsonldParseableCount: geoSignalsV1.observed.structuredData.parseableCount,
        jsonldParseErrorsCount: geoSignalsV1.observed.structuredData.parseErrorsCount,
        jsonldTypes: geoSignalsV1.observed.structuredData.types,
        seoJsonldTypes: geoSignalsV1.observed.structuredData.seoTypes,
        nonSeoJsonldTypes: geoSignalsV1.observed.structuredData.nonSeoTypes,
        telemetryJsonldTypes: geoSignalsV1.observed.structuredData.telemetryTypes,
        hasJsonLd: geoSignalsV1.observed.structuredData.hasJsonLd,
        hasSeoJsonLd: geoSignalsV1.observed.structuredData.hasSeoJsonLd,
        hasWebsite: geoSignalsV1.observed.structuredData.hasWebsite,
        hasOrganization: geoSignalsV1.observed.structuredData.hasOrganization,
        hasBreadcrumbList: geoSignalsV1.observed.structuredData.hasBreadcrumbList,
        hasFAQPage: geoSignalsV1.observed.structuredData.hasFAQPage,
        observationScope: geoSignalsV1.observed.structuredData.observationScope,
        htmlContentLdJsonObserved: geoSignalsV1.observed.structuredData.htmlContentLdJsonObserved,
        scriptSrcJsonLdObserved: geoSignalsV1.observed.structuredData.scriptSrcJsonLdObserved,
        scriptSrcJsonLdCandidateCount: geoSignalsV1.observed.structuredData.scriptSrcJsonLdCandidateCount,
        scriptSrcJsonLdTypes: geoSignalsV1.observed.structuredData.scriptSrcJsonLdTypes,
        excludedFromSeoTypes: geoSignalsV1.observed.structuredData.excludedFromSeoTypes,
        hasOgImage: geoSignalsV1.multimodalSignals && geoSignalsV1.multimodalSignals.hasOgImage,
        hasFavicon: geoSignalsV1.multimodalSignals && geoSignalsV1.multimodalSignals.hasFavicon,
        hasContactLink: geoSignalsV1.trustSignals && geoSignalsV1.trustSignals.hasContactLink,
        contactPathFound: geoSignalsV1.trustSignals && geoSignalsV1.trustSignals.contactPathFound,
        totalAnchors: geoSignalsV1.observed.links.internalLinksSample.length,
        navLinkTextsCount: geoSignalsV1.observed.links.navTextsSample.length,
        bodyTextCandidatesCount: 0,
        renderedTextLength: geoSignalsV1.observed.body.textLength
      }));
    } catch (_) {}
    logHeavySiteBuildGeoAudit('build_end', {
      totalMs: geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.phaseTimings && geoSignalsV1.diagnostics.phaseTimings.totalMs,
      basicDomMs: phaseTimings.basicDomMs,
      structuredDataMs: phaseTimings.structuredDataMs,
      linksMs: phaseTimings.linksMs,
      multimodalMs: phaseTimings.multimodalMs,
      hasGeoSignalsV1: true
    });
    return geoSignalsV1;
  } catch (e) {
    logHeavySiteBuildGeoAudit('build_error', {
      error: String(e && (e.message || e) || '').slice(0, 240)
    });
    return {
      version: 'geoSignalsV1',
      generatedAt,
      url: String(url || ''),
      observed: {},
      diagnostics: {
        evaluateCount: 1,
        jsBundleAnalysis: false,
        resourceChunkScan: false
      },
      error: String(e && (e.message || e) || '')
    };
  }
}

async function collectBalancedHydrationMetrics(page, waitMs, opts = {}) {
  const maxWaitMs = Math.max(0, Math.min(5000, Number(waitMs || 0)));
  const shortFastMode = !!(opts && opts.shortFastMode);
  const debugHeavySite = opts && opts.debugHeavySite === true;
  const debugStartedAt = Number(opts && opts.debugHeavySiteStartedAt || Date.now()) || Date.now();
  const debugUrl = String(opts && opts.url || '');
  const debugFinalUrl = String(opts && opts.finalUrl || '');
  const logHydrationAudit = (phase, details = {}) => {
    if (!debugHeavySite) return;
    try {
      console.log('[DEBUG][HEAVY_SITE_TOPPAGE_AUDIT]', JSON.stringify({
        phase,
        url: debugUrl,
        finalUrl: debugFinalUrl,
        elapsedMs: Math.max(0, Date.now() - debugStartedAt),
        memory: typeof process !== 'undefined' && process.memoryUsage ? process.memoryUsage() : null,
        details
      }));
    } catch (_) {}
  };
  const empty = {
    waitMs: 0,
    bodyTextBeforeWait: 0,
    bodyTextAfterWait: 0,
    anchorCountBeforeWait: 0,
    anchorCountAfterWait: 0,
    navLinkCountBeforeWait: 0,
    navLinkCountAfterWait: 0,
    improvedBodyText: false,
    improvedLinks: false,
    warningTextBeforeWait: false,
    warningTextAfterWait: false,
    error: null
  };
  const measure = async () => {
    const measureStartedAt = Date.now();
    logHydrationAudit('hydration_body_count_start', { shortFastMode });
    return page.evaluate(({ shortFastMode }) => {
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const shadowTextParts = [];
      const shadowAnchors = [];
      let shadowJsonLdCount = 0;
      let shadowH1Count = 0;
      let shadowHostCount = 0;
      if (!shortFastMode) {
        try {
          const walkShadow = (root, depth = 0) => {
            if (!root || depth > 4) return;
            const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
            nodes.forEach((el) => {
              if (!el) return;
              if (shadowTextParts.length < 80) {
                const text = clean(el.innerText || el.textContent);
                if (text && text.length >= 2) shadowTextParts.push(text.slice(0, 500));
              }
              if (String(el.tagName || '').toLowerCase() === 'a' && el.getAttribute && el.getAttribute('href')) {
                shadowAnchors.push(el);
              }
              if (String(el.tagName || '').toLowerCase() === 'h1') shadowH1Count += 1;
              if (String(el.tagName || '').toLowerCase() === 'script' && /ld\+json/i.test(String(el.getAttribute && el.getAttribute('type') || ''))) {
                shadowJsonLdCount += 1;
              }
              if (el.shadowRoot) {
                shadowHostCount += 1;
                walkShadow(el.shadowRoot, depth + 1);
              }
            });
          };
          walkShadow(document, 0);
        } catch (_) {}
      }
      const domBodyText = clean(document.body && (document.body.innerText || document.body.textContent));
      const bodyText = clean([domBodyText].concat(shadowTextParts).join(' '));
      const anchors = Array.from(document.querySelectorAll('a[href]')).concat(shadowAnchors);
      const navAnchors = anchors.filter((a) => !!a.closest('nav,[role="navigation"],header,footer'));
      return {
        bodyTextLength: bodyText.length,
        anchorCount: anchors.length,
        navLinkCount: navAnchors.length,
        shadowJsonLdCount,
        shadowH1Count,
        shadowHostCount,
        warningText: /JavaScriptを有効にしてください|window\.fetch|ブラウザではご利用いただけません/i.test(bodyText)
      };
    }, { shortFastMode }).then((result) => {
      logHydrationAudit('hydration_body_count_end', {
        durationMs: Math.max(0, Date.now() - measureStartedAt),
        bodyTextLength: result && result.bodyTextLength,
        anchorCount: result && result.anchorCount,
        navLinkCount: result && result.navLinkCount,
        shadowHostCount: result && result.shadowHostCount,
        shadowJsonLdCount: result && result.shadowJsonLdCount,
        shadowH1Count: result && result.shadowH1Count
      });
      logHydrationAudit('hydration_anchor_count_end', {
        durationMs: Math.max(0, Date.now() - measureStartedAt),
        anchorCount: result && result.anchorCount,
        navLinkCount: result && result.navLinkCount
      });
      return result;
    }).catch((e) => {
      logHydrationAudit('hydration_body_count_end', {
        durationMs: Math.max(0, Date.now() - measureStartedAt),
        error: String(e && (e.message || e) || '').slice(0, 160)
      });
      return {
      bodyTextLength: 0,
      anchorCount: 0,
      navLinkCount: 0,
      warningText: false
    };
    });
  };
  try {
      const before = await measure();
      const sparseBefore = !!(
      before.warningText ||
      before.bodyTextLength < 800 ||
      before.anchorCount === 0 ||
      before.navLinkCount === 0 ||
      (before.shadowHostCount > 0 && before.shadowJsonLdCount === 0 && before.shadowH1Count === 0)
    );
    if (maxWaitMs > 0 && sparseBefore) {
      const startedAt = Date.now();
      try {
        logHydrationAudit('hydration_wait_start', {
          maxWaitMs,
          sparseBefore,
          bodyTextBeforeWait: before.bodyTextLength,
          anchorCountBeforeWait: before.anchorCount,
          navLinkCountBeforeWait: before.navLinkCount
        });
        await page.waitForFunction(({ shortFastMode }) => {
          const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
            const shadowTextParts = [];
            let shadowAnchorCount = 0;
            let shadowJsonLdCount = 0;
            let shadowH1Count = 0;
            let shadowHostCount = 0;
            if (!shortFastMode) {
              try {
                const walkShadow = (root, depth = 0) => {
                  if (!root || depth > 4) return;
                  const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
                  nodes.forEach((el) => {
                    if (!el) return;
                    if (shadowTextParts.length < 80) {
                      const text = clean(el.innerText || el.textContent);
                      if (text && text.length >= 2) shadowTextParts.push(text.slice(0, 500));
                    }
                    if (String(el.tagName || '').toLowerCase() === 'a' && el.getAttribute && el.getAttribute('href')) shadowAnchorCount += 1;
                    if (String(el.tagName || '').toLowerCase() === 'h1') shadowH1Count += 1;
                    if (String(el.tagName || '').toLowerCase() === 'script' && /ld\+json/i.test(String(el.getAttribute && el.getAttribute('type') || ''))) {
                      shadowJsonLdCount += 1;
                    }
                    if (el.shadowRoot) {
                      shadowHostCount += 1;
                      walkShadow(el.shadowRoot, depth + 1);
                    }
                  });
                };
                walkShadow(document, 0);
              } catch (_) {}
            }
          const bodyText = clean([clean(document.body && (document.body.innerText || document.body.textContent))].concat(shadowTextParts).join(' '));
          const anchors = document.querySelectorAll('a[href]').length + shadowAnchorCount;
          const navAnchors = document.querySelectorAll('nav a[href],[role="navigation"] a[href],header a[href],footer a[href]').length;
          const warningText = /JavaScriptを有効にしてください|window\.fetch|ブラウザではご利用いただけません/i.test(bodyText);
          const shadowStructuredReady = shortFastMode || shadowHostCount === 0 || shadowJsonLdCount > 0 || shadowH1Count > 0;
          return !warningText && shadowStructuredReady && (bodyText.length >= 800 || anchors >= 5 || navAnchors >= 2);
        }, { shortFastMode }, { timeout: maxWaitMs, polling: 250 });
      } catch (_) {
        try { await page.waitForTimeout(Math.min(750, maxWaitMs)); } catch (_) {}
      }
      logHydrationAudit('hydration_wait_end', {
        waitMs: Math.min(maxWaitMs, Date.now() - startedAt)
      });
      logHydrationAudit('hydration_recount_start', {
        bodyTextBeforeWait: before.bodyTextLength,
        anchorCountBeforeWait: before.anchorCount,
        navLinkCountBeforeWait: before.navLinkCount
      });
      const after = await measure();
      logHydrationAudit('hydration_recount_end', {
        bodyTextAfterWait: after.bodyTextLength,
        anchorCountAfterWait: after.anchorCount,
        navLinkCountAfterWait: after.navLinkCount
      });
      return {
        waitMs: Math.min(maxWaitMs, Date.now() - startedAt),
        bodyTextBeforeWait: before.bodyTextLength,
        bodyTextAfterWait: after.bodyTextLength,
        anchorCountBeforeWait: before.anchorCount,
        anchorCountAfterWait: after.anchorCount,
        navLinkCountBeforeWait: before.navLinkCount,
        navLinkCountAfterWait: after.navLinkCount,
        shadowHostCountBeforeWait: before.shadowHostCount,
        shadowHostCountAfterWait: after.shadowHostCount,
        shadowJsonLdCountBeforeWait: before.shadowJsonLdCount,
        shadowJsonLdCountAfterWait: after.shadowJsonLdCount,
        shadowH1CountBeforeWait: before.shadowH1Count,
        shadowH1CountAfterWait: after.shadowH1Count,
        improvedBodyText: after.bodyTextLength > before.bodyTextLength,
        improvedLinks: after.anchorCount > before.anchorCount || after.navLinkCount > before.navLinkCount,
        warningTextBeforeWait: !!before.warningText,
        warningTextAfterWait: !!after.warningText,
        error: null
      };
    }
    return Object.assign({}, empty, {
      bodyTextBeforeWait: before.bodyTextLength,
      bodyTextAfterWait: before.bodyTextLength,
      anchorCountBeforeWait: before.anchorCount,
      anchorCountAfterWait: before.anchorCount,
      navLinkCountBeforeWait: before.navLinkCount,
      navLinkCountAfterWait: before.navLinkCount,
      shadowHostCountBeforeWait: before.shadowHostCount,
      shadowHostCountAfterWait: before.shadowHostCount,
      shadowJsonLdCountBeforeWait: before.shadowJsonLdCount,
      shadowJsonLdCountAfterWait: before.shadowJsonLdCount,
      shadowH1CountBeforeWait: before.shadowH1Count,
      shadowH1CountAfterWait: before.shadowH1Count,
      warningTextBeforeWait: !!before.warningText,
      warningTextAfterWait: !!before.warningText
    });
  } catch (e) {
    return Object.assign({}, empty, {
      waitMs: maxWaitMs,
      error: String(e && (e.message || e) || '').slice(0, 180)
    });
  }
}

function analyzeHtmlBasics(html) {
  const $ = cheerio.load(html || '');
  const title = $('head > title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const lang = $('html').attr('lang') || '';

  // セマンティック要素
  const semanticTags = ['header','nav','main','article','section','aside','footer'];
  const semanticCount = semanticTags.reduce((a,t)=>a + $(t).length, 0);

  // 見出し
  const h1s = $('h1');
  const h2s = $('h2');
  const h3s = $('h3');
  const headings = $('h1,h2,h3,h4,h5,h6').get().map(e => Number(e.tagName.slice(1)));
  // レベル飛び検出（例: h2→h4 など）
  let levelJumps = 0;
  for (let i=1; i<headings.length; i++) {
    const prev = headings[i-1], cur = headings[i];
    if (cur > prev+1) levelJumps++;
  }

  // 画像の alt 率
  const imgs = $('img');
  const imgCount = imgs.length;
  const imgAltCount = imgs.filter((_,el)=>!!$(el).attr('alt')).length;
  const imgAltRatio = imgCount ? (imgAltCount / imgCount) : 1;

  // aタグのラベル性（hrefだけ、"詳しくはこちら"のみ等は弱い）
  const links = $('a').get();
  const meaningfulLinks = links.filter(a=>{
    const txt = ($(a).text() || '').trim();
    if (!txt) return false;
    const ng = ['こちら','click','詳しくはこちら','more','詳細','read more'];
    return !ng.includes(txt.toLowerCase());
  }).length;
  const linkRatio = links.length ? meaningfulLinks/links.length : 1;

  // Open Graph / Twitter Card
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const ogDesc  = $('meta[property="og:description"]').attr('content') || '';
  const twCard  = $('meta[name="twitter:card"]').attr('content') || '';

  // パンくず（構造 or 見た目）
  const hasBreadcrumbDom = $('.breadcrumb, nav[aria-label="breadcrumb"]').length > 0;

  return {
    title, metaDesc, lang, semanticCount,
    h1Count: h1s.length, h2Count: h2s.length, h3Count: h3s.length,
    levelJumps, imgCount, imgAltRatio, linkRatio,
    hasBreadcrumbDom, hasOg: !!(ogTitle||ogDesc), hasTwitterCard: !!twCard,
  };
}

function analyzeTextReadability(bodyText) {
  const text = safe(bodyText);
  // 句点で文を割る（日本語想定）
  const sentences = text.split(/。|\n/).map(s=>s.trim()).filter(Boolean);
  const charLen = (s)=>s.replace(/\s/g,'').length;

  const lens = sentences.map(charLen);
  const totalChars = lens.reduce((a,b)=>a+b,0);
  const avgLen = sentences.length ? totalChars / sentences.length : 0;

  // 長すぎる文の割合（80文字超）
  const longRatio = sentences.length ? (countIf(lens, L=>L>80) / sentences.length) : 0;

  // 箇条書きの有無（"- "や"・"の頻度）
  const bullets = (text.match(/(^|\n)\s*[-・＊*●◼︎]/g) || []).length;

  // 漢字だらけ判定を軽く（記号除去後のひらがなカタカナ比率）
  const onlyChars = text.replace(/[\s0-9!-~、。・…—―「」『』（）【】［］【】\u3000]/g,'');
  const hiraKata = (onlyChars.match(/[ぁ-んァ-ヶ]/g) || []).length;
  const ratioHiraKata = onlyChars.length ? (hiraKata / onlyChars.length) : 0;

  return { sentences: sentences.length, avgLen, longRatio, bullets, ratioHiraKata };
}

function analyzeCoverage(bodyText, html) {
  const hay = (safe(bodyText) + '\n' + safe(html)).toLowerCase();
  // 意思決定に効く情報がサイトに揃っているか（キーワード網羅）
  const keys = [
    'サービス','製品','特徴','強み','実績','事例','導入','料金','価格','費用',
    '比較','プラン','サポート','faq','よくある質問','お問い合わせ','連絡先',
    '会社概要','アクセス','採用','メンバー','チーム','ブログ','ニュース'
  ];
  const hits = countIf(keys, k => hay.indexOf(k.toLowerCase()) >= 0);
  // セクションの多様性（article/section/ul/table）
  const $ = cheerio.load(html||'');
  const diversity = ['article','section','ul','ol','table','dl','figure'].reduce((a,t)=>a + ($(t).length>0?1:0), 0);
  return { keysTotal: keys.length, keysHit: hits, diversity };
}

function analyzeTrust(bodyText, html, url) {
  const text = (safe(bodyText) + '\n' + safe(html)).toLowerCase();
  const trustKeys = [
    '会社概要','企業情報','特定商取引','プライバシーポリシー','個人情報保護','利用規約',
    '住所','所在地','電話','tel','お問い合わせ','責任者','監修','著者','発行日','更新日'
  ];
  const trustHits = countIf(trustKeys, k => text.indexOf(k.toLowerCase()) >= 0);

  // 住所・電話の露出（実体文字）
  const hasPhone = /tel[:：]?\s*\+?\d|\d{2,4}-\d{2,4}-\d{3,4}/i.test(text);
  const hasAddr  = /(東京都|北海道|京都府|大阪府|..県|..市|丁目|番地)/.test(text);

  // 組織系のJSON-LD
  // 呼び出し側で typesFromJsonLd を渡してもらう
  return { trustHits, hasPhone, hasAddr, isHttps: /^https:\/\//i.test(url||'') };
}


function extractTopPageStaticSignalsFromHtml_(url, finalUrl, status, html) {
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const out = {
    used: true,
    success: false,
    url: String(url || ''),
    finalUrl: String(finalUrl || url || ''),
    status: typeof status === 'number' ? status : null,
    title: '',
    metaDescription: '',
    h1: '',
    h1Count: 0,
    h1Texts: [],
    hasHeaderElement: false,
    hasNavElement: false,
    hasFooterElement: false,
    hasMainElement: false,
    hasSemanticStructure: false,
    jsonLdTypes: [],
    jsonLdCount: 0,
    articleSignals: null,
    navTextsSample: [],
    internalLinksSample: [],
    footerTextsSample: [],
    footerExternalLinksSample: [],
    bodyTextLength: 0,
    htmlLength: String(html || '').length,
    source: 'top_page_static_html_fetch'
  };
  if (!html) return out;
  try {
    const $ = cheerio.load(html || '');
    out.title = clean($('head > title').first().text()).slice(0, 180);
    out.metaDescription = clean(
      $('meta[name="description" i]').first().attr('content') ||
      $('meta[property="og:description" i]').first().attr('content') ||
      $('meta[name="twitter:description" i]').first().attr('content') ||
      ''
    ).slice(0, 500);
    out.h1Texts = $('h1').map((_, el) => clean($(el).text()).slice(0, 180)).get().filter(Boolean).slice(0, 10);
    out.h1 = out.h1Texts[0] || '';
    out.h1Count = $('h1').length;
    out.hasHeaderElement = $('header').length > 0;
    out.hasNavElement = $('nav').length > 0;
    out.hasFooterElement = $('footer').length > 0;
    out.hasMainElement = $('main,[role="main"]').length > 0;
    out.hasSemanticStructure = !!(out.hasHeaderElement || out.hasNavElement || out.hasFooterElement || out.hasMainElement || $('article,section,aside').length > 0);
    const jsonLdItems = typeof extractJsonLdFromHtml === 'function' ? extractJsonLdFromHtml(html) : [];
    const collectTypes = (node, acc, depth = 0) => {
      if (!node || depth > 8) return;
      if (Array.isArray(node)) return node.forEach(item => collectTypes(item, acc, depth + 1));
      if (typeof node !== 'object') return;
      const t = node['@type'];
      if (Array.isArray(t)) t.forEach(x => acc.push(clean(x)));
      else if (t) acc.push(clean(t));
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(item => collectTypes(item, acc, depth + 1));
    };
    const types = [];
    (Array.isArray(jsonLdItems) ? jsonLdItems : []).forEach(item => collectTypes(item, types, 0));
    out.jsonLdTypes = Array.from(new Set(types.filter(Boolean))).slice(0, 50);
    out.jsonLdCount = Array.isArray(jsonLdItems) ? jsonLdItems.length : 0;
    out.articleSignals = buildArticleSignalsFromJsonLdAndMeta_(jsonLdItems, extractArticleMetaFromCheerio_($), out.finalUrl || out.url);
    const toAbs = (href) => {
      try { return href ? new URL(String(href), out.finalUrl || out.url).toString() : ''; } catch (_) { return String(href || ''); }
    };
    out.navTextsSample = $('nav a[href],header a[href]').map((_, el) => clean($(el).text() || $(el).attr('aria-label') || $(el).attr('title')).slice(0, 100)).get().filter(Boolean).slice(0, 20);
    out.internalLinksSample = $('a[href]').map((_, el) => {
      const href = toAbs($(el).attr('href'));
      let same = true;
      try { same = new URL(href).origin === new URL(out.finalUrl || out.url).origin; } catch (_) {}
      if (!same) return null;
      return { text: clean($(el).text() || $(el).attr('aria-label') || $(el).attr('title')).slice(0, 80), href };
    }).get().filter(Boolean).slice(0, 20);
    out.footerTextsSample = $('footer a[href],footer').map((_, el) => clean($(el).text()).slice(0, 120)).get().filter(Boolean).slice(0, 20);
    out.footerExternalLinksSample = $('footer a[href]').map((_, el) => {
      const href = toAbs($(el).attr('href'));
      try {
        if (new URL(href).origin === new URL(out.finalUrl || out.url).origin) return '';
      } catch (_) { return ''; }
      return href;
    }).get().filter(Boolean).slice(0, 10);
    out.bodyTextLength = clean($('body').text()).length;
    out.success = !!(out.title || out.metaDescription || out.h1Count || out.hasSemanticStructure || out.jsonLdCount);
    return out;
  } catch (e) {
    out.error = String(e && (e.message || e) || 'static_html_parse_failed').slice(0, 180);
    return out;
  }
}

async function fetchTopPageStaticSignals_(url, opts = {}) {
  const startedAt = Date.now();
  const result = {
    used: true,
    success: false,
    elapsedMs: 0,
    usedAsFallback: false,
    url: String(url || ''),
    finalUrl: String(url || ''),
    status: null,
    error: '',
    signals: null
  };
  try {
    const initialUrl = new URL(String(url || ''));
    if (typeof isBlockedSubpageJsonLdHost === 'function' && isBlockedSubpageJsonLdHost(initialUrl.hostname)) {
      result.error = 'blocked_private_or_metadata_host';
      return result;
    }
    const timeoutMs = Math.max(1000, Math.min(15000, Number(opts && opts.timeoutMs || 8000) || 8000));
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, timeoutMs) : null;
    let response = null;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller ? controller.signal : undefined,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    result.status = response && typeof response.status === 'number' ? response.status : null;
    result.finalUrl = response && response.url ? response.url : String(url || '');
    const contentType = String(response && response.headers && response.headers.get && response.headers.get('content-type') || '');
    if (!response || !response.ok) {
      result.error = result.status ? `HTTP ${result.status}` : 'fetch_failed';
      return result;
    }
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
      result.error = `unsupported_content_type:${contentType.slice(0, 80)}`;
      return result;
    }
    const html = String(await response.text() || '').slice(0, 2 * 1024 * 1024);
    result.signals = extractTopPageStaticSignalsFromHtml_(url, result.finalUrl, result.status, html);
    result.success = !!(result.signals && result.signals.success);
    return result;
  } catch (e) {
    result.error = String(e && (e.message || e) || 'top_page_static_fetch_failed').slice(0, 180);
    return result;
  } finally {
    result.elapsedMs = Math.max(0, Date.now() - startedAt);
  }
}

function buildStaticFallbackGeoSignalsPayload_(url, staticFetchResult, opts = {}) {
  const signals = staticFetchResult && staticFetchResult.signals ? staticFetchResult.signals : {};
  const generatedAt = new Date().toISOString();
  const finalUrl = signals.finalUrl || staticFetchResult && staticFetchResult.finalUrl || url;
  const jsonLdTypes = Array.isArray(signals.jsonLdTypes) ? signals.jsonLdTypes.slice(0, 50) : [];
  const articleSignals = signals.articleSignals && typeof signals.articleSignals === 'object'
    ? signals.articleSignals
    : buildArticleSignalsFromJsonLdAndMeta_([], {}, finalUrl || url);
  const hasJsonLd = Number(signals.jsonLdCount || 0) > 0 || jsonLdTypes.length > 0;
  const headingTexts = Array.isArray(signals.h1Texts) ? signals.h1Texts.slice(0, 10) : [];
  const h1Count = Number(signals.h1Count || 0);
  const hasMain = signals.hasMainElement === true;
  const geoSignalsV1 = {
    version: 'geoSignalsV1',
    generatedAt,
    url: String(finalUrl || url || ''),
    structuredData: {
      types: jsonLdTypes,
      seoTypes: jsonLdTypes,
      nonSeoTypes: [],
      telemetryTypes: [],
      excludedFromSeoTypes: [],
      rawCount: Number(signals.jsonLdCount || jsonLdTypes.length || 0),
      parseableCount: Number(signals.jsonLdCount || jsonLdTypes.length || 0),
      hasJsonLd,
      hasSeoJsonLd: hasJsonLd,
      hasWebsite: jsonLdTypes.some(t => /^website$/i.test(t)),
      hasOrganization: jsonLdTypes.some(t => /^(organization|corporation|localbusiness)$/i.test(t)),
      hasBreadcrumbList: jsonLdTypes.some(t => /^breadcrumblist$/i.test(t)),
      hasFAQPage: jsonLdTypes.some(t => /^faqpage$/i.test(t)),
      source: 'top_page_static_html_fetch',
      confidence: hasJsonLd ? 'medium' : 'low',
      observationLimited: true,
      observationScope: 'static_html_only'
    },
    articleSignals,
    headings: {
      h1Count,
      h2Count: 0,
      h3Count: 0,
      hasH1: h1Count > 0,
      hasSingleH1: h1Count === 1,
      h1Texts: headingTexts,
      headingTexts,
      primaryHeadingCandidate: headingTexts[0] || signals.title || '',
      primaryHeadingCandidateSource: headingTexts[0] ? 'static_html_h1' : (signals.title ? 'static_html_title' : 'not_observed'),
      primaryHeadingConfidence: headingTexts[0] ? 'high' : (signals.title ? 'low' : 'low'),
      h1EquivalentCandidateFound: h1Count > 0,
      sectionHeadingCandidate: '',
      sectionHeadingCandidateSource: 'not_observed',
      sectionHeadingConfidence: 'low',
      source: 'top_page_static_html_fetch',
      h1Source: h1Count > 0 ? 'static_html_h1' : 'not_observed',
      headingObservationLimited: h1Count === 0,
      excludedHeadingCount: 0,
      excludedHeadingReasons: [],
      a11yObserved: false
    },
    landmarks: {
      hasMainLandmark: hasMain,
      hasMainLandmark_final: hasMain,
      mainLandmarkSource: hasMain ? 'static_html_main' : 'not_observed',
      mainLandmarkConfidence: hasMain ? 'high' : 'low',
      mainLandmarkTextsSample: [],
      mainLandmarkCandidateFound: hasMain,
      mainLandmarkCandidateSource: hasMain ? 'static_html_main' : 'not_observed',
      mainLandmarkCandidateConfidence: hasMain ? 'high' : 'low',
      mainLandmarkCandidateTextsSample: [],
      mainLandmarkObservationLimited: false,
      a11yObserved: false,
      a11yMainCount: 0
    },
    coverage: {
      semanticElements: {
        hasHeaderElement: signals.hasHeaderElement === true,
        hasNavElement: signals.hasNavElement === true,
        hasFooterElement: signals.hasFooterElement === true,
        hasMainElement: hasMain,
        hasSemanticStructure: signals.hasSemanticStructure === true,
        source: 'top_page_static_html_fetch'
      },
      footerSignals: {
        observed: signals.hasFooterElement === true,
        linkCount: Array.isArray(signals.footerTextsSample) ? signals.footerTextsSample.length : 0,
        sampleTexts: Array.isArray(signals.footerTextsSample) ? signals.footerTextsSample.slice(0, 10) : [],
        footerExternalLinksSample: Array.isArray(signals.footerExternalLinksSample) ? signals.footerExternalLinksSample.slice(0, 10) : [],
        source: 'top_page_static_html_fetch'
      },
      source: 'top_page_static_html_fetch'
    },
    observed: {
      title: {
        value: signals.title || null,
        observed: !!signals.title,
        source: signals.title ? 'top_page_static_html_fetch' : 'not_observed',
        confidence: signals.title ? 'high' : 'low'
      },
      metaDescription: {
        value: signals.metaDescription || null,
        observed: !!signals.metaDescription,
        source: signals.metaDescription ? 'top_page_static_html_fetch' : 'not_observed',
        confidence: signals.metaDescription ? 'high' : 'low',
        length: signals.metaDescription ? String(signals.metaDescription).length : 0
      },
      h1: {
        values: headingTexts,
        count: h1Count,
        observed: h1Count > 0,
        source: h1Count > 0 ? 'top_page_static_html_fetch' : 'not_observed',
        confidence: h1Count > 0 ? 'high' : 'low',
        hasH1: h1Count > 0,
        hasSingleH1: h1Count === 1,
        headingObservationLimited: h1Count === 0
      },
      headings: null,
      links: {
        navTextsSample: Array.isArray(signals.navTextsSample) ? signals.navTextsSample.slice(0, 20) : [],
        internalLinksSample: Array.isArray(signals.internalLinksSample) ? signals.internalLinksSample.slice(0, 20) : [],
        source: 'top_page_static_html_fetch',
        confidence: 'medium',
        observed: true
      },
      structuredData: null,
      articleSignals: null,
      coverage: null,
      landmarks: null,
      body: {
        textLength: Number(signals.bodyTextLength || 0),
        sample: null,
        observed: Number(signals.bodyTextLength || 0) > 0,
        source: 'top_page_static_html_fetch',
        confidence: 'low'
      }
    },
    diagnostics: {
      evaluateCount: 0,
      staticFallbackOnly: true,
      playwrightTimedOut: opts && opts.playwrightTimedOut === true,
      playwrightFailed: opts && opts.playwrightFailed === true,
      topPageStaticFetch: {
        used: true,
        success: staticFetchResult && staticFetchResult.success === true,
        elapsedMs: Number(staticFetchResult && staticFetchResult.elapsedMs || 0),
        usedAsFallback: true,
        error: staticFetchResult && staticFetchResult.error || ''
      }
    }
  };
  geoSignalsV1.observed.headings = Object.assign({}, geoSignalsV1.headings, { h1: headingTexts, h2: [], h3: [] });
  geoSignalsV1.observed.landmarks = geoSignalsV1.landmarks;
  geoSignalsV1.observed.coverage = geoSignalsV1.coverage;
  geoSignalsV1.observed.structuredData = geoSignalsV1.structuredData;
  geoSignalsV1.observed.articleSignals = articleSignals;
  const lightweightSummary = {
    title: signals.title || null,
    metaDescription: signals.metaDescription || null,
    metaDescriptionLen: signals.metaDescription ? String(signals.metaDescription).length : null,
    h1Count,
    h2Count: 0,
    h1Source: h1Count > 0 ? 'static_html_h1' : 'not_observed',
    headingSource: 'top_page_static_html_fetch',
    primaryHeadingCandidate: headingTexts[0] || signals.title || null,
    primaryHeadingCandidateSource: headingTexts[0] ? 'static_html_h1' : (signals.title ? 'static_html_title' : 'not_observed'),
    primaryHeadingConfidence: headingTexts[0] ? 'high' : (signals.title ? 'low' : 'low'),
    h1EquivalentCandidateFound: h1Count > 0,
    headingObservationLimited: h1Count === 0,
    hasMainLandmark: hasMain,
    hasMainLandmarkFinal: hasMain,
    mainLandmarkSource: hasMain ? 'static_html_main' : 'not_observed',
    mainLandmarkCandidateFound: hasMain,
    mainLandmarkCandidateSource: hasMain ? 'static_html_main' : 'not_observed',
    mainLandmarkObservationLimited: false,
    navLinkCount: Array.isArray(signals.navTextsSample) ? signals.navTextsSample.length : 0,
    internalLinkCount: Array.isArray(signals.internalLinksSample) ? signals.internalLinksSample.length : 0,
    hasHeaderElement: signals.hasHeaderElement === true,
    hasNavElement: signals.hasNavElement === true,
    hasFooterElement: signals.hasFooterElement === true,
    hasMainElement: hasMain,
    hasSemanticStructure: signals.hasSemanticStructure === true,
    bodyTextLength: Number(signals.bodyTextLength || 0),
    jsonldCount: Number(signals.jsonLdCount || jsonLdTypes.length || 0),
    jsonldTypes: jsonLdTypes,
    articleSignals,
    qualityStatus: staticFetchResult && staticFetchResult.success ? 'limited' : 'failed',
    coreSignalsReady: staticFetchResult && staticFetchResult.success === true,
    topPageStaticFetch: geoSignalsV1.diagnostics.topPageStaticFetch
  };
  return { geoSignalsV1, lightweightSummary };
}

function mergeTopPageStaticSignalsIntoPayload_(geoSignalsV1, lightweightSummary, staticFetchResult) {
  if (!staticFetchResult || !staticFetchResult.success || !staticFetchResult.signals) return;
  const fallback = buildStaticFallbackGeoSignalsPayload_(staticFetchResult.finalUrl || staticFetchResult.url, staticFetchResult, {});
  const fg = fallback.geoSignalsV1;
  const fl = fallback.lightweightSummary;
  geoSignalsV1.observed = geoSignalsV1.observed || {};
  geoSignalsV1.headings = geoSignalsV1.headings || {};
  geoSignalsV1.landmarks = geoSignalsV1.landmarks || {};
  geoSignalsV1.coverage = geoSignalsV1.coverage || {};
  geoSignalsV1.coverage.semanticElements = geoSignalsV1.coverage.semanticElements || {};
  const observed = geoSignalsV1.observed;
  if (!(observed.title && observed.title.value) && fg.observed.title) observed.title = fg.observed.title;
  if (!(observed.metaDescription && observed.metaDescription.value) && fg.observed.metaDescription) observed.metaDescription = fg.observed.metaDescription;
  if (!(observed.h1 && Number(observed.h1.count || 0) > 0) && fg.observed.h1) observed.h1 = fg.observed.h1;
  if (!(geoSignalsV1.articleSignals && geoSignalsV1.articleSignals.checked === true) && fg.articleSignals) geoSignalsV1.articleSignals = fg.articleSignals;
  if (!Number(geoSignalsV1.headings.h1Count || 0) && fg.headings) Object.assign(geoSignalsV1.headings, fg.headings);
  if (!Object.prototype.hasOwnProperty.call(geoSignalsV1.landmarks, 'hasMainLandmark') || geoSignalsV1.landmarks.hasMainLandmark == null) Object.assign(geoSignalsV1.landmarks, fg.landmarks);
  ['hasHeaderElement', 'hasNavElement', 'hasFooterElement', 'hasMainElement', 'hasSemanticStructure'].forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(geoSignalsV1.coverage.semanticElements, key) || geoSignalsV1.coverage.semanticElements[key] == null) {
      geoSignalsV1.coverage.semanticElements[key] = fg.coverage.semanticElements[key];
    }
  });
  geoSignalsV1.observed.headings = geoSignalsV1.observed.headings || geoSignalsV1.headings;
  geoSignalsV1.observed.landmarks = geoSignalsV1.observed.landmarks || geoSignalsV1.landmarks;
  geoSignalsV1.observed.coverage = geoSignalsV1.observed.coverage || geoSignalsV1.coverage;
  geoSignalsV1.observed.articleSignals = geoSignalsV1.observed.articleSignals || geoSignalsV1.articleSignals || fg.articleSignals;
  geoSignalsV1.diagnostics = geoSignalsV1.diagnostics || {};
  geoSignalsV1.diagnostics.topPageStaticFetch = {
    used: true,
    success: true,
    elapsedMs: Number(staticFetchResult.elapsedMs || 0),
    usedAsFallback: false,
    error: staticFetchResult.error || ''
  };
  if (lightweightSummary && typeof lightweightSummary === 'object') {
    const fill = (key, value) => {
      if ((lightweightSummary[key] == null || lightweightSummary[key] === '' || lightweightSummary[key] === 0) && value != null && value !== '') lightweightSummary[key] = value;
    };
    fill('title', fl.title);
    fill('metaDescription', fl.metaDescription);
    fill('metaDescriptionLen', fl.metaDescriptionLen);
    fill('h1Count', fl.h1Count);
    fill('h1Source', fl.h1Source);
    fill('headingSource', fl.headingSource);
    fill('primaryHeadingCandidate', fl.primaryHeadingCandidate);
    fill('primaryHeadingCandidateSource', fl.primaryHeadingCandidateSource);
    fill('hasMainLandmark', fl.hasMainLandmark);
    fill('hasMainLandmarkFinal', fl.hasMainLandmarkFinal);
    fill('mainLandmarkSource', fl.mainLandmarkSource);
    fill('hasHeaderElement', fl.hasHeaderElement);
    fill('hasNavElement', fl.hasNavElement);
    fill('hasFooterElement', fl.hasFooterElement);
    fill('hasMainElement', fl.hasMainElement);
    fill('hasSemanticStructure', fl.hasSemanticStructure);
    fill('jsonldCount', fl.jsonldCount);
    if (!(lightweightSummary.articleSignals && lightweightSummary.articleSignals.checked === true) && fl.articleSignals) lightweightSummary.articleSignals = fl.articleSignals;
    if (!Array.isArray(lightweightSummary.jsonldTypes) || !lightweightSummary.jsonldTypes.length) lightweightSummary.jsonldTypes = fl.jsonldTypes;
    lightweightSummary.topPageStaticFetch = geoSignalsV1.diagnostics.topPageStaticFetch;
  }
}

// ---- 各スコア（0-100） ----
function scoreDataStructure(htmlBasics, types) {
  // 要素: title, meta desc, セマンティック要素数, 画像alt率, 意味のあるリンク率, OG/TwitterCard, パンくず, JSON-LDの量
  const hasTitle = htmlBasics.title.length > 0;
  const hasDesc  = htmlBasics.metaDesc.length > 30;
  const semScore = clamp01(htmlBasics.semanticCount / 4);   // 4種以上で頭打ち
  const altScore = htmlBasics.imgAltRatio;                  // 0-1
  const linkScore= htmlBasics.linkRatio;                    // 0-1
  const ogScore  = htmlBasics.hasOg ? 1 : 0;
  const twScore  = htmlBasics.hasTwitterCard ? 1 : 0;
  const bcScore  = htmlBasics.hasBreadcrumbDom ? 1 : 0;
  const jsonldScore = clamp01(types.length / 4);            // 4タイプ（WebSite/WebPage/Org/Breadcrumb/FAQ等）で満点

  const w = {title:.10, desc:.10, sem:.15, alt:.10, link:.10, og:.05, tw:.05, bc:.05, jsonld:.30};
  const v = (hasTitle?w.title:0) + (hasDesc?w.desc:0) + semScore*w.sem + altScore*w.alt +
            linkScore*w.link + ogScore*w.og + twScore*w.tw + bcScore*w.bc + jsonldScore*w.jsonld;
  return toScore(v);
}

function scoreDocumentStructure(htmlBasics, html) {
  const $ = cheerio.load(html||'');
  const headings = $('h1,h2,h3,h4,h5,h6').get().map(e => Number(e.tagName.slice(1)));
  const hasH1 = htmlBasics.h1Count === 1;            // h1は1つが理想
  const hasH2 = htmlBasics.h2Count > 0;
  const notJump = htmlBasics.levelJumps === 0;
  const paraCount = $('p').length;
  const listCount = $('ul,ol').length;
  const tableCount = $('table').length;

  const w = {h1:.25, h2:.15, notJump:.20, para:.20, list:.10, table:.10};
  const paraScore = clamp01(paraCount / 10);     // 段落10以上で頭打ち
  const listScore = clamp01(listCount / 3);      // 3つ以上で頭打ち
  const tableScore= clamp01(tableCount / 1);     // 1つでOK

  const v = (hasH1?w.h1:0) + (hasH2?w.h2:0) + (notJump?w.notJump:0) +
            paraScore*w.para + listScore*w.list + tableScore*w.table;
  return toScore(v);
}

function scoreClarity(textStats) {
  // 平均文長が短く、長文比が低く、箇条書きある、ひらカナ比率がそれなりにある → 高得点
  const sLen = 1 - clamp01((textStats.avgLen - 40) / (120 - 40)); // 40〜120 で線形
  const sLong= 1 - clamp01(textStats.longRatio);                   // 長文比が低いほど良い
  const sBul = clamp01(textStats.bullets / 5);                     // 箇条書き（最大5で頭打ち）
  const sKana= clamp01(textStats.ratioHiraKata / 0.5);             // かな比 0.5 で満点（難語だらけ抑制）

  const w = {len:.35,long:.25,bul:.20,kana:.20};
  const v = clamp01(sLen)*w.len + clamp01(sLong)*w.long + sBul*w.bul + sKana*w.kana;
  return toScore(v);
}

function scoreCoverage(cov) {
  const k = clamp01(cov.keysHit / Math.max(6, cov.keysTotal)); // 主要6個以上で頭打ち
  const d = clamp01(cov.diversity / 5);                         // 5要素で満点
  const v = k*0.7 + d*0.3;
  return toScore(v);
}

function scoreTrust(tr, types) {
  const hasOrg = types.includes('Organization') || types.includes('LocalBusiness') || types.includes('Corporation');
  const hasContact = types.includes('ContactPoint');
  const hasBreadcrumb = types.includes('BreadcrumbList');
  const base = clamp01(tr.trustHits / 6);     // 信頼系の露出 6項目で満点
  const bonus = (tr.hasPhone?0.1:0) + (tr.hasAddr?0.1:0) + (tr.isHttps?0.1:0) +
                (hasOrg?0.1:0) + (hasContact?0.05:0) + (hasBreadcrumb?0.05:0);
  return toScore(clamp01(base + bonus));
}

function rankFromAvg(avg){
  const n = Number(avg)||0;
  if (n >= 85) return 'A';
  if (n >= 70) return 'B';
  if (n >= 55) return 'C';
  if (n >= 40) return 'D';
  return 'E';
}

function buildDescriptions({data,doc,clar,cov,tr}) {
  return {
    'データ構造': `title/description/セマンティック要素:${data.semanticCount}，画像alt率:${Math.round(data.imgAltRatio*100)}%，リンク可読率:${Math.round(data.linkRatio*100)}%。JSON-LDタイプ:${data.types.join(', ') || 'なし'}`,
    '文書構造': `h1:${doc.h1Count}，h2:${doc.h2Count}，見出しのレベル飛び:${doc.levelJumps}。段落・箇条書き・表の整備状況を評価。`,
    '表現の明確さ': `平均文長:${Math.round(clar.avgLen)}字，長文比:${Math.round(clar.longRatio*100)}%，箇条書き:${clar.bullets}，かな比:${Math.round(clar.ratioHiraKata*100)}%。`,
    '情報網羅性': `意思決定キーワード命中:${cov.keysHit}/${cov.keysTotal}，コンテンツ多様性:${cov.diversity}。`,
    '信頼性': `信頼キーワード命中:${tr.trustHits}，電話:${tr.hasPhone?'◯':'×'}，住所:${tr.hasAddr?'◯':'×'}，HTTPS:${tr.isHttps?'◯':'×'}. JSON-LD(Org/Contact/Breadcrumb):${data.flags.org? '◯':'×'}/${data.flags.contact? '◯':'×'}/${data.flags.bc? '◯':'×'}`,
  };
}

// scraped: { url, html, bodyText, jsonld, structured, jsonldSynth }
function buildScoresFromScrape(scraped) {
  const url = scraped.url || '';
  const html = (scraped.scoring && scraped.scoring.html)     || scraped.html  || '';
  const body = (scraped.scoring && scraped.scoring.bodyText) || scraped.bodyText || '';

  // JSON-LD（現状=Before）
  const jsonldArr = parseJsonLdList(scraped.jsonld);
  const types = flatTypesFromJsonLd(jsonldArr);

  const htmlBasics = analyzeHtmlBasics(html);
  const textStats  = analyzeTextReadability(body);
  const cov        = analyzeCoverage(body, html);
  const tr         = analyzeTrust(body, html, url);

  const sData = scoreDataStructure({...htmlBasics, types, flags:{
    org: types.includes('Organization') || types.includes('LocalBusiness') || types.includes('Corporation'),
    contact: types.includes('ContactPoint'),
    bc: types.includes('BreadcrumbList')
  }}, types);
  const sDoc  = scoreDocumentStructure(htmlBasics, html);
  const sClr  = scoreClarity(textStats);
  const sCov  = scoreCoverage(cov);
  const sTr   = scoreTrust(tr, types);

  const beforeScores = [sData, sDoc, sClr, sCov, sTr];
  const avgBefore = Math.round(beforeScores.reduce((a,b)=>a+b,0)/beforeScores.length);

  // ==== After（JSON-LD強化があれば “その分だけ” 反映）====
  // scraped.jsonldSynth に FAQPage / BreadcrumbList / Organization 等が含まれていれば、
  // データ構造＋（該当時のみ）網羅性を実増。文書構造/明確さ/信頼性は基本据え置き。
  let afterScores = beforeScores.slice(0);
  const synthArr = parseJsonLdList(scraped.jsonldSynth || scraped.structured);
  if (synthArr.length) {
    const t2 = flatTypesFromJsonLd(synthArr);

    // データ構造の再計算（types を置換）
    const sDataAfter = scoreDataStructure({...htmlBasics, types:t2, flags:{
      org: t2.includes('Organization') || t2.includes('LocalBusiness') || t2.includes('Corporation'),
      contact: t2.includes('ContactPoint'),
      bc: t2.includes('BreadcrumbList')
    }}, t2);

    // FAQPageやItemListが入った場合のみ “情報網羅性” を小幅に見直す
    const hasFaq = t2.includes('FAQPage');
    const hasItemList = t2.includes('ItemList');
    const sCovAfter = hasFaq || hasItemList ? Math.max(sCov, Math.min(100, sCov + 10)) : sCov;

    afterScores = [sDataAfter, sDoc, sClr, sCovAfter, sTr];
  }

  const avgAfter = Math.round(afterScores.reduce((a,b)=>a+b,0)/afterScores.length);

  return {
    url,
    beforeScores,
    afterScores,
    avgBeforeScore: avgBefore,
    avgAfterScore:  avgAfter,
    beforeRank: rankFromAvg(avgBefore),
    afterRank:  rankFromAvg(avgAfter),
    descriptions: buildDescriptions({
      data:{...htmlBasics, types, flags:{
        org: types.includes('Organization') || types.includes('LocalBusiness') || types.includes('Corporation'),
        contact: types.includes('ContactPoint'),
        bc: types.includes('BreadcrumbList')
      }},
      doc: htmlBasics, clar: textStats, cov, tr
    }),
    meta: {
      scoringVersion: '1.0.0 (/scrape integrated)',
      generatedAt: new Date().toISOString(),
    }
  };
}
// ================== end Scoring core ==================

// -------------------- /scrape --------------------
// 同時実行を抑制して OOM を予防（環境変数 SCRAPE_CONCURRENCY で調整可能）
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY || 2);
const queue = new PQueue({ concurrency: CONCURRENCY });

console.log('[BOOT][MEMO]', JSON.stringify({
  initialized: [
    'express-app',
    'weights-config',
    'helper-functions',
    'pqueue-instance',
    'empty-scrape-cache'
  ],
  browserAtBoot: false,
  contextAtBoot: false,
  pageAtBoot: false,
  queueConcurrency: CONCURRENCY,
  cacheMaxEntries: CACHE_MAX_ENTRIES,
  cacheTtlMs: CACHE_TTL_MS,
  rss: process.memoryUsage().rss
}));

app.get('/scrape', async (req, res) => {
  console.log('[TEST][SCRAPE_ENTRY] entered /scrape');
  logSf('SCRAPE_ENTER', {
    url: req && req.query ? String(req.query.url || '').slice(0, 180) : '',
    nocache: req && req.query ? req.query.nocache || null : null
  });
  logSfMemory('scrape_enter_route');
  // キューに積んだ Promise を必ず返す（Express が先に切られないように）
  return queue.add(() => scrapeOnce(req, res)).catch(err => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'queue_error', message: String(err) });
    }
  });
});

function buildBalancedShortResponsePayload(fullPayload) {
  const trimmedFields = [];
  const str = (value, max, path) => {
    const text = value == null ? '' : String(value);
    if (text.length > max) {
      if (path) trimmedFields.push(path);
      return text.slice(0, max);
    }
    return text;
  };
  const arr = (value, max, path, mapper) => {
    const list = Array.isArray(value) ? value : [];
    if (list.length > max && path) trimmedFields.push(path);
    return list.slice(0, max).map(mapper || ((item) => item));
  };
  const linkSample = (item) => {
    if (!item || typeof item !== 'object') return str(item, 160);
    return {
      text: str(item.text || item.label || '', 80),
      href: str(item.href || item.url || '', 180)
    };
  };
  const g = fullPayload && fullPayload.geoSignalsV1 ? fullPayload.geoSignalsV1 : {};
  const observed = g.observed || {};
  const headings = g.headings || observed.headings || {};
  const landmarks = g.landmarks || observed.landmarks || {};
  const structuredData = g.structuredData || observed.structuredData || {};
  const links = observed.links || {};
  const body = observed.body || {};
  const freshnessOperationSignals = g.freshnessOperationSignals || observed.freshnessOperationSignals || fullPayload && fullPayload.lightweightSummary && fullPayload.lightweightSummary.freshnessOperationSignals || null;
  const aioCheck = g.aioCheck || observed.aioCheck || fullPayload.aioCheck || {};
  const diagnostics = fullPayload && fullPayload.diagnostics ? fullPayload.diagnostics : {};
  const geoDiagnostics = g.diagnostics || {};
  const balanced = g.balanced || {};
  const shortStructuredData = {
    types: arr(structuredData.types, 50, 'geoSignalsV1.structuredData.types'),
    seoTypes: arr(structuredData.seoTypes, 50, 'geoSignalsV1.structuredData.seoTypes'),
    nonSeoTypes: arr(structuredData.nonSeoTypes, 50, 'geoSignalsV1.structuredData.nonSeoTypes'),
    telemetryTypes: arr(structuredData.telemetryTypes, 50, 'geoSignalsV1.structuredData.telemetryTypes'),
    excludedFromSeoTypes: arr(structuredData.excludedFromSeoTypes, 50, 'geoSignalsV1.structuredData.excludedFromSeoTypes'),
    rawCount: structuredData.rawCount,
    parseableCount: structuredData.parseableCount,
    hasJsonLd: structuredData.hasJsonLd,
    hasSeoJsonLd: structuredData.hasSeoJsonLd,
    hasWebsite: structuredData.hasWebsite,
    hasOrganization: structuredData.hasOrganization,
    hasBreadcrumbList: structuredData.hasBreadcrumbList,
    hasFAQPage: structuredData.hasFAQPage,
    hasSitemapXml: Object.prototype.hasOwnProperty.call(structuredData, 'hasSitemapXml') ? structuredData.hasSitemapXml : null,
    sitemapXmlUrl: structuredData.sitemapXmlUrl || null,
    sitemapDiscoveryMethod: structuredData.sitemapDiscoveryMethod || 'not_checked',
    sitemapHttpStatus: Object.prototype.hasOwnProperty.call(structuredData, 'sitemapHttpStatus') ? structuredData.sitemapHttpStatus : null,
    sitemapCheckedUrls: arr(structuredData.sitemapCheckedUrls, 10, 'geoSignalsV1.structuredData.sitemapCheckedUrls', (v) => str(v, 220)),
    source: structuredData.source,
    typeClassificationSource: structuredData.typeClassificationSource,
    confidence: structuredData.confidence,
    observationLimited: structuredData.observationLimited,
    observationScope: structuredData.observationScope,
    renderedDomObserved: structuredData.renderedDomObserved,
    htmlContentLdJsonObserved: structuredData.htmlContentLdJsonObserved,
    htmlContentRawCount: structuredData.htmlContentRawCount,
    htmlContentParseableCount: structuredData.htmlContentParseableCount,
    scriptSrcJsonLdObserved: structuredData.scriptSrcJsonLdObserved,
    scriptSrcCandidateCount: structuredData.scriptSrcCandidateCount,
    scriptSrcFetchedCount: structuredData.scriptSrcFetchedCount,
    scriptSrcJsonLdCandidateCount: structuredData.scriptSrcJsonLdCandidateCount,
    scriptSrcJsonLdTypes: arr(structuredData.scriptSrcJsonLdTypes, 50, 'geoSignalsV1.structuredData.scriptSrcJsonLdTypes'),
    scriptSrcSkippedLargeCount: structuredData.scriptSrcSkippedLargeCount,
    scriptSrcAppIndexDetected: structuredData.scriptSrcAppIndexDetected,
    htmlScanSkipped: structuredData.htmlScanSkipped,
    jsScanSkipped: structuredData.jsScanSkipped,
    chunkScanSkipped: structuredData.chunkScanSkipped,
    parseErrorsCount: structuredData.parseErrorsCount
  };
  const shortHeadings = {
    h1Count: headings.h1Count,
    h2Count: headings.h2Count,
    h3Count: headings.h3Count,
    hasH1: headings.hasH1,
    hasSingleH1: headings.hasSingleH1,
    h1Texts: arr(headings.h1Texts, 5, 'geoSignalsV1.headings.h1Texts', (v) => str(v, 160)),
    headingTexts: arr(headings.headingTexts, 10, 'geoSignalsV1.headings.headingTexts', (v) => str(v, 160)),
    primaryHeadingCandidate: str(headings.primaryHeadingCandidate, 180, 'geoSignalsV1.headings.primaryHeadingCandidate'),
    primaryHeadingCandidateSource: headings.primaryHeadingCandidateSource,
    primaryHeadingConfidence: headings.primaryHeadingConfidence,
    h1EquivalentCandidateFound: headings.h1EquivalentCandidateFound,
    sectionHeadingCandidate: str(headings.sectionHeadingCandidate, 160, 'geoSignalsV1.headings.sectionHeadingCandidate'),
    sectionHeadingCandidateSource: headings.sectionHeadingCandidateSource,
    sectionHeadingConfidence: headings.sectionHeadingConfidence,
    source: headings.source,
    h1Source: headings.h1Source,
    headingObservationLimited: headings.headingObservationLimited,
    excludedHeadingCount: headings.excludedHeadingCount,
    excludedHeadingReasons: arr(headings.excludedHeadingReasons, 10, 'geoSignalsV1.headings.excludedHeadingReasons', (v) => str(v, 80)),
    a11yObserved: headings.a11yObserved
  };
  const shortLandmarks = {
    hasMainLandmark: landmarks.hasMainLandmark,
    hasMainLandmark_final: landmarks.hasMainLandmark_final,
    mainLandmarkSource: landmarks.mainLandmarkSource,
    mainLandmarkConfidence: landmarks.mainLandmarkConfidence,
    mainLandmarkTextsSample: arr(landmarks.mainLandmarkTextsSample, 3, 'geoSignalsV1.landmarks.mainLandmarkTextsSample', (v) => str(v, 160)),
    mainLandmarkCandidateFound: landmarks.mainLandmarkCandidateFound,
    mainLandmarkCandidateSource: landmarks.mainLandmarkCandidateSource,
    mainLandmarkCandidateConfidence: landmarks.mainLandmarkCandidateConfidence,
    mainLandmarkCandidateTextsSample: arr(landmarks.mainLandmarkCandidateTextsSample, 3, 'geoSignalsV1.landmarks.mainLandmarkCandidateTextsSample', (v) => str(v, 160)),
    mainLandmarkObservationLimited: landmarks.mainLandmarkObservationLimited,
    a11yObserved: landmarks.a11yObserved,
    a11yMainCount: landmarks.a11yMainCount
  };
  const shortLinks = {
    navTextsSample: arr(links.navTextsSample, 10, 'geoSignalsV1.observed.links.navTextsSample', (v) => str(v, 100)),
    internalLinksSample: arr(links.internalLinksSample, 10, 'geoSignalsV1.observed.links.internalLinksSample', linkSample),
    externalProfileLinksSample: arr(links.externalProfileLinksSample, 10, 'geoSignalsV1.observed.links.externalProfileLinksSample', (v) => str(v, 180)),
    socialLinksSample: arr(links.socialLinksSample, 10, 'geoSignalsV1.observed.links.socialLinksSample', (v) => str(v, 180)),
    footerExternalLinksSample: arr(links.footerExternalLinksSample, 10, 'geoSignalsV1.observed.links.footerExternalLinksSample', (v) => str(v, 180)),
    externalLinksSample: arr(links.externalLinksSample, 10, 'geoSignalsV1.observed.links.externalLinksSample', (v) => str(v, 180)),
    hasCompanyLikeLink: links.hasCompanyLikeLink,
    hasServiceLikeLink: links.hasServiceLikeLink,
    hasContactLikeLink: links.hasContactLikeLink,
    hasPrivacyLikeLink: links.hasPrivacyLikeLink,
    contactLinkSource: links.contactLinkSource,
    companyLinkSource: links.companyLinkSource,
    serviceLinkSource: links.serviceLinkSource,
    privacyLinkSource: links.privacyLinkSource,
    contactLinkSample: links.contactLinkSample || null,
    companyLinkSample: links.companyLinkSample || null,
    serviceLinkSample: links.serviceLinkSample || null,
    privacyLinkSample: links.privacyLinkSample || null,
    source: links.source,
    confidence: links.confidence
  };
  const shortBalanced = {
    enabled: !!balanced.enabled,
    shadowHeadingScan: !!balanced.shadowHeadingScan,
    shadowHeadingObserved: !!balanced.shadowHeadingObserved,
    shadowHostCount: balanced.shadowHostCount,
    mainH1Texts: arr(balanced.mainH1Texts, 3, 'geoSignalsV1.balanced.mainH1Texts', (v) => str(v, 140)),
    mainH2Texts: arr(balanced.mainH2Texts, 5, 'geoSignalsV1.balanced.mainH2Texts', (v) => str(v, 140)),
    appRootH1Texts: arr(balanced.appRootH1Texts, 3, 'geoSignalsV1.balanced.appRootH1Texts', (v) => str(v, 140)),
    appRootH2Texts: arr(balanced.appRootH2Texts, 5, 'geoSignalsV1.balanced.appRootH2Texts', (v) => str(v, 140)),
    heroH1Texts: arr(balanced.heroH1Texts, 3, 'geoSignalsV1.balanced.heroH1Texts', (v) => str(v, 140)),
    heroH2Texts: arr(balanced.heroH2Texts, 5, 'geoSignalsV1.balanced.heroH2Texts', (v) => str(v, 140)),
    shadowH1Texts: arr(balanced.shadowH1Texts, 3, 'geoSignalsV1.balanced.shadowH1Texts', (v) => str(v, 140)),
    shadowH2Texts: arr(balanced.shadowH2Texts, 5, 'geoSignalsV1.balanced.shadowH2Texts', (v) => str(v, 140)),
    iframeSameOriginH1Texts: arr(balanced.iframeSameOriginH1Texts, 3, 'geoSignalsV1.balanced.iframeSameOriginH1Texts', (v) => str(v, 140)),
    iframeSameOriginH2Texts: arr(balanced.iframeSameOriginH2Texts, 5, 'geoSignalsV1.balanced.iframeSameOriginH2Texts', (v) => str(v, 140)),
    primaryHeadingCandidate: str(balanced.primaryHeadingCandidate, 180, 'geoSignalsV1.balanced.primaryHeadingCandidate'),
    primaryHeadingCandidateSource: balanced.primaryHeadingCandidateSource,
    primaryHeadingConfidence: balanced.primaryHeadingConfidence,
    h1EquivalentCandidateFound: balanced.h1EquivalentCandidateFound,
    sectionHeadingCandidate: str(balanced.sectionHeadingCandidate, 160, 'geoSignalsV1.balanced.sectionHeadingCandidate'),
    sectionHeadingCandidateSource: balanced.sectionHeadingCandidateSource,
    sectionHeadingConfidence: balanced.sectionHeadingConfidence,
    boundedWaitMs: balanced.boundedWaitMs,
    hydration: balanced.hydration || null,
    h1Attempts: balanced.h1Attempts || null
  };
  const shortGeoSignalsV1 = {
    version: g.version,
    generatedAt: g.generatedAt,
    url: g.url,
    structuredData: shortStructuredData,
    headings: shortHeadings,
    balanced: shortBalanced,
    landmarks: shortLandmarks,
    multimodalSignals: g.multimodalSignals || null,
    trustSignals: g.trustSignals || null,
    aioCheck: {
      checked: aioCheck.checked === true,
      hasRobotsTxt: Object.prototype.hasOwnProperty.call(aioCheck, 'hasRobotsTxt') ? aioCheck.hasRobotsTxt : null,
      robotsTxtUrl: aioCheck.robotsTxtUrl || null,
      robotsAiBotHints: Object.prototype.hasOwnProperty.call(aioCheck, 'robotsAiBotHints') ? aioCheck.robotsAiBotHints : null,
      robotsAiBotHintTokens: arr(aioCheck.robotsAiBotHintTokens, 20, 'geoSignalsV1.aioCheck.robotsAiBotHintTokens', (v) => str(v, 80)),
      hasLlmsTxt: Object.prototype.hasOwnProperty.call(aioCheck, 'hasLlmsTxt') ? aioCheck.hasLlmsTxt : null,
      hasLlmsFullTxt: Object.prototype.hasOwnProperty.call(aioCheck, 'hasLlmsFullTxt') ? aioCheck.hasLlmsFullTxt : null,
      llmsTxtUrl: aioCheck.llmsTxtUrl || null,
      llmsFullTxtUrl: aioCheck.llmsFullTxtUrl || null,
      hasSitemapXml: Object.prototype.hasOwnProperty.call(aioCheck, 'hasSitemapXml') ? aioCheck.hasSitemapXml : null,
      sitemapXmlUrl: aioCheck.sitemapXmlUrl || null,
      sitemapDiscoveryMethod: aioCheck.sitemapDiscoveryMethod || 'not_checked',
      sitemapCheckedUrls: arr(aioCheck.sitemapCheckedUrls, 10, 'geoSignalsV1.aioCheck.sitemapCheckedUrls', (v) => str(v, 220)),
      sitemapHttpStatus: Object.prototype.hasOwnProperty.call(aioCheck, 'sitemapHttpStatus') ? aioCheck.sitemapHttpStatus : null,
      sitemapRobotsTxtUrl: aioCheck.sitemapRobotsTxtUrl || null,
      sitemapRobotsHttpStatus: Object.prototype.hasOwnProperty.call(aioCheck, 'sitemapRobotsHttpStatus') ? aioCheck.sitemapRobotsHttpStatus : null,
      aiPolicyEvidenceSource: aioCheck.aiPolicyEvidenceSource || 'not_observed'
    },
    freshnessOperationSignals,
    observed: {
      title: observed.title || null,
      metaDescription: observed.metaDescription || null,
      h1: observed.h1 || null,
      headings: Object.assign({}, shortHeadings, {
        h1: arr(observed.headings && observed.headings.h1, 5, 'geoSignalsV1.observed.headings.h1', (v) => str(v, 160)),
        h2: arr(observed.headings && observed.headings.h2, 10, 'geoSignalsV1.observed.headings.h2', (v) => str(v, 140)),
        h3: arr(observed.headings && observed.headings.h3, 10, 'geoSignalsV1.observed.headings.h3', (v) => str(v, 140))
      }),
      links: shortLinks,
      structuredData: shortStructuredData,
      landmarks: shortLandmarks,
      multimodalSignals: observed.multimodalSignals || g.multimodalSignals || null,
      trustSignals: observed.trustSignals || g.trustSignals || null,
      freshnessOperationSignals,
      body: {
        textLength: body.textLength,
        sample: str(body.sample, 280, 'geoSignalsV1.observed.body.sample'),
        source: body.source,
        confidence: body.confidence
      }
    },
    diagnostics: {
      evaluateCount: geoDiagnostics.evaluateCount,
      balancedMode: geoDiagnostics.balancedMode,
      boundedHydrationWaitMs: geoDiagnostics.boundedHydrationWaitMs,
      hydrationWaitMs: geoDiagnostics.hydrationWaitMs,
      bodyTextBeforeWait: geoDiagnostics.bodyTextBeforeWait,
      bodyTextAfterWait: geoDiagnostics.bodyTextAfterWait,
      hydrationImprovedBodyText: geoDiagnostics.hydrationImprovedBodyText,
      hydrationImprovedLinks: geoDiagnostics.hydrationImprovedLinks,
      jsBundleAnalysis: geoDiagnostics.jsBundleAnalysis,
      resourceChunkScan: geoDiagnostics.resourceChunkScan,
      shadowHeadingScan: geoDiagnostics.shadowHeadingScan,
      a11yHeadingScan: geoDiagnostics.a11yHeadingScan,
      appRootHeadingScan: geoDiagnostics.appRootHeadingScan,
      heroHeadingScan: geoDiagnostics.heroHeadingScan,
      iframeHeadingScan: geoDiagnostics.iframeHeadingScan,
      primaryHeadingScan: geoDiagnostics.primaryHeadingScan,
      shadowPrimaryHeadingScan: geoDiagnostics.shadowPrimaryHeadingScan,
      mainCandidateScan: geoDiagnostics.mainCandidateScan,
      htmlContentLdJsonScan: geoDiagnostics.htmlContentLdJsonScan
    }
  };
  if (g.freshnessFactsBridgeV2DecisionAudit && typeof g.freshnessFactsBridgeV2DecisionAudit === 'object') {
    shortGeoSignalsV1.freshnessFactsBridgeV2DecisionAudit = g.freshnessFactsBridgeV2DecisionAudit;
  }
  if (g.representativeArticleFacts && typeof g.representativeArticleFacts === 'object') {
    shortGeoSignalsV1.representativeArticleFacts = g.representativeArticleFacts;
  }
  if (g.representativeArticleFactsBridgeAudit && typeof g.representativeArticleFactsBridgeAudit === 'object') {
    shortGeoSignalsV1.representativeArticleFactsBridgeAudit = g.representativeArticleFactsBridgeAudit;
  }
  if (g.representativeArticleFactsAdoptionAudit && typeof g.representativeArticleFactsAdoptionAudit === 'object') {
    shortGeoSignalsV1.representativeArticleFactsAdoptionAudit = g.representativeArticleFactsAdoptionAudit;
  }
  if (g.representativeArticleFactsBridgeGateAudit && typeof g.representativeArticleFactsBridgeGateAudit === 'object') {
    shortGeoSignalsV1.representativeArticleFactsBridgeGateAudit = g.representativeArticleFactsBridgeGateAudit;
  }
  const shortLightweightSummary = Object.assign({}, fullPayload.lightweightSummary || {});
  if (Array.isArray(shortLightweightSummary.jsonldTypes)) shortLightweightSummary.jsonldTypes = shortLightweightSummary.jsonldTypes.slice(0, 50);
  if (Array.isArray(shortLightweightSummary.seoJsonldTypes)) shortLightweightSummary.seoJsonldTypes = shortLightweightSummary.seoJsonldTypes.slice(0, 50);
  if (Array.isArray(shortLightweightSummary.nonSeoJsonldTypes)) shortLightweightSummary.nonSeoJsonldTypes = shortLightweightSummary.nonSeoJsonldTypes.slice(0, 50);
  if (Array.isArray(shortLightweightSummary.telemetryJsonldTypes)) shortLightweightSummary.telemetryJsonldTypes = shortLightweightSummary.telemetryJsonldTypes.slice(0, 50);
  if (Array.isArray(shortLightweightSummary.structuredDataScriptSrcJsonLdTypes)) shortLightweightSummary.structuredDataScriptSrcJsonLdTypes = shortLightweightSummary.structuredDataScriptSrcJsonLdTypes.slice(0, 50);
  const shortDiagnostics = Object.assign({}, diagnostics, {
    responseMode: 'short',
    shortMode: true,
    trimmedFields
  });
  const memoryHints = Object.assign({}, fullPayload.memoryHints || {});
  memoryHints.trimmedFields = trimmedFields.slice(0, 80);
  let estimatedOriginalBytes = null;
  let responseBytesApprox = null;
  try { estimatedOriginalBytes = Buffer.byteLength(JSON.stringify(fullPayload), 'utf8'); } catch (_) {}
  const shortPayload = {
    ok: true,
    mode: fullPayload.mode,
    responseMode: 'short',
    shortMode: true,
    url: fullPayload.url,
    finalUrl: fullPayload.finalUrl,
    status: fullPayload.status,
    hasSitemapXml: fullPayload.hasSitemapXml,
    sitemapXmlUrl: fullPayload.sitemapXmlUrl || null,
    sitemapDiscoveryMethod: fullPayload.sitemapDiscoveryMethod || 'not_checked',
    sitemapHttpStatus: Object.prototype.hasOwnProperty.call(fullPayload, 'sitemapHttpStatus') ? fullPayload.sitemapHttpStatus : null,
    sitemapCheckedUrls: arr(fullPayload.sitemapCheckedUrls, 10, 'sitemapCheckedUrls', (v) => str(v, 220)),
    geoSignalsV1: shortGeoSignalsV1,
    lightweightSummary: shortLightweightSummary,
    diagnostics: shortDiagnostics,
    memoryHints
  };
  shortPayload.diagnostics.estimatedOriginalBytes = estimatedOriginalBytes;
  shortPayload.diagnostics.responseBytesApprox = null;
  try {
    responseBytesApprox = Buffer.byteLength(JSON.stringify(shortPayload), 'utf8');
    shortPayload.diagnostics.responseBytesApprox = responseBytesApprox;
  } catch (_) {}
  shortPayload.memoryHints.estimatedOriginalBytes = estimatedOriginalBytes;
  shortPayload.memoryHints.responseBytesApprox = responseBytesApprox;
  return shortPayload;
}

async function scrapeOnce(req, res) {
  const urlToFetch = req.query.url;

  // allow: /scrape?url=...&nocache=1 でキャッシュをバイパス
  const noCache = String(req.query.nocache || '').toLowerCase() === '1';
  const signalsOnly = String(req.query.signalsOnly || '').toLowerCase() === '1';
  const signalsMode = String(req.query.signalsMode || '').toLowerCase();
  const responseMode = String(req.query.responseMode || '').toLowerCase();
  const subpageObservationMode = String(req.query.subpageObservationMode || '').toLowerCase();
  const siteMode = normalizeSubpageJsonLdText(req.query.siteMode || 'generic').toLowerCase() || 'generic';
  const debugHeavySite = String(req.query.debugHeavySite || '').toLowerCase() === '1';
  const debugHeavySiteStartedAt = Date.now();
  const observerMode = String(req.query.observer || '').toLowerCase();
  const signalsFirstLight = signalsMode === 'light' || responseMode === 'signals-first' || responseMode === 'signalsfirst';
  const signalsFirstBalanced = signalsMode === 'balanced' || signalsMode === 'balancedshort' || signalsMode === 'balancedfast' || responseMode === 'signals-balanced' || responseMode === 'signalsbalanced';
  const balancedShortFastResponse = signalsFirstBalanced && (responseMode === 'shortfast' || responseMode === 'short-fast' || signalsMode === 'balancedfast');
  const balancedShortResponse = signalsFirstBalanced && (responseMode === 'short' || signalsMode === 'balancedshort' || balancedShortFastResponse);
  const probeModeRaw = String(req.query.probe || '').toLowerCase();
  const probeAliases = {
    'resource-json': 'resourcejson',
    resourcetap: 'resourcejson',
    'js-tap': 'jstap',
    js: 'jstap',
    'js-fetch': 'jsfetch',
    jsbody: 'jsfetch',
    'js-body': 'jsfetch',
    'js-scan': 'jsscan',
    jsdecode: 'jsscan',
    'js-decode': 'jsscan',
    'js-chunk': 'jschunk',
    chunk: 'jschunk',
    chunktap: 'jschunk',
    'chunk-tap': 'jschunk',
    subpage: 'subpages',
    linkedpages: 'subpages',
    'linked-pages': 'subpages',
    payload: 'payloadassembly',
    'payload-assembly': 'payloadassembly',
    assembly: 'payloadassembly',
    'primary-risk': 'primaryrisk',
    primaryrisk: 'primaryrisk',
    risk: 'primaryrisk',
    'signals-probe': 'primaryrisk',
    'jsonld-balanced': 'jsonldbalanced',
    jsonldbalanced: 'jsonldbalanced',
    'balanced-jsonld': 'jsonldbalanced',
    'jsonld-resource-tap': 'jsonldresourcetap',
    jsonldresourcetap: 'jsonldresourcetap',
    'jsonld-resource': 'jsonldresourcetap',
    'resource-jsonld': 'jsonldresourcetap',
    'jsonld-script-src': 'jsonldscriptsrc',
    jsonldscriptsrc: 'jsonldscriptsrc',
    'script-src-jsonld': 'jsonldscriptsrc',
    'jsonld-script': 'jsonldscriptsrc',
    'goto-timing': 'gototiming',
    gototiming: 'gototiming',
    'goto-probe': 'gototiming',
    'shortfast-phases': 'shortfastphases',
    shortfastphases: 'shortfastphases',
    'shortfast-phase': 'shortfastphases',
    'unified-balanced-observer': 'unifiedbalancedobserver',
    unifiedbalancedobserver: 'unifiedbalancedobserver',
    'balanced-observer': 'unifiedbalancedobserver',
    'unified-observer': 'unifiedbalancedobserver'
  };
  const probeModes = ['content', 'text', 'audit', 'data', 'resourcejson', 'jstap', 'jsfetch', 'jsscan', 'jschunk', 'subpages', 'payloadassembly', 'primaryrisk', 'jsonldbalanced', 'jsonldresourcetap', 'jsonldscriptsrc', 'gototiming', 'shortfastphases', 'unifiedbalancedobserver'];
  const probeMode = probeAliases[probeModeRaw] || (probeModes.includes(probeModeRaw) ? probeModeRaw : '');
  const observerProbeMode = signalsFirstBalanced && (observerMode === 'unifiedprobe' || observerMode === 'unified-probe' || observerMode === 'unified') ? 'unifiedbalancedobserver' : '';
  const probeMaxFetchRaw = Number(req.query.maxFetch);
  const probeMaxFetch = Math.max(1, Math.min(20, Number.isFinite(probeMaxFetchRaw) && probeMaxFetchRaw > 0
    ? Math.floor(probeMaxFetchRaw)
    : 8
  ));
  const probeMaxChunkFetchRaw = Number(req.query.maxChunkFetch);
  const probeMaxChunkFetch = Math.max(0, Math.min(30, Number.isFinite(probeMaxChunkFetchRaw) && probeMaxChunkFetchRaw >= 0
    ? Math.floor(probeMaxChunkFetchRaw)
    : 10
  ));
  const probeMaxSubpageFetchRaw = Number(req.query.maxSubpageFetch);
  const probeMaxSubpageFetch = Math.max(0, Math.min(10, Number.isFinite(probeMaxSubpageFetchRaw) && probeMaxSubpageFetchRaw >= 0
    ? Math.floor(probeMaxSubpageFetchRaw)
    : 3
  ));

  logSf('SCRAPE_ENTER', {
    stage: 'scrapeOnce',
    url: String(urlToFetch || '').slice(0, 180),
    nocache: noCache,
    signalsOnly,
    signalsFirstLight,
    signalsFirstBalanced,
    probe: probeMode || null
  });
  logSfMemory('scrape_enter');

  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  // --- CACHE CHECK (early return) ---
  try {
    if (!noCache) {
      const cached = cacheGet(urlToFetch);
      if (cached && cached.json) {
        const payload = JSON.parse(JSON.stringify(cached.json));
        if (!payload.debug) payload.debug = {};
        payload.debug.cache = { hit: true, ageMs: cached.age, ttlMs: CACHE_TTL_MS, nocache: false };

        console.log('[TRACE_COVNAV][NODE][cache-hit-return]', {
          url: urlToFetch,
          hasAuditSig: !!payload.auditSig,
          hasCoverageNav: !!(payload.auditSig && payload.auditSig.coverageNav),
          coverageNav: payload.auditSig && payload.auditSig.coverageNav
        });

        return res.status(200).json(payload);
      }
    }
  } catch(_) {}

  // メモリが既に逼迫している場合はソフトフェイル（Render の再起動ループ回避）
  const RSS_HARD_LIMIT = Number(process.env.RSS_HARD_LIMIT || 900 * 1024 * 1024); // ~900MB 目安
  if (process.memoryUsage().rss > RSS_HARD_LIMIT) {
    return res.status(503).json({ error: 'over_memory_limit', hint: 'reduce concurrency or upgrade instance' });
  }

  let browser = null;
  let context = null;
  let page = null;
  const t0 = Date.now();
  const scrapeTiming = {
    spans: {
      browser_launch_context: 0,
      initial_goto_and_waits: 0,
      collectEnrichedObservations: 0,
      dom_shadow_text_extract: 0,
      top_about_same_fetch: 0,
      resource_json_tap: 0,
      resource_js_tap: 0,
      chunk_tap: 0,
      jsonld_wait_probe: 0,
      subpages_vnext: 0,
      response_payload_build: 0
    },
    responsePayloadSubspans: {
      heading_extract: 0,
      primary_heading_extract: 0,
      body_text_candidates_extract: 0,
      primary_message_extract: 0,
      response_object_assembly: 0,
      jsonld_flags_patch: 0,
      build_scores_from_scrape: 0,
      output_object_assembly: 0
    },
    payload_size_summary: null,
    subpagesVNextDecision: {
      enabled: !!ENABLE_SUBPAGES_VNEXT,
      envValue: process.env.ENABLE_SUBPAGES_VNEXT ?? null,
      origin: null,
      candidateCount: 0,
      candidateSample: [],
      attemptedCount: 0,
      adoptedCount: 0,
      skipReason: 'not_reached',
      errorMessage: '',
      limit: 1,
      elapsedMs: 0
    }
  };
  let hydratedForTiming = null;
  let topPageStaticFetchResult = null;
  let playwrightStarted = false;
  const addScrapeSpan = (name, start) => {
    try {
      if (!Object.prototype.hasOwnProperty.call(scrapeTiming.spans, name)) scrapeTiming.spans[name] = 0;
      scrapeTiming.spans[name] += Math.max(0, Date.now() - Number(start || Date.now()));
    } catch (_) {}
  };
  const safeTimingUrl = () => {
    try { return new URL(String(urlToFetch || '')).origin; } catch (_) { return String(urlToFetch || '').slice(0, 120); }
  };
  const addResponsePayloadSpan = (name, start) => {
    try {
      const spans = scrapeTiming.responsePayloadSubspans || {};
      if (!Object.prototype.hasOwnProperty.call(spans, name)) spans[name] = 0;
      spans[name] += Math.max(0, Date.now() - Number(start || Date.now()));
      scrapeTiming.responsePayloadSubspans = spans;
    } catch (_) {}
  };
  const safeLength = (v) => {
    try { return typeof v === 'string' ? v.length : 0; } catch (_) { return 0; }
  };
  const safeArrayLength = (v) => {
    try { return Array.isArray(v) ? v.length : 0; } catch (_) { return 0; }
  };
  const topPageMemorySnapshot = () => {
    try {
      const memory = process.memoryUsage();
      return {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers
      };
    } catch (_) {
      return null;
    }
  };
  const logHeavySiteTopPageAudit = (phase, details = {}) => {
    if (!debugHeavySite) return;
    try {
      const currentFinalUrl = page && typeof page.url === 'function' ? page.url() : '';
      console.log('[DEBUG][HEAVY_SITE_TOPPAGE_AUDIT]', JSON.stringify({
        phase,
        url: urlToFetch,
        finalUrl: currentFinalUrl || '',
        elapsedMs: Date.now() - debugHeavySiteStartedAt,
        memory: topPageMemorySnapshot(),
        details
      }));
    } catch (_) {}
  };

  try {
    if (signalsFirstLight || signalsFirstBalanced) {
      const __timingTopPageStaticFetchStart = Date.now();
      topPageStaticFetchResult = await fetchTopPageStaticSignals_(urlToFetch, { siteMode, signalsMode, responseMode });
      scrapeTiming.spans.top_page_static_fetch = Math.max(0, Date.now() - __timingTopPageStaticFetchStart);
      logSf('TOP_PAGE_STATIC_FETCH_DONE', {
        success: topPageStaticFetchResult && topPageStaticFetchResult.success,
        elapsedMs: topPageStaticFetchResult && topPageStaticFetchResult.elapsedMs,
        title: topPageStaticFetchResult && topPageStaticFetchResult.signals && topPageStaticFetchResult.signals.title || '',
        h1Count: topPageStaticFetchResult && topPageStaticFetchResult.signals && topPageStaticFetchResult.signals.h1Count || 0
      });
    }
    logHeavySiteTopPageAudit('request_start', {
      signalsMode,
      responseMode,
      subpageObservationMode,
      noCache,
      signalsOnly,
      signalsFirstLight,
      signalsFirstBalanced
    });
    const __timingBrowserStart = Date.now();
    logHeavySiteTopPageAudit('browser_page_setup_start', {
      step: 'chromium_launch'
    });
    playwrightStarted = true;
    browser = await chromium.launch({
      headless: true,
      // 共有メモリ不足・GPU初期化失敗・権限周りのクラッシュを抑止
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-zygote',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });
    scrapeTiming.browserReadyMs = Math.max(0, Date.now() - __timingBrowserStart);
    logHeavySiteTopPageAudit('browser_page_setup_progress', {
      browserReadyMs: scrapeTiming.browserReadyMs
    });

    const __timingPageReadyStart = Date.now();
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                 'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                 'Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    page = await context.newPage();
    // デフォルトタイムアウト（ENV で調整可）
    const NAV_TIMEOUT_MS   = Number(process.env.SCRAPE_NAV_TIMEOUT_MS   || 20000);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    scrapeTiming.pageReadyMs = Math.max(0, Date.now() - __timingPageReadyStart);
    addScrapeSpan('browser_launch_context', __timingBrowserStart);
    logHeavySiteTopPageAudit('browser_page_setup_end', {
      browserReadyMs: scrapeTiming.browserReadyMs,
      pageReadyMs: scrapeTiming.pageReadyMs,
      navTimeoutMs: NAV_TIMEOUT_MS
    });

    if (probeMode === 'gototiming') {
      const probeStartedAt = Date.now();
      const blockedCounts = {
        image: 0,
        font: 0,
        media: 0,
        stylesheet: 0,
        thirdPartyScript: 0,
        total: 0
      };
      let targetOrigin = '';
      try { targetOrigin = new URL(String(urlToFetch || '')).origin; } catch (_) {}
      const routeSetupStart = Date.now();
      try {
        await page.route('**/*', async (route) => {
          try {
            const request = route.request();
            const type = request.resourceType();
            const requestUrl = request.url();
            const shouldBlockType = ['image', 'font', 'media', 'stylesheet'].includes(type);
            let shouldBlockThirdPartyScript = false;
            if (type === 'script' && targetOrigin) {
              try { shouldBlockThirdPartyScript = new URL(requestUrl).origin !== targetOrigin; } catch (_) {}
            }
            if (shouldBlockType || shouldBlockThirdPartyScript) {
              if (shouldBlockThirdPartyScript) blockedCounts.thirdPartyScript += 1;
              else if (Object.prototype.hasOwnProperty.call(blockedCounts, type)) blockedCounts[type] += 1;
              blockedCounts.total += 1;
              return route.abort().catch(() => {});
            }
            return route.continue().catch(() => {});
          } catch (_) {
            return route.continue().catch(() => {});
          }
        });
      } catch (_) {}
      const routeSetupMs = Math.max(0, Date.now() - routeSetupStart);
      let resp = null;
      let errorMessage = '';
      const gotoStart = Date.now();
      logSf('GOTO_TIMING_PROBE_BEFORE_GOTO', { url: String(urlToFetch || '').slice(0, 180) });
      logSfMemory('goto_timing_probe_before_goto');
      try {
        resp = await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 12000 });
      } catch (e) {
        errorMessage = String(e && (e.message || e) || '').slice(0, 240);
      }
      const gotoMs = Math.max(0, Date.now() - gotoStart);
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      const pageSignals = await page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        return {
          title: clean(document.title || '').slice(0, 180),
          bodyTextLength: clean(document.body && (document.body.innerText || document.body.textContent)).length,
          anchorCount: document.querySelectorAll('a[href]').length,
          scriptCount: document.querySelectorAll('script').length
        };
      }).catch(() => ({
        title: '',
        bodyTextLength: null,
        anchorCount: null,
        scriptCount: null
      }));
      const status = resp && typeof resp.status === 'function' ? resp.status() : null;
      const statusText = resp && typeof resp.statusText === 'function' ? resp.statusText() : null;
      const out = {
        ok: !errorMessage,
        mode: 'gotoTimingProbe',
        url: urlToFetch,
        finalUrl,
        status,
        errorMessage,
        timings: {
          browserReadyMs: typeof scrapeTiming.browserReadyMs === 'number' ? scrapeTiming.browserReadyMs : null,
          pageReadyMs: typeof scrapeTiming.pageReadyMs === 'number' ? scrapeTiming.pageReadyMs : null,
          routeSetupMs,
          gotoMs,
          totalMs: Math.max(0, Date.now() - probeStartedAt)
        },
        responseInfo: {
          status,
          statusText,
          finalUrl
        },
        pageSignals,
        blockedCounts,
        diagnostics: {
          probeOnly: true,
          balancedSkipped: true,
          fullScrapeSkipped: true,
          evaluationSkipped: true,
          gotoTimeoutMs: 12000,
          blockedResourceTypes: ['image', 'font', 'media', 'stylesheet', 'thirdPartyScript']
        }
      };
      logSf('GOTO_TIMING_PROBE_SEND', {
        ok: out.ok,
        status: out.status,
        errorMessage: out.errorMessage,
        timings: out.timings,
        blockedCounts: out.blockedCounts,
        pageSignals: out.pageSignals
      });
      logSfMemory('goto_timing_probe_send');
      return res.status(200).json(out);
    }

    if (probeMode === 'shortfastphases' || probeMode === 'unifiedbalancedobserver' || observerProbeMode === 'unifiedbalancedobserver' || balancedShortFastResponse) {
      const unifiedBalancedObserverProbe = probeMode === 'unifiedbalancedobserver' || observerProbeMode === 'unifiedbalancedobserver';
      const probeStartedAt = Date.now();
      const phases = [];
      const blockedCounts = {
        image: 0,
        font: 0,
        media: 0,
        stylesheet: 0,
        thirdPartyScript: 0,
        total: 0
      };
      let targetOrigin = '';
      try { targetOrigin = new URL(String(urlToFetch || '')).origin; } catch (_) {}
      const routeSetupStart = Date.now();
      try {
        await page.route('**/*', async (route) => {
          try {
            const request = route.request();
            const type = request.resourceType();
            const requestUrl = request.url();
            const shouldBlockType = ['image', 'font', 'media', 'stylesheet'].includes(type);
            let shouldBlockThirdPartyScript = false;
            if (type === 'script' && targetOrigin) {
              try { shouldBlockThirdPartyScript = new URL(requestUrl).origin !== targetOrigin; } catch (_) {}
            }
            if (shouldBlockType || shouldBlockThirdPartyScript) {
              if (shouldBlockThirdPartyScript) blockedCounts.thirdPartyScript += 1;
              else if (Object.prototype.hasOwnProperty.call(blockedCounts, type)) blockedCounts[type] += 1;
              blockedCounts.total += 1;
              return route.abort().catch(() => {});
            }
            return route.continue().catch(() => {});
          } catch (_) {
            return route.continue().catch(() => {});
          }
        });
      } catch (_) {}
      const routeSetupMs = Math.max(0, Date.now() - routeSetupStart);
      const withTimeout = (promise, ms, label) => Promise.race([
        Promise.resolve().then(() => promise),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms))
      ]);
      const runPhase = async (name, fn, timeoutMs = 3000) => {
        const started = Date.now();
        const phase = {
          name,
          ok: false,
          elapsedMs: 0,
          errorMessage: '',
          minimalResult: null
        };
        if (unifiedBalancedObserverProbe) {
          try {
            console.log('[UNIFIED_OBSERVER][PHASE_START]', JSON.stringify({
              label: 'unified-balanced-observer',
              phase: name,
              url: urlToFetch,
              elapsedMs: Math.max(0, Date.now() - probeStartedAt),
              timeoutMs
            }));
          } catch (_) {}
        }
        try {
          phase.minimalResult = await withTimeout(fn(), timeoutMs, name);
          phase.ok = true;
        } catch (e) {
          phase.errorMessage = String(e && (e.message || e) || '').slice(0, 240);
        }
        phase.elapsedMs = Math.max(0, Date.now() - started);
        phases.push(phase);
        if (unifiedBalancedObserverProbe) {
          try {
            const isTimeout = /\btimeout_\d+ms\b/i.test(phase.errorMessage || '');
            console.log(
              phase.ok ? '[UNIFIED_OBSERVER][PHASE_END]' : (isTimeout ? '[UNIFIED_OBSERVER][PHASE_TIMEOUT]' : '[UNIFIED_OBSERVER][PHASE_ERROR]'),
              JSON.stringify({
                label: 'unified-balanced-observer',
                phase: name,
                ok: phase.ok,
                url: urlToFetch,
                elapsedMs: phase.elapsedMs,
                totalElapsedMs: Math.max(0, Date.now() - probeStartedAt),
                errorMessage: phase.errorMessage || ''
              })
            );
          } catch (_) {}
        }
        return phase;
      };
      let resp = null;
      let gotoPhase = null;
      let finalUrl = urlToFetch;
      let status = null;
      let gotoPartialRecovery = null;
      const quickDomProbe = async (label) => page.evaluate((sourceLabel) => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const metaEl =
          document.querySelector('meta[name="description" i]') ||
          document.querySelector('meta[property="og:description" i]') ||
          document.querySelector('meta[name="twitter:description" i]');
        const metaDescription = clean(metaEl && metaEl.getAttribute('content'));
        return {
          source: sourceLabel,
          documentPresent: !!document,
          readyState: document.readyState || '',
          currentUrl: location.href || '',
          title: clean(document.title || '').slice(0, 180),
          metaDescription: metaDescription ? metaDescription.slice(0, 500) : '',
          metaDescriptionLength: metaDescription ? metaDescription.length : null,
          anchorCount: document.querySelectorAll('a[href]').length,
          bodyTextLength: clean(document.body && (document.body.innerText || document.body.textContent) || '').length
        };
      }, label);
      const collectAioCheckSummaryLight = async (pageUrl) => {
        const botTokens = ['GPTBot', 'Google-Extended', 'CCBot', 'ClaudeBot', 'PerplexityBot', 'Applebot-Extended'];
        let origin = '';
        try { origin = new URL(String(pageUrl || urlToFetch || '')).origin; } catch (_) {}
        const empty = {
          checked: false,
          hasRobotsTxt: null,
          robotsTxtUrl: origin ? `${origin}/robots.txt` : null,
          robotsAiBotHints: null,
          robotsAiBotHintTokens: [],
          hasLlmsTxt: null,
          hasLlmsFullTxt: null,
          llmsTxtUrl: origin ? `${origin}/llms.txt` : null,
          llmsFullTxtUrl: origin ? `${origin}/llms-full.txt` : null,
          hasSitemapXml: null,
          sitemapXmlUrl: null,
          sitemapDiscoveryMethod: 'not_checked',
          sitemapCheckedUrls: [],
          sitemapHttpStatus: null,
          checkedLlmsTxtUrls: origin ? [`${origin}/llms.txt`] : [],
          checkedLlmsFullTxtUrls: origin ? [`${origin}/llms-full.txt`] : [],
          aiPolicyEvidenceSource: 'not_observed'
        };
        if (!origin || typeof fetch !== 'function') return Object.assign({}, empty, {
          checked: false,
          aiPolicyEvidenceSource: 'check_failed'
        });
        const fetchText = async (targetUrl, timeoutMs = 1500) => {
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
          try {
            const response = await fetch(targetUrl, {
              method: 'GET',
              redirect: 'follow',
              signal: controller ? controller.signal : undefined,
              headers: { 'Accept': 'text/plain,*/*;q=0.8', 'User-Agent': 'geo-unified-observer-aio-check/1.0' }
            });
            const status = response && typeof response.status === 'number' ? response.status : null;
            const contentType = response && response.headers && response.headers.get ? String(response.headers.get('content-type') || '') : '';
            if (!response || !response.ok) return { ok: false, status, text: '', contentType };
            const text = String(await response.text() || '').slice(0, 120000);
            return { ok: true, status, text, contentType };
          } catch (e) {
            return { ok: false, status: null, text: '', contentType: '', errorMessage: String(e && (e.message || e) || '').slice(0, 160) };
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        const robotsTxtUrl = `${origin}/robots.txt`;
        const llmsTxtUrl = `${origin}/llms.txt`;
        const llmsFullTxtUrl = `${origin}/llms-full.txt`;
        const [robots, llms, llmsFull] = await Promise.all([
          fetchText(robotsTxtUrl, 1500),
          fetchText(llmsTxtUrl, 1500),
          fetchText(llmsFullTxtUrl, 1500)
        ]);
        const robotsEvaluated = robots && robots.ok;
        const robotsText = robotsEvaluated ? String(robots.text || '') : '';
        const hintTokens = robotsEvaluated
          ? botTokens.filter((token) => new RegExp(`(^|[^A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`, 'i').test(robotsText))
          : [];
        const hasLlmsTxt = llms && llms.ok ? true : (llms && llms.status === 404 ? false : null);
        const hasLlmsFullTxt = llmsFull && llmsFull.ok ? true : (llmsFull && llmsFull.status === 404 ? false : null);
        const robotsAiBotHints = robotsEvaluated ? hintTokens.length > 0 : null;
        const sitemapDiscovery = await discoverSitemapFromOrigin_(origin, fetchText, { timeoutMs: 1500 });
        const evidence = [];
        if (robotsEvaluated) evidence.push('robots_txt');
        if (hasLlmsTxt === true) evidence.push('llms_txt');
        if (hasLlmsFullTxt === true) evidence.push('llms_full_txt');
        return {
          checked: true,
          hasRobotsTxt: robotsEvaluated ? true : (robots && robots.status === 404 ? false : null),
          robotsTxtUrl,
          robotsAiBotHints,
          robotsAiBotHintTokens: hintTokens,
          hasSitemapXml: sitemapDiscovery.exists,
          sitemapXmlUrl: sitemapDiscovery.url,
          sitemapDiscoveryMethod: sitemapDiscovery.discoveryMethod,
          sitemapCheckedUrls: Array.isArray(sitemapDiscovery.checkedUrls) ? sitemapDiscovery.checkedUrls.slice(0, 10) : [],
          sitemapHttpStatus: sitemapDiscovery.httpStatus,
          sitemapRobotsTxtUrl: sitemapDiscovery.robotsTxtUrl,
          sitemapRobotsHttpStatus: sitemapDiscovery.robotsHttpStatus,
          hasLlmsTxt,
          hasLlmsFullTxt,
          llmsTxtUrl,
          llmsFullTxtUrl,
          checkedLlmsTxtUrls: [llmsTxtUrl],
          checkedLlmsFullTxtUrls: [llmsFullTxtUrl],
          aiPolicyEvidenceSource: evidence.length ? evidence.join('_and_') : 'not_observed'
        };
      };
      await runPhase('goto', async () => {
        let gotoPartial = false;
        let domContentLoaded = false;
        let gotoErrorMessage = '';
        if (unifiedBalancedObserverProbe) {
          try {
            resp = await page.goto(urlToFetch, { waitUntil: 'commit', timeout: 8000 });
          } catch (e) {
            gotoPartial = true;
            gotoErrorMessage = String(e && (e.message || e) || '').slice(0, 180);
            try {
              resp = await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 4000 });
              domContentLoaded = true;
              gotoPartial = false;
            } catch (fallbackError) {
              gotoErrorMessage = [gotoErrorMessage, String(fallbackError && (fallbackError.message || fallbackError) || '').slice(0, 180)]
                .filter(Boolean)
                .join(' | ');
            }
          }
          if (resp && !domContentLoaded) {
            try {
              await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
              domContentLoaded = true;
            } catch (e) {
              gotoPartial = true;
              gotoErrorMessage = String(e && (e.message || e) || '').slice(0, 180);
            }
          }
        } else {
          resp = await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 12000 });
          domContentLoaded = true;
        }
        finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
        status = resp && typeof resp.status === 'function' ? resp.status() : null;
        return {
          status,
          statusText: resp && typeof resp.statusText === 'function' ? resp.statusText() : null,
          finalUrl,
          waitUntil: unifiedBalancedObserverProbe ? 'commit_then_domcontentloaded_guard' : 'domcontentloaded',
          domContentLoaded,
          partial: gotoPartial,
          gotoPartial,
          errorMessage: gotoErrorMessage || undefined
        };
      }, 13000);
      gotoPhase = phases[phases.length - 1];
      finalUrl = page && typeof page.url === 'function' ? page.url() : finalUrl;
      status = resp && typeof resp.status === 'function' ? resp.status() : status;
      if (unifiedBalancedObserverProbe && gotoPhase && (!gotoPhase.ok || (gotoPhase.minimalResult && gotoPhase.minimalResult.gotoPartial))) {
        gotoPartialRecovery = await withTimeout(quickDomProbe('goto_timeout_partial_probe'), 1200, 'goto_partial_probe')
          .catch((e) => ({
            source: 'goto_timeout_partial_probe',
            errorMessage: String(e && (e.message || e) || '').slice(0, 180),
            documentPresent: false,
            readyState: '',
            currentUrl: page && typeof page.url === 'function' ? page.url() : finalUrl
          }));
        if (gotoPartialRecovery && gotoPartialRecovery.documentPresent) {
          gotoPhase.minimalResult = Object.assign({}, gotoPhase.minimalResult || {}, {
            partial: true,
            gotoPartial: true,
            finalUrl: gotoPartialRecovery.currentUrl || finalUrl,
            readyState: gotoPartialRecovery.readyState || '',
            quickProbe: gotoPartialRecovery
          });
          finalUrl = gotoPartialRecovery.currentUrl || finalUrl;
          gotoPhase.errorMessage = 'goto_timeout_partial_dom_recovered';
        }
      }

      await runPhase('hydrationGuardedWait', async () => {
        if (!unifiedBalancedObserverProbe) {
          return {
            skipped: true,
            reason: 'not_unified_balanced_observer_probe'
          };
        }
        const before = await page.evaluate(() => ({
          bodyTextLength: String(document.body && (document.body.innerText || document.body.textContent) || '').replace(/\s+/g, ' ').trim().length,
          anchorCount: document.querySelectorAll('a[href]').length,
          shadowAnchorCount: (() => {
            let count = 0;
            const walk = (root, depth = 0) => {
              if (!root || depth > 2 || count >= 200) return;
              const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
              nodes.forEach((el) => {
                if (!el) return;
                if (String(el.tagName || '').toLowerCase() === 'a' && el.getAttribute && el.getAttribute('href')) count += 1;
                if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
              });
            };
            try { walk(document, 0); } catch (_) {}
            return count;
          })()
        })).catch(() => ({ bodyTextLength: 0, anchorCount: 0 }));
        await page.waitForFunction(({ before }) => {
          const bodyTextLength = String(document.body && (document.body.innerText || document.body.textContent) || '').replace(/\s+/g, ' ').trim().length;
          const anchorCount = document.querySelectorAll('a[href]').length;
          let shadowAnchorCount = 0;
          const walk = (root, depth = 0) => {
            if (!root || depth > 2 || shadowAnchorCount >= 200) return;
            const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
            nodes.forEach((el) => {
              if (!el) return;
              if (String(el.tagName || '').toLowerCase() === 'a' && el.getAttribute && el.getAttribute('href')) shadowAnchorCount += 1;
              if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
            });
          };
          try { walk(document, 0); } catch (_) {}
          return anchorCount > Math.max(0, before.anchorCount) || anchorCount >= 5 ||
            shadowAnchorCount > Math.max(0, before.shadowAnchorCount) || shadowAnchorCount >= 5 ||
            bodyTextLength > Math.max(1800, before.bodyTextLength + 400);
        }, { before }, { timeout: 4000, polling: 250 }).catch(() => {});
        const after = await page.evaluate(() => ({
          bodyTextLength: String(document.body && (document.body.innerText || document.body.textContent) || '').replace(/\s+/g, ' ').trim().length,
          anchorCount: document.querySelectorAll('a[href]').length,
          shadowAnchorCount: (() => {
            let count = 0;
            const walk = (root, depth = 0) => {
              if (!root || depth > 2 || count >= 200) return;
              const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
              nodes.forEach((el) => {
                if (!el) return;
                if (String(el.tagName || '').toLowerCase() === 'a' && el.getAttribute && el.getAttribute('href')) count += 1;
                if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
              });
            };
            try { walk(document, 0); } catch (_) {}
            return count;
          })()
        })).catch(() => ({ bodyTextLength: 0, anchorCount: 0, shadowAnchorCount: 0 }));
        return {
          skipped: false,
          limited: true,
          waitMs: 4000,
          bodyTextBeforeWait: before.bodyTextLength,
          bodyTextAfterWait: after.bodyTextLength,
          anchorCountBeforeWait: before.anchorCount,
          anchorCountAfterWait: after.anchorCount,
          shadowAnchorCountBeforeWait: before.shadowAnchorCount,
          shadowAnchorCountAfterWait: after.shadowAnchorCount,
          hydrationImprovedBodyText: after.bodyTextLength > before.bodyTextLength,
          hydrationImprovedLinks: after.anchorCount > before.anchorCount || after.shadowAnchorCount > before.shadowAnchorCount
        };
      }, 4500);

      await runPhase('headMetaEval', async () => page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const metaEl =
          document.querySelector('meta[name="description" i]') ||
          document.querySelector('meta[property="og:description" i]') ||
          document.querySelector('meta[name="twitter:description" i]');
        const metaDescription = clean(metaEl && metaEl.getAttribute('content'));
        return {
          title: clean(document.title || '').slice(0, 180),
          metaDescription: metaDescription ? metaDescription.slice(0, 500) : '',
          metaDescriptionLength: metaDescription ? metaDescription.length : 0,
          observed: true
        };
      }), 1200);

      await runPhase('basicDomEval', async () => page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const readableBodyText = () => {
          try {
            const clone = document.body && document.body.cloneNode(true);
            if (!clone) return '';
            clone.querySelectorAll('nav,header,footer,aside,[role="navigation"],script,style,noscript,template,svg').forEach((el) => el.remove());
            return clean(clone.innerText || clone.textContent);
          } catch (_) {
            return clean(document.body && document.body.innerText);
          }
        };
        const stripCssAndScriptFragments = (text) => {
          let t = clean(text);
          if (!t) return '';
          t = t
            .replace(/<[^>]*>/g, ' ')
            .replace(/if\s*\(!window\.fetch\)[\s\S]*/i, ' ')
            .replace(/window\.fetch[\s\S]*/i, ' ')
            .replace(/@(?:media|supports|keyframes)\b[\s\S]{0,1200}/gi, ' ');
          const cssStart = t.search(/\b(?:html\s*,\s*body|:root|body\s*\{|app-[\w-]+\[[^\]]+\]\s*\{|#[\w-]+\s*\{|\\.[\w-]+\s*\{|--[\w-]+\s*:|display\s*:|font-[\w-]+\s*:|-webkit-[\w-]+\s*:|text-size-adjust\s*:)/i);
          if (cssStart >= 0) {
            const prefix = t.slice(0, cssStart).trim();
            t = prefix.length >= 12 ? prefix : t.slice(cssStart).replace(/[^{}]{0,160}\{[^{}]*\}/g, ' ');
          }
          return clean(t
            .replace(/[^{}]{0,160}\{[^{}]*\}/g, ' ')
            .replace(/\b(?:display|margin|padding|min-height|place-items|font-[\w-]+|-webkit-[\w-]+|text-size-adjust)\s*:\s*[^;]+;?/gi, ' ')
            .replace(/--[\w-]+\s*:\s*[^;]+;?/g, ' ')
          );
        };
        const looksLikeScriptOrWarning = (text) => {
          const t = clean(text).slice(0, 500);
          if (!t) return true;
          if (/window\.fetch|document\.|function\s*\(|<script|<\/?[a-z][^>]*>/i.test(t)) return true;
          if (/html\s*,\s*body\s*\{|@media|:root|--[\w-]+\s*:|-webkit-|text-size-adjust|display\s*:|font-[\w-]+\s*:|margin\s*:|padding\s*:|place-items\s*:|min-height\s*:/i.test(t)) return true;
          if (/JavaScriptを有効にしてください|javascript is required/i.test(t) && t.length < 220) return true;
          return false;
        };
        const normalizeBodySample = (text) => stripCssAndScriptFragments(String(text || '')
          .replace(/JavaScriptを有効にしてください/gi, ' ')
        );
        const textFromCloneWithoutChrome = (el) => {
          try {
            if (!el) return '';
            const clone = el.cloneNode(true);
            clone.querySelectorAll('nav,header,footer,aside,[role="navigation"],script,style,noscript,template,svg').forEach((node) => node.remove());
            return normalizeBodySample(clone.innerText || clone.textContent);
          } catch (_) {
            return '';
          }
        };
        const mainTextCandidate = () => {
          const selectors = [
            'main',
            '[role="main"]',
            'article',
            '#main',
            '#main-content',
            '#content',
            '[id*="content" i]',
            'app-index',
            '#app',
            '#root'
          ];
          const candidates = [];
          selectors.forEach((selector) => {
            try {
              Array.from(document.querySelectorAll(selector)).slice(0, 3).forEach((el) => {
                const text = textFromCloneWithoutChrome(el);
                if (text) candidates.push(text);
              });
            } catch (_) {}
          });
          if (!candidates.length) {
            try {
              Array.from(document.querySelectorAll('section')).slice(0, 8).forEach((el) => {
                const text = textFromCloneWithoutChrome(el);
                if (text) candidates.push(text);
              });
            } catch (_) {}
          }
          return candidates
            .filter((text) => text.length >= 40)
            .sort((a, b) => b.length - a.length)[0] || '';
        };
        const shadowTextParts = [];
        try {
          const walkShadow = (root, depth = 0) => {
            if (!root || depth > 4 || shadowTextParts.length >= 50) return;
            const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
            nodes.forEach((el) => {
              if (!el || shadowTextParts.length >= 50) return;
              const tag = String(el.tagName || '').toLowerCase();
              if (['script', 'style', 'noscript', 'template', 'svg'].includes(tag)) return;
              const text = clean(el.innerText || el.textContent);
              if (text && text.length >= 2) shadowTextParts.push(text.slice(0, 300));
              if (el.shadowRoot) walkShadow(el.shadowRoot, depth + 1);
            });
          };
          walkShadow(document, 0);
        } catch (_) {}
        const domBodyText = readableBodyText();
        const bodyText = clean([domBodyText].concat(shadowTextParts).join(' '));
        const mainCandidateText = mainTextCandidate();
        const titleText = clean(document.title || '').slice(0, 180);
        const sampleCandidates = [
          mainCandidateText,
          domBodyText,
          clean(shadowTextParts.join(' ')),
          bodyText
        ].map(normalizeBodySample).filter(Boolean);
        const bodyTextSample = (sampleCandidates.find((text) => !looksLikeScriptOrWarning(text)) || titleText || '').slice(0, 800);
        const metaEl =
          document.querySelector('meta[name="description" i]') ||
          document.querySelector('meta[property="og:description" i]') ||
          document.querySelector('meta[name="twitter:description" i]');
        const metaDescription = clean(metaEl && metaEl.getAttribute('content'));
        return {
          title: titleText,
          metaDescription: metaDescription ? metaDescription.slice(0, 500) : '',
          metaDescriptionLength: metaDescription ? metaDescription.length : 0,
          bodyTextLength: bodyText.length,
          bodyTextSample,
          anchorCount: document.querySelectorAll('a[href]').length,
          scriptCount: document.querySelectorAll('script').length,
          shadowTextPartsCount: shadowTextParts.length
        };
      }), unifiedBalancedObserverProbe ? 2000 : 3000);

      await runPhase('structuredDataLight', async () => {
        const emptyRendered = {
          renderedDomRawCount: null,
          renderedDomParseableCount: null,
          renderedDomParseErrorsCount: 0,
          renderedDomTypes: [],
          observed: false
        };
        const emptyHtml = {
          rawCount: null,
          parseableCount: null,
          parseErrorsCount: 0,
          types: [],
          htmlContentLdJsonObserved: false,
          error: null
        };
        const rendered = await withTimeout(page.evaluate(() => {
          const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
          const typeNames = (node) => {
            const t = node && node['@type'];
            const values = Array.isArray(t) ? t : (t ? [t] : []);
            return values.map((x) => clean(x).toLowerCase().replace(/^https?:\/\/schema\.org\//i, '')).filter(Boolean);
          };
          const hasOwnMeaningful = (node, key) => {
            if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return false;
            const v = node[key];
            if (Array.isArray(v)) return v.length > 0;
            if (v && typeof v === 'object') return Object.keys(v).length > 0;
            return clean(v).length > 0;
          };
          const queryAllDeep = (selector) => {
            const out = [];
            const seen = new Set();
            const walk = (root, depth = 0) => {
              if (!root || depth > 6 || !root.querySelectorAll) return;
              Array.from(root.querySelectorAll(selector)).forEach((el) => {
                if (!el || seen.has(el)) return;
                seen.add(el);
                out.push(el);
              });
              Array.from(root.querySelectorAll('*')).forEach((el) => {
                if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
              });
            };
            walk(document, 0);
            return out;
          };
          const texts = queryAllDeep('script[type*="ld+json" i]')
            .map((s) => clean(s.textContent || ''))
            .filter(Boolean);
          let parseableCount = 0;
          let parseErrorsCount = 0;
          const types = [];
          const orgFieldPresence = { name: false, url: false, logo: false, sameAs: false, address: false, telephone: false };
          const contactPointFieldPresence = { telephone: false, email: false, contactType: false };
          const sameAsValues = [];
          const sameAsValuesByType = { organization: [], website: [], person: [] };
          let orgNodeObserved = false;
          let seoNodeObserved = false;
          const walk = (node, depth = 0) => {
            if (depth > 8 || node == null) return;
            if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
            if (typeof node !== 'object') return;
            const t = node['@type'];
            if (Array.isArray(t)) t.forEach((x) => types.push(clean(x)));
            else if (t) types.push(clean(t));
            const names = typeNames(node);
            const isOrg = names.some((x) => ['organization', 'corporation', 'localbusiness'].includes(x));
            const isWebsite = names.includes('website');
            const isPerson = names.includes('person');
            const isContactPoint = names.includes('contactpoint');
            if (isOrg || isWebsite || isPerson) seoNodeObserved = true;
            if (isOrg) {
              orgNodeObserved = true;
              Object.keys(orgFieldPresence).forEach((field) => {
                if (hasOwnMeaningful(node, field)) orgFieldPresence[field] = true;
              });
            }
            if (isContactPoint) {
              Object.keys(contactPointFieldPresence).forEach((field) => {
                if (hasOwnMeaningful(node, field)) contactPointFieldPresence[field] = true;
              });
            }
            const sameAs = node.sameAs;
            const sameAsList = Array.isArray(sameAs) ? sameAs : (sameAs ? [sameAs] : []);
            sameAsList.forEach((v) => {
              const s = clean(v);
              if (!/^https?:\/\//i.test(s)) return;
              sameAsValues.push(s);
              if (isOrg) sameAsValuesByType.organization.push(s);
              if (isWebsite) sameAsValuesByType.website.push(s);
              if (isPerson) sameAsValuesByType.person.push(s);
            });
            if (Array.isArray(node['@graph'])) node['@graph'].forEach((item) => walk(item, depth + 1));
          };
          texts.forEach((txt) => {
            try {
              walk(JSON.parse(txt), 0);
              parseableCount += 1;
            } catch (_) {
              parseErrorsCount += 1;
            }
          });
          return {
            renderedDomRawCount: texts.length,
            renderedDomParseableCount: parseableCount,
            renderedDomParseErrorsCount: parseErrorsCount,
            renderedDomTypes: Array.from(new Set(types.filter(Boolean))).slice(0, 20),
            organizationSummary: {
              observed: texts.length > 0,
              hasOrganization: orgNodeObserved,
              missingFields: orgNodeObserved ? Object.keys(orgFieldPresence).filter((field) => orgFieldPresence[field] !== true) : [],
              source: 'seo_jsonld'
            },
            sameAsSummary: {
              observed: texts.length > 0 && seoNodeObserved,
              count: Array.from(new Set(sameAsValues)).length,
              externalCount: Array.from(new Set(sameAsValues)).length,
              sameAsCountByType: {
                organization: Array.from(new Set(sameAsValuesByType.organization)).length,
                website: Array.from(new Set(sameAsValuesByType.website)).length,
                person: Array.from(new Set(sameAsValuesByType.person)).length
              },
              hasOrganizationSameAs: Array.from(new Set(sameAsValuesByType.organization)).length > 0,
              hasWebSiteSameAs: Array.from(new Set(sameAsValuesByType.website)).length > 0,
              hasPersonSameAs: Array.from(new Set(sameAsValuesByType.person)).length > 0,
              valuesSample: Array.from(new Set(sameAsValues)).slice(0, 8),
              source: 'seo_jsonld'
            },
            addressObserved: texts.length > 0 && orgNodeObserved,
            hasAddress: texts.length > 0 && orgNodeObserved ? orgFieldPresence.address === true : null,
            addressSource: 'seo_jsonld',
            contactPointObserved: texts.length > 0 && seoNodeObserved,
            hasContactPoint: types.some((x) => clean(x).toLowerCase().replace(/^https?:\/\/schema\.org\//i, '') === 'contactpoint'),
            contactPointMissingFields: types.some((x) => clean(x).toLowerCase().replace(/^https?:\/\/schema\.org\//i, '') === 'contactpoint')
              ? Object.keys(contactPointFieldPresence).filter((field) => contactPointFieldPresence[field] !== true)
              : [],
            contactPointSource: 'seo_jsonld',
            observed: true
          };
        }), 1200, 'structuredDataLight_renderedDom').catch((e) => Object.assign({}, emptyRendered, {
          error: String(e && (e.message || e) || '').slice(0, 180)
        }));
        const htmlSummary = await withTimeout(collectHtmlContentJsonLdSummaryLight(page), 1500, 'structuredDataLight_htmlContent').catch((e) => Object.assign({}, emptyHtml, {
          error: String(e && (e.message || e) || '').slice(0, 180)
        }));
        return {
          renderedDomRawCount: rendered.renderedDomRawCount,
          renderedDomParseableCount: rendered.renderedDomParseableCount,
          htmlContentRawCount: htmlSummary && htmlSummary.rawCount,
          htmlContentParseableCount: htmlSummary && htmlSummary.parseableCount,
          types: Array.from(new Set([].concat(rendered.renderedDomTypes || [], htmlSummary && htmlSummary.types || []).filter(Boolean))).slice(0, 20),
          parseErrorsCount: Number(rendered.renderedDomParseErrorsCount || 0) + Number(htmlSummary && htmlSummary.parseErrorsCount || 0),
          renderedDomObserved: rendered.observed === true,
          htmlContentObserved: !!(htmlSummary && htmlSummary.htmlContentLdJsonObserved),
          renderedOrganizationSummary: rendered.organizationSummary || null,
          htmlOrganizationSummary: htmlSummary && htmlSummary.organizationSummary || null,
          renderedSameAsSummary: rendered.sameAsSummary || null,
          htmlSameAsSummary: htmlSummary && htmlSummary.sameAsSummary || null,
          renderedTrustSummary: {
            addressObserved: rendered.addressObserved,
            hasAddress: rendered.hasAddress,
            addressSource: rendered.addressSource,
            contactPointObserved: rendered.contactPointObserved,
            hasContactPoint: rendered.hasContactPoint,
            contactPointMissingFields: rendered.contactPointMissingFields,
            contactPointSource: rendered.contactPointSource
          },
          htmlTrustSummary: htmlSummary ? {
            addressObserved: htmlSummary.addressObserved,
            hasAddress: htmlSummary.hasAddress,
            addressSource: htmlSummary.addressSource,
            contactPointObserved: htmlSummary.contactPointObserved,
            hasContactPoint: htmlSummary.hasContactPoint,
            contactPointMissingFields: htmlSummary.contactPointMissingFields,
            contactPointSource: htmlSummary.contactPointSource
          } : null,
          partialErrors: [rendered.error, htmlSummary && htmlSummary.error].filter(Boolean).slice(0, 4)
        };
      }, 3000);

      await runPhase('sameOriginScriptJsonLd', async () => {
        const summary = await collectSameOriginScriptSrcJsonLdSummaryLight(page, finalUrl || urlToFetch, {
          maxScripts: unifiedBalancedObserverProbe ? 5 : 3,
          maxBytesPerScript: unifiedBalancedObserverProbe ? 1000000 : 512000,
          requestTimeoutMs: unifiedBalancedObserverProbe ? 5000 : 3000
        });
        return {
          scriptSrcCount: summary.scriptSrcCount,
          sameOriginScriptCount: summary.sameOriginScriptCount,
          fetchedCount: summary.fetchedCount,
          skippedLargeCount: summary.skippedLargeCount,
          candidateCount: summary.candidateCount,
          types: Array.isArray(summary.types) ? summary.types.slice(0, 20) : [],
          appIndexDetected: !!summary.appIndexDetected,
          totalFetchedBytes: summary.totalFetchedBytes,
          maxScriptLength: summary.maxScriptLength,
          error: summary.error || null,
          fetchErrorsCount: summary.fetchErrorsCount || 0,
          fetchErrorsSample: Array.isArray(summary.fetchErrorsSample) ? summary.fetchErrorsSample.slice(0, 5) : []
        };
      }, unifiedBalancedObserverProbe ? 10000 : 5000);

      await runPhase('linksAndTrust', async () => page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const absUrl = (href) => {
          try { return new URL(href, location.href).toString(); } catch (_) { return clean(href); }
        };
        const uniqueBy = (items, keyFn, max) => {
          const out = [];
          const seen = new Set();
          (items || []).forEach((item) => {
            if (out.length >= max) return;
            const key = clean(keyFn(item)).toLowerCase();
            if (!key || seen.has(key)) return;
            seen.add(key);
            out.push(item);
          });
          return out;
        };
        const profileHostRe = /(?:^|\/\/|\.)(facebook\.com|instagram\.com|note\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com|tiktok\.com|wantedly\.com|github\.com)\b/i;
          const queryAllDeep = (selector) => {
            const out = [];
            const seen = new Set();
            const walk = (root, depth = 0) => {
              if (!root || depth > 6 || !root.querySelectorAll) return;
              Array.from(root.querySelectorAll(selector)).forEach((el) => {
                if (!el || seen.has(el)) return;
                seen.add(el);
                out.push(el);
              });
              Array.from(root.querySelectorAll('*')).forEach((el) => {
                if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
              });
            };
            walk(document, 0);
            return out;
          };
          const anchors = queryAllDeep('a[href]').map((a) => ({
            text: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title')).slice(0, 80),
            href: absUrl(a.getAttribute('href') || '').slice(0, 180),
            navLike: !!a.closest('nav,[role="navigation"],header,footer'),
            footerLike: !!a.closest('footer,[role="contentinfo"]'),
            source: 'dom'
          })).filter((a) => a.href);
          anchors.forEach((a) => {
            if (a.source === 'dom' && a.href) a.source = 'dom_or_open_shadow_dom';
          });
        const textHref = (a) => `${a.text} ${a.href}`.toLowerCase();
        const hasLike = (re) => anchors.length ? anchors.some((a) => re.test(textHref(a))) : null;
        const firstLike = (re) => {
          const hit = anchors.find((a) => re.test(textHref(a)));
          return hit ? { text: hit.text, href: hit.href, source: hit.source } : null;
        };
        const sourceFor = (v) => v === true ? 'dom' : (v === false ? 'not_observed' : 'not_observed');
        const companyLike = hasLike(/company|about|corporate|会社|企業|運営|概要/);
        const serviceLike = hasLike(/service|business|solution|plan|サービス|事業|料金|プラン/);
        const contactLike = hasLike(/contact|inquiry|support|お問い合わせ|問い合わせ|連絡|サポート/);
        const privacyLike = hasLike(/privacy|プライバシー|個人情報/);
        const faqRe = /(?:\bfaq\b|よくあるご?質問|q\s*&\s*a|q＆a|ヘルプ|help)/i;
        const faqLink = hasLike(faqRe);
        const faqNav = anchors.length ? anchors.some((a) => a.navLike && faqRe.test(textHref(a))) : null;
        const navTextItems = uniqueBy(
          anchors.filter((a) => a.navLike && a.text),
          (a) => a.text,
          50
        );
        const ctaIgnoreRe = /^(home|top|menu|close|prev|previous|next|share|facebook|instagram|x|twitter|youtube|line|linkedin|tiktok|ホーム|トップ|メニュー|閉じる|前へ|次へ|共有)$/i;
        const ctaCandidateRe = /(?:お問い合わせ|お問合せ|問い合わせ|相談|資料請求|見積|申し込|申込|購入|詳しく見る|詳細を見る|採用情報|エントリー|contact|inquiry|consult|request|quote|apply|entry|buy|purchase|learn more|read more|details)/i;
        const ctaTextFrom = (el) => {
          if (!el) return '';
          const tag = String(el.tagName || '').toLowerCase();
          const raw = tag === 'input'
            ? (el.getAttribute('value') || el.getAttribute('aria-label') || el.getAttribute('title') || '')
            : (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
          return clean(raw).slice(0, 80);
        };
        const ctaElements = queryAllDeep('a[href],button,[role="button"],input[type="submit"],input[type="button"]');
        const ctaItems = uniqueBy(
          ctaElements.map((el) => ({ text: ctaTextFrom(el), source: 'dom_or_open_shadow_dom' }))
            .filter((item) => item.text && item.text.length <= 80 && !ctaIgnoreRe.test(item.text) && ctaCandidateRe.test(item.text)),
          (item) => item.text,
          10
        );
        const internalItems = uniqueBy(
          anchors.filter((a) => {
            try { return new URL(a.href).origin === location.origin; } catch (_) { return false; }
          }),
          (a) => `${a.text} ${a.href}`,
          50
        );
        const externalProfileItems = uniqueBy(
          anchors.filter((a) => profileHostRe.test(a.href)),
          (a) => a.href,
          10
        );
        const footerAnchors = anchors.filter((a) => a.footerLike);
        const footerExternalProfileItems = uniqueBy(
          footerAnchors.filter((a) => profileHostRe.test(a.href)),
          (a) => a.href,
          10
        );
        const footerHay = footerAnchors.map((a) => `${a.text} ${a.href}`).join(' ').toLowerCase();
        const breadcrumbEl = queryAllDeep([
          '[aria-label*="breadcrumb" i]',
          '[class*="breadcrumb" i]',
          '[id*="breadcrumb" i]',
          'nav[aria-label*="パンくず" i]',
          '[class*="パンくず" i]'
        ].join(','))[0] || null;
        const breadcrumbText = clean(breadcrumbEl && (breadcrumbEl.innerText || breadcrumbEl.textContent));
        const faqSectionEl = queryAllDeep([
          'section[aria-label*="faq" i]',
          'section[aria-label*="よくある質問" i]',
          'section[id*="faq" i]',
          'section[class*="faq" i]',
          '[id*="faq" i]',
          '[class*="faq" i]'
        ].join(',')).find((el) => {
          const text = clean(el && (el.innerText || el.textContent)).slice(0, 200);
          return faqRe.test(text || '');
        }) || null;
        const faqHeadingEl = queryAllDeep('h1,h2,h3,h4,[role="heading"]').find((el) => {
          const text = clean(el && (el.innerText || el.textContent));
          return faqRe.test(text || '');
        }) || null;
        const faqSectionText = clean((faqSectionEl || faqHeadingEl) && ((faqSectionEl || faqHeadingEl).innerText || (faqSectionEl || faqHeadingEl).textContent));
        const footerObserved = footerAnchors.length > 0 || queryAllDeep('footer,[role="contentinfo"]').length > 0;
        return {
          anchorCount: anchors.length,
          rawNavAnchorCount: anchors.filter((a) => a.navLike).length,
          navLinkCount: navTextItems.length,
          internalLinkCount: internalItems.length,
          navTextsSample: navTextItems.map((a) => a.text),
          ctaTexts: ctaItems.map((item) => item.text),
          ctaCandidatesCount: ctaItems.length,
          ctaObserved: true,
          internalLinksSample: internalItems.map((a) => ({ text: a.text, href: a.href })),
          externalProfileLinksSample: externalProfileItems.map((a) => a.href).slice(0, 10),
          socialLinksSample: externalProfileItems.map((a) => a.href).slice(0, 10),
          footerExternalLinksSample: footerExternalProfileItems.map((a) => a.href).slice(0, 10),
          externalLinksSample: externalProfileItems.map((a) => a.href).slice(0, 10),
          hasCompanyLikeLink: companyLike,
          hasServiceLikeLink: serviceLike,
          hasContactLikeLink: contactLike,
          hasPrivacyLikeLink: privacyLike,
          contactLinkSource: sourceFor(contactLike),
          companyLinkSource: sourceFor(companyLike),
          serviceLinkSource: sourceFor(serviceLike),
          privacyLinkSource: sourceFor(privacyLike),
          contactLinkSample: firstLike(/contact|inquiry|support|お問い合わせ|問い合わせ|連絡|サポート/),
          companyLinkSample: firstLike(/company|about|corporate|会社|企業|運営|概要/),
          serviceLinkSample: firstLike(/service|business|solution|plan|サービス|事業|料金|プラン/),
          privacyLinkSample: firstLike(/privacy|プライバシー|個人情報/),
          hasFaqLink: faqLink,
          hasFaqNav: faqNav,
          faqLinkSource: sourceFor(faqLink),
          faqLinkSample: firstLike(faqRe),
          hasFaqSection: !!(faqSectionEl || faqHeadingEl),
          faqSectionSource: (faqSectionEl || faqHeadingEl) ? 'dom_heading_or_section' : 'not_observed',
          faqSectionTextSample: faqSectionText ? faqSectionText.slice(0, 120) : '',
          breadcrumbUiObserved: true,
          hasBreadcrumbUi: !!breadcrumbEl,
          breadcrumbUiSource: 'dom_scan',
          breadcrumbUiTextSample: breadcrumbText ? breadcrumbText.slice(0, 120) : '',
          footerSignals: {
            observed: footerObserved,
            linkCount: footerObserved ? footerAnchors.length : null,
            hasPrivacyLink: footerObserved ? /privacy|プライバシー|個人情報/.test(footerHay) : null,
            hasCompanyLink: footerObserved ? /company|about|corporate|会社|企業|運営|概要/.test(footerHay) : null,
            hasCompanyProfileLink: footerObserved ? /company|about|corporate|profile|会社概要|企業情報|会社情報|企業|運営|概要/.test(footerHay) : null,
            hasContactLink: footerObserved ? /contact|inquiry|support|お問い合わせ|問い合わせ|連絡|サポート/.test(footerHay) : null,
            hasTermsLink: footerObserved ? /terms|legal|law|特定商取引|利用規約|規約|法務/.test(footerHay) : null,
            sampleTexts: footerAnchors.map((a) => a.text).filter(Boolean).slice(0, 8),
            externalProfileLinksSample: footerExternalProfileItems.map((a) => a.href).slice(0, 10),
            socialLinksSample: footerExternalProfileItems.map((a) => a.href).slice(0, 10),
            footerExternalLinksSample: footerExternalProfileItems.map((a) => a.href).slice(0, 10),
            source: 'dom_footer_scan'
          },
          shadowAnchorCount: anchors.filter((a) => a.source === 'dom_or_open_shadow_dom').length
        };
      }), 3000);

      await runPhase('multimodal', async () => page.evaluate(() => {
        const has = (sel) => !!document.querySelector(sel);
        const queryAllDeep = (selector) => {
          const out = [];
          const seen = new Set();
          const walk = (root, depth = 0) => {
            if (!root || depth > 6 || !root.querySelectorAll) return;
            Array.from(root.querySelectorAll(selector)).forEach((el) => {
              if (!el || seen.has(el)) return;
              seen.add(el);
              out.push(el);
            });
            Array.from(root.querySelectorAll('*')).forEach((el) => {
              if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
            });
          };
          walk(document, 0);
          return out;
        };
        return {
          hasOgImage: has('meta[property="og:image"],meta[property="og:image:url"],meta[property="og:image:secure_url"]'),
          hasTwitterImage: has('meta[name="twitter:image"],meta[name="twitter:image:src"]'),
          hasFavicon: has('link[rel~="icon"][href],link[rel="shortcut icon"][href]'),
          hasAppleTouchIcon: has('link[rel~="apple-touch-icon"][href],link[rel="apple-touch-icon-precomposed"][href]'),
          imgCount: queryAllDeep('img').length
        };
      }), unifiedBalancedObserverProbe ? 1000 : 3000);

      await runPhase('aioCheck', async () => collectAioCheckSummaryLight(finalUrl || urlToFetch), 2500);

      await runPhase('headingsLight', async () => page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const queryAllDeep = (selector) => {
          const out = [];
          const seen = new Set();
          const walk = (root, depth = 0) => {
            if (!root || depth > 6 || !root.querySelectorAll) return;
            Array.from(root.querySelectorAll(selector)).forEach((el) => {
              if (!el || seen.has(el)) return;
              seen.add(el);
              out.push(el);
            });
            Array.from(root.querySelectorAll('*')).forEach((el) => {
              if (el && el.shadowRoot) walk(el.shadowRoot, depth + 1);
            });
          };
          walk(document, 0);
          return out;
        };
        const texts = (sel, max) => queryAllDeep(sel).map((el) => clean(el.innerText || el.textContent)).filter(Boolean).slice(0, max);
        const h1 = texts('h1', 5);
        const h2 = texts('h2', 10);
        const h3 = texts('h3', 10);
        const title = clean(document.title || '');
        return {
          h1Count: h1.length,
          h2Count: h2.length,
          h3Count: h3.length,
          h1Source: h1.length ? 'dom' : 'not_observed',
          primaryHeadingCandidate: h1[0] || title || '',
          primaryHeadingCandidateSource: h1[0] ? 'dom_h1' : (title ? 'title' : 'not_observed'),
          h1EquivalentCandidateFound: false,
          headingTextsSample: h1.concat(h2).concat(h3).slice(0, 10)
        };
      }), unifiedBalancedObserverProbe ? 2000 : 3000);

      await runPhase('landmarksLight', async () => page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const main = document.querySelector('main');
        const roleMain = !main ? document.querySelector('[role="main"]') : null;
        const confirmedMain = main || roleMain;
        const appCandidate = document.querySelector('#main,#main-content,#app,#root,#__next,[data-reactroot],app-index,[id*="app" i],[id*="content" i]');
        return {
          hasMainLandmark: confirmedMain ? true : null,
          hasMainLandmark_final: confirmedMain ? true : null,
          mainLandmarkSource: main ? 'dom_main_light' : (roleMain ? 'dom_role_main_light' : 'not_observed'),
          mainLandmarkCandidateFound: !confirmedMain && !!appCandidate,
          mainLandmarkCandidateSource: !confirmedMain && appCandidate ? 'dom_app_candidate_light' : 'not_observed',
          mainLandmarkCandidateTextLength: appCandidate ? clean(appCandidate.innerText || appCandidate.textContent).length : 0
        };
      }), unifiedBalancedObserverProbe ? 2000 : 3000);

      await runPhase('optionalEnhancedShadow', async () => {
        if (!unifiedBalancedObserverProbe) {
          return {
            skipped: true,
            reason: 'not_unified_balanced_observer_probe'
          };
        }
        return page.evaluate(() => {
          const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
          const out = {
            skipped: false,
            limited: true,
            shadowHostCount: 0,
            shadowAnchorCount: 0,
            shadowHeadingCount: 0,
            shadowHeadingTexts: [],
            shadowNavTextsSample: []
          };
          const seenNav = new Set();
          const walk = (root, depth = 0) => {
            if (!root || depth > 2 || out.shadowHostCount > 80) return;
            const nodes = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
            nodes.forEach((el) => {
              if (!el) return;
              if (el.shadowRoot) {
                out.shadowHostCount += 1;
                walk(el.shadowRoot, depth + 1);
              }
              const tag = String(el.tagName || '').toLowerCase();
              if (/^h[1-3]$/.test(tag)) {
                const text = clean(el.innerText || el.textContent);
                if (text && out.shadowHeadingTexts.length < 12) out.shadowHeadingTexts.push(text.slice(0, 160));
                out.shadowHeadingCount += 1;
              }
              if (tag === 'a' && el.getAttribute && el.getAttribute('href')) {
                out.shadowAnchorCount += 1;
                const navLike = !!el.closest('nav,[role="navigation"],header,footer');
                const text = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
                if (navLike && text && !seenNav.has(text) && out.shadowNavTextsSample.length < 10) {
                  seenNav.add(text);
                  out.shadowNavTextsSample.push(text.slice(0, 100));
                }
              }
            });
          };
          try { walk(document, 0); } catch (_) {}
          return out;
        });
      }, 2000);

      await runPhase('optionalA11y', async () => {
        if (!unifiedBalancedObserverProbe) {
          return {
            skipped: true,
            reason: 'not_unified_balanced_observer_probe'
          };
        }
        const headings = await page.getByRole('heading').evaluateAll((els) => els.slice(0, 20).map((el) => ({
          text: String(el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          ariaLevel: el && el.getAttribute ? el.getAttribute('aria-level') : null,
          tagName: String(el && el.tagName || '').toLowerCase()
        }))).catch(() => []);
        const mainCount = await page.getByRole('main').count().catch(() => null);
        return {
          skipped: false,
          limited: true,
          headingCount: Array.isArray(headings) ? headings.length : 0,
          headings: Array.isArray(headings) ? headings.filter((h) => h && h.text).slice(0, 10) : [],
          mainCount
        };
      }, 2000);

      await runPhase('buildShortPayload', async () => {
        const phaseSummary = {};
        phases.forEach((p) => {
          phaseSummary[p.name] = {
            ok: p.ok,
            elapsedMs: p.elapsedMs,
            errorMessage: p.errorMessage || ''
          };
        });
        return {
          phaseCount: phases.length + 1,
          failedPhaseNames: phases.filter((p) => !p.ok).map((p) => p.name),
          phaseSummary
        };
      }, 1000);

      const phaseByName = (name) => phases.find((p) => p && p.name === name) || {};
      const phaseResult = (name) => {
        const phase = phaseByName(name);
        return phase && phase.minimalResult && typeof phase.minimalResult === 'object' ? phase.minimalResult : {};
      };
      const hydrationGuardedWait = phaseResult('hydrationGuardedWait');
      const headMeta = phaseResult('headMetaEval');
      const basicDomRaw = phaseResult('basicDomEval');
      const gotoProbe = (gotoPartialRecovery && typeof gotoPartialRecovery === 'object') ? gotoPartialRecovery : {};
      const basicDom = Object.assign({}, basicDomRaw, {
        title: basicDomRaw.title || headMeta.title || gotoProbe.title || '',
        metaDescription: basicDomRaw.metaDescription || headMeta.metaDescription || gotoProbe.metaDescription || '',
        metaDescriptionLength: Number(basicDomRaw.metaDescriptionLength || headMeta.metaDescriptionLength || gotoProbe.metaDescriptionLength || 0),
        bodyTextLength: typeof basicDomRaw.bodyTextLength === 'number'
          ? basicDomRaw.bodyTextLength
          : (typeof gotoProbe.bodyTextLength === 'number' ? gotoProbe.bodyTextLength : basicDomRaw.bodyTextLength),
        anchorCount: typeof basicDomRaw.anchorCount === 'number'
          ? basicDomRaw.anchorCount
          : (typeof gotoProbe.anchorCount === 'number' ? gotoProbe.anchorCount : basicDomRaw.anchorCount)
      });
      const structuredLight = phaseResult('structuredDataLight');
      const scriptJsonLd = phaseResult('sameOriginScriptJsonLd');
      const linksTrust = phaseResult('linksAndTrust');
      const multimodal = phaseResult('multimodal');
      const aioCheck = phaseResult('aioCheck');
      const headingsLight = phaseResult('headingsLight');
      const landmarksLight = phaseResult('landmarksLight');
      const enhancedShadow = phaseResult('optionalEnhancedShadow');
      const optionalA11y = phaseResult('optionalA11y');
      const unifiedBodyTextLength = Math.max(
        Number(basicDom.bodyTextLength || 0),
        Number(hydrationGuardedWait.bodyTextAfterWait || 0)
      );
      const unifiedBodyTextSample = typeof basicDom.bodyTextSample === 'string' && basicDom.bodyTextSample.trim()
        ? basicDom.bodyTextSample.replace(/\s+/g, ' ').trim().slice(0, 800)
        : '';
      const mainLandmarkFinal = Object.prototype.hasOwnProperty.call(landmarksLight, 'hasMainLandmark_final') && landmarksLight.hasMainLandmark_final != null
        ? landmarksLight.hasMainLandmark_final
        : null;
      const mainLandmarkSource = mainLandmarkFinal === true
        ? (landmarksLight.mainLandmarkSource && landmarksLight.mainLandmarkSource !== 'not_observed'
          ? landmarksLight.mainLandmarkSource
          : 'not_observed')
        : (landmarksLight.mainLandmarkSource || 'not_observed');
      const mainLandmarkConfidence = mainLandmarkFinal === true ? 'high' : 'low';
      const headMetaPhase = phaseByName('headMetaEval');
      const structuredDataPhase = phaseByName('structuredDataLight');
      const sameOriginScriptJsonLdPhase = phaseByName('sameOriginScriptJsonLd');
      const phaseStatuses = phases.map((p) => ({
        name: p.name,
        ok: !!p.ok,
        skipped: !!(p.minimalResult && p.minimalResult.skipped),
        limited: !!(p.minimalResult && p.minimalResult.limited),
        elapsedMs: p.elapsedMs,
        errorMessage: p.errorMessage || ''
      }));
      const observationLimitedByPhase = phaseStatuses
        .filter((p) => !p.ok || p.skipped || p.limited)
        .map((p) => ({
          phase: p.name,
          reason: p.errorMessage || (p.skipped ? 'skipped' : (p.limited ? 'limited' : 'not_ok'))
        }));
      const mergedTypes = Array.from(new Set([]
        .concat(Array.isArray(structuredLight.types) ? structuredLight.types : [])
        .concat(Array.isArray(scriptJsonLd.types) ? scriptJsonLd.types : [])
        .filter(Boolean)
      )).slice(0, 50);
      const mergedTypeClass = classifyJsonLdTypesForSeo(mergedTypes);
      const structuredDataPhaseDebug = {
        phaseOk: !!(structuredDataPhase && structuredDataPhase.ok),
        phaseElapsedMs: structuredDataPhase && typeof structuredDataPhase.elapsedMs === 'number' ? structuredDataPhase.elapsedMs : null,
        phaseErrorMessage: structuredDataPhase && structuredDataPhase.errorMessage ? structuredDataPhase.errorMessage : '',
        renderedDomRawCount: typeof structuredLight.renderedDomRawCount === 'number' ? structuredLight.renderedDomRawCount : null,
        renderedDomParseableCount: typeof structuredLight.renderedDomParseableCount === 'number' ? structuredLight.renderedDomParseableCount : null,
        htmlContentRawCount: typeof structuredLight.htmlContentRawCount === 'number' ? structuredLight.htmlContentRawCount : null,
        htmlContentParseableCount: typeof structuredLight.htmlContentParseableCount === 'number' ? structuredLight.htmlContentParseableCount : null,
        jsonldTypes: Array.isArray(structuredLight.types) ? structuredLight.types.slice(0, 30) : [],
        parseErrorsCount: Number(structuredLight.parseErrorsCount || 0),
        timedOut: !!(structuredDataPhase && /timeout/i.test(String(structuredDataPhase.errorMessage || ''))),
        partialErrors: Array.isArray(structuredLight.partialErrors) ? structuredLight.partialErrors.slice(0, 4) : [],
        resultWasEmpty: !structuredLight || (
          Number(structuredLight.renderedDomRawCount || 0) === 0 &&
          Number(structuredLight.htmlContentRawCount || 0) === 0 &&
          !(Array.isArray(structuredLight.types) && structuredLight.types.length)
        )
      };
      const sameOriginScriptJsonLdPhaseDebug = {
        phaseOk: !!(sameOriginScriptJsonLdPhase && sameOriginScriptJsonLdPhase.ok),
        phaseElapsedMs: sameOriginScriptJsonLdPhase && typeof sameOriginScriptJsonLdPhase.elapsedMs === 'number' ? sameOriginScriptJsonLdPhase.elapsedMs : null,
        phaseErrorMessage: sameOriginScriptJsonLdPhase && sameOriginScriptJsonLdPhase.errorMessage ? sameOriginScriptJsonLdPhase.errorMessage : '',
        scriptSrcCount: Number(scriptJsonLd.scriptSrcCount || 0),
        sameOriginScriptCount: Number(scriptJsonLd.sameOriginScriptCount || 0),
        fetchedCount: Number(scriptJsonLd.fetchedCount || 0),
        skippedLargeCount: Number(scriptJsonLd.skippedLargeCount || 0),
        candidateCount: Number(scriptJsonLd.candidateCount || 0),
        jsonldTypes: Array.isArray(scriptJsonLd.types) ? scriptJsonLd.types.slice(0, 30) : [],
        appIndexDetected: !!scriptJsonLd.appIndexDetected,
        totalFetchedBytes: Number(scriptJsonLd.totalFetchedBytes || 0),
        maxScriptLength: Number(scriptJsonLd.maxScriptLength || 0),
        timedOut: !!(sameOriginScriptJsonLdPhase && /timeout/i.test(String(sameOriginScriptJsonLdPhase.errorMessage || ''))),
        resultWasEmpty: !scriptJsonLd || (
          Number(scriptJsonLd.candidateCount || 0) === 0 &&
          !(Array.isArray(scriptJsonLd.types) && scriptJsonLd.types.length)
        ),
        fetchErrorsCount: Number(scriptJsonLd.fetchErrorsCount || 0),
        fetchErrorsSample: Array.isArray(scriptJsonLd.fetchErrorsSample) ? scriptJsonLd.fetchErrorsSample.slice(0, 5) : []
      };
      const structuredObserved = structuredLight.renderedDomObserved === true || structuredLight.htmlContentObserved === true || !!(structuredDataPhase && structuredDataPhase.ok);
      const scriptObserved = !!(sameOriginScriptJsonLdPhase && sameOriginScriptJsonLdPhase.ok) || typeof scriptJsonLd.sameOriginScriptCount === 'number';
      const jsonLdRawCount = (typeof structuredLight.renderedDomRawCount === 'number' ? structuredLight.renderedDomRawCount : 0) +
        (typeof structuredLight.htmlContentRawCount === 'number' ? structuredLight.htmlContentRawCount : 0) +
        (typeof scriptJsonLd.candidateCount === 'number' ? scriptJsonLd.candidateCount : 0);
      const jsonLdParseableCount = (typeof structuredLight.renderedDomParseableCount === 'number' ? structuredLight.renderedDomParseableCount : 0) +
        (typeof structuredLight.htmlContentParseableCount === 'number' ? structuredLight.htmlContentParseableCount : 0);
      const hasJsonLdObserved = structuredObserved || scriptObserved;
      const mergeOrganizationSummary = (items, hasObserved) => {
        const summaries = (Array.isArray(items) ? items : []).filter((s) => s && typeof s === 'object');
        const hasOrganization = mergedTypeClass.hasOrganization === true || summaries.some((s) => s.hasOrganization === true);
        const missing = [];
        summaries.forEach((s) => {
          if (Array.isArray(s.missingFields)) {
            s.missingFields.forEach((field) => {
              const v = String(field || '').trim();
              if (v && !missing.includes(v)) missing.push(v);
            });
          }
        });
        return {
          observed: hasObserved ? true : null,
          hasOrganization: hasObserved ? hasOrganization : null,
          missingFields: hasOrganization ? missing.slice(0, 12) : [],
          source: 'seo_jsonld'
        };
      };
      const mergeSameAsSummary = (items, hasObserved) => {
        const values = [];
        let observed = false;
        (Array.isArray(items) ? items : []).forEach((s) => {
          if (!s || typeof s !== 'object') return;
          if (s.observed === true) observed = true;
          if (Array.isArray(s.valuesSample)) s.valuesSample.forEach((v) => values.push(String(v || '').trim()));
        });
        const unique = Array.from(new Set(values.filter(Boolean))).slice(0, 20);
        const countByType = { organization: 0, website: 0, person: 0 };
        (Array.isArray(items) ? items : []).forEach((s) => {
          if (!s || typeof s !== 'object' || !s.sameAsCountByType || typeof s.sameAsCountByType !== 'object') return;
          countByType.organization = Math.max(countByType.organization, Number(s.sameAsCountByType.organization || 0));
          countByType.website = Math.max(countByType.website, Number(s.sameAsCountByType.website || 0));
          countByType.person = Math.max(countByType.person, Number(s.sameAsCountByType.person || 0));
        });
        const canObserve = hasObserved && (observed || mergedTypeClass.hasSeoJsonLd === true);
        return {
          observed: canObserve ? true : null,
          count: canObserve ? unique.length : null,
          externalCount: canObserve ? unique.length : null,
          sameAsCountByType: canObserve ? countByType : null,
          hasOrganizationSameAs: canObserve ? countByType.organization > 0 : null,
          hasWebSiteSameAs: canObserve ? countByType.website > 0 : null,
          hasPersonSameAs: canObserve ? countByType.person > 0 : null,
          valuesSample: unique.slice(0, 8),
          source: 'seo_jsonld'
        };
      };
      const mergeTrustStructuredSummary = (items) => {
        const summaries = (Array.isArray(items) ? items : []).filter((s) => s && typeof s === 'object');
        const pickBool = (key) => {
          for (const s of summaries) {
            if (typeof s[key] === 'boolean') return s[key];
          }
          return null;
        };
        const missing = [];
        summaries.forEach((s) => {
          if (Array.isArray(s.contactPointMissingFields)) {
            s.contactPointMissingFields.forEach((field) => {
              const v = String(field || '').trim();
              if (v && !missing.includes(v)) missing.push(v);
            });
          }
        });
        const addressObserved = pickBool('addressObserved');
        const contactPointObserved = pickBool('contactPointObserved');
        return {
          addressObserved,
          hasAddress: addressObserved === true ? pickBool('hasAddress') : null,
          addressSource: 'seo_jsonld',
          contactPointObserved,
          hasContactPoint: contactPointObserved === true ? pickBool('hasContactPoint') : null,
          contactPointMissingFields: missing.slice(0, 8),
          contactPointSource: 'seo_jsonld'
        };
      };
      const organizationSummary = mergeOrganizationSummary([
        structuredLight.renderedOrganizationSummary,
        structuredLight.htmlOrganizationSummary
      ], hasJsonLdObserved);
      const sameAsSummary = mergeSameAsSummary([
        structuredLight.renderedSameAsSummary,
        structuredLight.htmlSameAsSummary
      ], hasJsonLdObserved);
      const structuredTrustSummary = mergeTrustStructuredSummary([
        structuredLight.renderedTrustSummary,
        structuredLight.htmlTrustSummary
      ]);
      const structuredDataLight = {
        types: mergedTypes,
        seoTypes: mergedTypeClass.seoTypes,
        nonSeoTypes: mergedTypeClass.nonSeoTypes,
        telemetryTypes: mergedTypeClass.telemetryTypes,
        excludedFromSeoTypes: mergedTypeClass.excludedFromSeoTypes,
        rawCount: hasJsonLdObserved ? jsonLdRawCount : null,
        parseableCount: hasJsonLdObserved ? jsonLdParseableCount : null,
        hasJsonLd: hasJsonLdObserved ? (mergedTypes.length > 0 || jsonLdRawCount > 0) : null,
        hasSeoJsonLd: hasJsonLdObserved ? mergedTypeClass.hasSeoJsonLd : null,
        hasWebsite: hasJsonLdObserved ? mergedTypeClass.hasWebsite : null,
        hasOrganization: hasJsonLdObserved ? mergedTypeClass.hasOrganization : null,
        hasBreadcrumbList: hasJsonLdObserved ? mergedTypeClass.hasBreadcrumbList : null,
        hasFAQPage: hasJsonLdObserved ? mergedTypeClass.hasFAQPage : null,
        breadcrumbObserved: hasJsonLdObserved ? true : null,
        breadcrumbMissing: hasJsonLdObserved ? !mergedTypeClass.hasBreadcrumbList : null,
        organizationSummary,
        sameAsSummary,
        typeClassificationSource: mergedTypeClass.typeClassificationSource,
        source: 'shortfast_phase_builder',
        confidence: 'medium',
        observationLimited: true,
        observationScope: 'rendered_dom_plus_html_ldjson_plus_script_src_jsonld_only',
        renderedDomObserved: structuredLight.renderedDomObserved === true,
        renderedDomRawCount: typeof structuredLight.renderedDomRawCount === 'number' ? structuredLight.renderedDomRawCount : null,
        renderedDomParseableCount: typeof structuredLight.renderedDomParseableCount === 'number' ? structuredLight.renderedDomParseableCount : null,
        htmlContentLdJsonObserved: structuredLight.htmlContentObserved === true,
        htmlContentRawCount: typeof structuredLight.htmlContentRawCount === 'number' ? structuredLight.htmlContentRawCount : null,
        htmlContentParseableCount: typeof structuredLight.htmlContentParseableCount === 'number' ? structuredLight.htmlContentParseableCount : null,
        scriptSrcJsonLdObserved: scriptObserved,
        scriptSrcCandidateCount: typeof scriptJsonLd.sameOriginScriptCount === 'number' ? scriptJsonLd.sameOriginScriptCount : null,
        scriptSrcFetchedCount: typeof scriptJsonLd.fetchedCount === 'number' ? scriptJsonLd.fetchedCount : null,
        scriptSrcJsonLdCandidateCount: typeof scriptJsonLd.candidateCount === 'number' ? scriptJsonLd.candidateCount : null,
        scriptSrcJsonLdTypes: Array.isArray(scriptJsonLd.types) ? scriptJsonLd.types.slice(0, 50) : [],
        scriptSrcSkippedLargeCount: Number(scriptJsonLd.skippedLargeCount || 0),
        scriptSrcAppIndexDetected: !!scriptJsonLd.appIndexDetected,
        htmlScanSkipped: true,
        jsScanSkipped: true,
        chunkScanSkipped: true,
        parseErrorsCount: Number(structuredLight.parseErrorsCount || 0),
        scriptSrcError: scriptJsonLd.error || null
      };
      const articleSignals = await collectArticleSignalsFromPageLight_(page, finalUrl || urlToFetch);
      console.log('[DEBUG][ARTICLE_SIGNALS_AUDIT]', JSON.stringify({
        checked: articleSignals.checked === true,
        hasArticleType: articleSignals.summary && articleSignals.summary.hasArticleType,
        hasHeadline: articleSignals.summary && articleSignals.summary.hasHeadline,
        hasPublishedDate: articleSignals.summary && articleSignals.summary.hasPublishedDate,
        hasModifiedDate: articleSignals.summary && articleSignals.summary.hasModifiedDate,
        hasAuthor: articleSignals.summary && articleSignals.summary.hasAuthor,
        hasPublisher: articleSignals.summary && articleSignals.summary.hasPublisher,
        jsonLdTypes: articleSignals.jsonLd && Array.isArray(articleSignals.jsonLd.types) ? articleSignals.jsonLd.types : [],
        metaKeys: articleSignals.meta ? Object.keys(articleSignals.meta).filter(key => {
          const value = articleSignals.meta[key];
          return Array.isArray(value) ? value.length > 0 : !!value;
        }) : []
      }));
      const linksObserved = !!(phaseByName('linksAndTrust') && phaseByName('linksAndTrust').ok) || typeof linksTrust.anchorCount === 'number';
      const multimodalObserved = !!(phaseByName('multimodal') && phaseByName('multimodal').ok) || typeof multimodal.imgCount === 'number';
      const linkNumber = (key) => linksObserved && typeof linksTrust[key] === 'number' ? Number(linksTrust[key]) : null;
      const linkBoolean = (key) => linksObserved && Object.prototype.hasOwnProperty.call(linksTrust, key) ? linksTrust[key] : null;
      const multimodalImage = multimodal && multimodal.image && typeof multimodal.image === 'object' ? multimodal.image : {};
      const multimodalBoolean = (key) => {
        if (!multimodalObserved) return null;
        if (Object.prototype.hasOwnProperty.call(multimodal, key)) return !!multimodal[key];
        if (Object.prototype.hasOwnProperty.call(multimodalImage, key)) return !!multimodalImage[key];
        return null;
      };
      const multimodalNumber = (key) => {
        if (!multimodalObserved) return null;
        if (typeof multimodal[key] === 'number') return Number(multimodal[key]);
        if (typeof multimodalImage[key] === 'number') return Number(multimodalImage[key]);
        return null;
      };
      const multimodalString = (key) => multimodalObserved ? String(multimodal[key] || multimodalImage[key] || '').trim() : '';
      const ogImageUrl = multimodalString('ogImageUrl');
      const twitterImageUrl = multimodalString('twitterImageUrl');
      const faviconUrl = multimodalString('faviconUrl');
      const appleTouchIconUrl = multimodalString('appleTouchIconUrl');
      const geoThemeSignals = collectGeoThemeSignalsLight_({
        bodyTextSample: unifiedBodyTextSample,
        headings: []
          .concat(Array.isArray(headingsLight.headingTextsSample) ? headingsLight.headingTextsSample : [])
          .concat(Array.isArray(enhancedShadow.shadowHeadingTexts) ? enhancedShadow.shadowHeadingTexts : [])
          .concat(Array.isArray(optionalA11y.headings) ? optionalA11y.headings.map((h) => h && h.text).filter(Boolean) : []),
        navTexts: Array.isArray(linksTrust.navTextsSample) ? linksTrust.navTextsSample : []
      });
      const geoSignalsV1 = {
        version: 'geoSignalsV1',
        generatedAt: new Date().toISOString(),
        url: String(finalUrl || urlToFetch || ''),
        structuredData: structuredDataLight,
        articleSignals,
        geoThemeSignals,
        headings: {
          h1Count: Number(headingsLight.h1Count || 0),
          h2Count: Number(headingsLight.h2Count || 0),
          h3Count: Number(headingsLight.h3Count || 0),
          hasH1: Number(headingsLight.h1Count || 0) > 0,
          hasSingleH1: Number(headingsLight.h1Count || 0) === 1,
          h1Texts: [],
          headingTexts: Array.from(new Set([]
            .concat(Array.isArray(headingsLight.headingTextsSample) ? headingsLight.headingTextsSample : [])
            .concat(Array.isArray(enhancedShadow.shadowHeadingTexts) ? enhancedShadow.shadowHeadingTexts : [])
            .concat(Array.isArray(optionalA11y.headings) ? optionalA11y.headings.map((h) => h && h.text).filter(Boolean) : [])
          )).slice(0, 12),
          primaryHeadingCandidate: headingsLight.primaryHeadingCandidate || basicDom.title || '',
          primaryHeadingCandidateSource: headingsLight.primaryHeadingCandidateSource || (basicDom.title ? 'title' : 'not_observed'),
          primaryHeadingConfidence: headingsLight.primaryHeadingCandidate ? 'low' : 'low',
          h1EquivalentCandidateFound: !!headingsLight.h1EquivalentCandidateFound,
          sectionHeadingCandidate: '',
          sectionHeadingCandidateSource: 'not_observed',
          sectionHeadingConfidence: 'low',
          source: Number(headingsLight.h1Count || 0) > 0 ? 'dom' : 'dom_light',
          h1Source: headingsLight.h1Source || 'not_observed',
          headingObservationLimited: Number(headingsLight.h1Count || 0) === 0,
          excludedHeadingCount: 0,
          excludedHeadingReasons: [],
          a11yObserved: false
        },
        balanced: {
          enabled: true,
          shortFastDedicatedPath: true,
          observer: unifiedBalancedObserverProbe ? 'unified' : undefined,
          phaseGuarded: !!unifiedBalancedObserverProbe,
          shadowHeadingScan: !!unifiedBalancedObserverProbe,
          shadowHeadingObserved: Number(enhancedShadow.shadowHeadingCount || 0) > 0,
          shadowHostCount: Number(enhancedShadow.shadowHostCount || 0),
          shadowH1Texts: [],
          shadowH2Texts: Array.isArray(enhancedShadow.shadowHeadingTexts) ? enhancedShadow.shadowHeadingTexts.slice(0, 5) : [],
          primaryHeadingCandidate: headingsLight.primaryHeadingCandidate || basicDom.title || '',
          primaryHeadingCandidateSource: headingsLight.primaryHeadingCandidateSource || (basicDom.title ? 'title' : 'not_observed'),
          primaryHeadingConfidence: 'low',
          h1EquivalentCandidateFound: !!headingsLight.h1EquivalentCandidateFound,
          boundedWaitMs: unifiedBalancedObserverProbe ? Number(hydrationGuardedWait.waitMs || 0) : 0,
          hydration: {
            waitMs: unifiedBalancedObserverProbe ? Number(hydrationGuardedWait.waitMs || 0) : 0,
            bodyTextBeforeWait: unifiedBalancedObserverProbe && typeof hydrationGuardedWait.bodyTextBeforeWait === 'number' ? hydrationGuardedWait.bodyTextBeforeWait : Number(basicDom.bodyTextLength || 0),
            bodyTextAfterWait: unifiedBodyTextLength,
            anchorCountBeforeWait: unifiedBalancedObserverProbe && typeof hydrationGuardedWait.anchorCountBeforeWait === 'number' ? hydrationGuardedWait.anchorCountBeforeWait : Number(basicDom.anchorCount || 0),
            anchorCountAfterWait: Number(basicDom.anchorCount || 0),
            navLinkCountBeforeWait: Number(linksTrust.navLinkCount || 0),
            navLinkCountAfterWait: Number(linksTrust.navLinkCount || 0),
            improvedBodyText: !!(unifiedBalancedObserverProbe && hydrationGuardedWait.hydrationImprovedBodyText),
            improvedLinks: !!(unifiedBalancedObserverProbe && hydrationGuardedWait.hydrationImprovedLinks)
          },
          h1Attempts: {
            dom: { count: Number(headingsLight.h1Count || 0), source: 'dom_light' },
            a11y: unifiedBalancedObserverProbe
              ? { count: Number(optionalA11y.headingCount || 0), observed: true, limited: !!optionalA11y.limited, source: 'a11y_role_heading_light' }
              : { count: 0, observed: false, error: 'skipped_shortfast_dedicated_path', source: 'a11y' },
            iframeSameOrigin: { count: 0, iframeCount: 0, accessibleCount: 0, blockedCount: 0, source: 'iframe_same_origin' }
          }
        },
        landmarks: {
          hasMainLandmark: Object.prototype.hasOwnProperty.call(landmarksLight, 'hasMainLandmark') ? landmarksLight.hasMainLandmark : null,
          hasMainLandmark_final: mainLandmarkFinal,
          mainLandmarkSource,
          mainLandmarkConfidence,
          mainLandmarkTextsSample: [],
          mainLandmarkCandidateFound: !!landmarksLight.mainLandmarkCandidateFound,
          mainLandmarkCandidateSource: landmarksLight.mainLandmarkCandidateSource || 'not_observed',
          mainLandmarkCandidateConfidence: landmarksLight.mainLandmarkCandidateFound ? 'low' : 'low',
          mainLandmarkCandidateTextsSample: [],
          mainLandmarkObservationLimited: mainLandmarkFinal !== true,
          a11yObserved: !!unifiedBalancedObserverProbe,
          a11yMainCount: unifiedBalancedObserverProbe && typeof optionalA11y.mainCount === 'number' ? optionalA11y.mainCount : 0
        },
        multimodalSignals: {
          checked: multimodalObserved,
          hasImage: multimodalObserved ? !!(multimodal.hasOgImage || multimodal.hasTwitterImage || multimodal.hasFavicon || multimodal.hasAppleTouchIcon || ogImageUrl || twitterImageUrl || faviconUrl || appleTouchIconUrl || Number(multimodal.imgCount || multimodalImage.imageCount || 0) > 0) : null,
          hasStructured: null,
          hasOgImage: multimodalBoolean('hasOgImage') === true || !!ogImageUrl,
          ogImageUrl,
          hasTwitterImage: multimodalBoolean('hasTwitterImage') === true || !!twitterImageUrl,
          twitterImageUrl,
          hasFavicon: multimodalBoolean('hasFavicon') === true || !!faviconUrl,
          faviconUrl,
          hasAppleTouchIcon: multimodalBoolean('hasAppleTouchIcon') === true || !!appleTouchIconUrl,
          appleTouchIconUrl,
          hasStructuredLogo: null,
          imageObjectCount: null,
          structuredImageCount: null,
          imgCount: multimodalNumber('imgCount'),
          primaryImageOfPage: ogImageUrl || twitterImageUrl || '',
          sampleImageUrls: [ogImageUrl, twitterImageUrl].filter(Boolean).slice(0, 5),
          source: 'shortfast_phase_builder'
        },
        trustSignals: {
          hasContactLink: linkBoolean('hasContactLikeLink'),
          contactPathFound: linkBoolean('hasContactLikeLink'),
          contactObservedFromDom: linkBoolean('hasContactLikeLink'),
          contactObservedFromScriptHint: false,
          contactPathHintOnly: false,
          contactConfidence: linkBoolean('hasContactLikeLink') === true ? 'high' : 'unknown',
          contactLinkSource: linksTrust.contactLinkSource || (linkBoolean('hasContactLikeLink') === true ? 'dom' : 'not_observed'),
          contactLinkSample: linksTrust.contactLinkSample || null,
          hasCompanyLink: linkBoolean('hasCompanyLikeLink'),
          companyLinkSource: linksTrust.companyLinkSource || (linkBoolean('hasCompanyLikeLink') === true ? 'dom' : 'not_observed'),
          companyLinkSample: linksTrust.companyLinkSample || null,
          hasServiceLink: linkBoolean('hasServiceLikeLink'),
          serviceLinkSource: linksTrust.serviceLinkSource || (linkBoolean('hasServiceLikeLink') === true ? 'dom' : 'not_observed'),
          serviceLinkSample: linksTrust.serviceLinkSample || null,
          hasPrivacyPolicyLink: linkBoolean('hasPrivacyLikeLink'),
          privacyLinkSource: linksTrust.privacyLinkSource || (linkBoolean('hasPrivacyLikeLink') === true ? 'dom' : 'not_observed'),
          privacyLinkSample: linksTrust.privacyLinkSample || null,
          addressObserved: structuredTrustSummary.addressObserved,
          hasAddress: structuredTrustSummary.hasAddress,
          addressSource: structuredTrustSummary.addressSource,
          contactPointObserved: structuredTrustSummary.contactPointObserved,
          hasContactPoint: structuredTrustSummary.hasContactPoint,
          contactPointMissingFields: structuredTrustSummary.contactPointMissingFields,
          contactPointSource: structuredTrustSummary.contactPointSource,
          source: 'shortfast_phase_builder'
        },
        clarity: {
          ctaTexts: Array.isArray(linksTrust.ctaTexts) ? linksTrust.ctaTexts.slice(0, 10) : [],
          ctaCandidatesCount: linksObserved && typeof linksTrust.ctaCandidatesCount === 'number' ? Number(linksTrust.ctaCandidatesCount) : null,
          ctaObserved: linksObserved ? linksTrust.ctaObserved === true : null,
          source: 'shortfast_phase_builder'
        },
        coverage: {
          hasFaqLink: linksObserved && Object.prototype.hasOwnProperty.call(linksTrust, 'hasFaqLink') ? linksTrust.hasFaqLink : null,
          hasFaqNav: linksObserved && Object.prototype.hasOwnProperty.call(linksTrust, 'hasFaqNav') ? linksTrust.hasFaqNav : null,
          hasFaqSection: linksObserved && Object.prototype.hasOwnProperty.call(linksTrust, 'hasFaqSection') ? linksTrust.hasFaqSection : null,
          faqLinkSource: linksTrust.faqLinkSource || (linksObserved ? 'not_observed' : 'phase_failed'),
          faqLinkSample: linksTrust.faqLinkSample || null,
          faqSectionSource: linksTrust.faqSectionSource || (linksObserved ? 'not_observed' : 'phase_failed'),
          faqSectionTextSample: linksTrust.faqSectionTextSample || '',
          breadcrumbUiObserved: linksObserved ? (linksTrust.breadcrumbUiObserved === true) : null,
          hasBreadcrumbUi: linksObserved && Object.prototype.hasOwnProperty.call(linksTrust, 'hasBreadcrumbUi') ? !!linksTrust.hasBreadcrumbUi : null,
          breadcrumbUiSource: linksTrust.breadcrumbUiSource || (linksObserved ? 'dom_scan' : 'not_observed'),
          breadcrumbUiTextSample: linksTrust.breadcrumbUiTextSample || '',
          footerSignals: linksTrust.footerSignals || {
            observed: linksObserved ? false : null,
            linkCount: null,
            hasPrivacyLink: null,
            hasCompanyLink: null,
            hasCompanyProfileLink: null,
            hasContactLink: null,
            hasTermsLink: null,
            sampleTexts: [],
            externalProfileLinksSample: [],
            socialLinksSample: [],
            footerExternalLinksSample: [],
            source: 'dom_footer_scan'
          },
          source: 'shortfast_phase_builder'
        },
        aioCheck: {
          checked: aioCheck.checked === true,
          hasRobotsTxt: Object.prototype.hasOwnProperty.call(aioCheck, 'hasRobotsTxt') ? aioCheck.hasRobotsTxt : null,
          robotsTxtUrl: aioCheck.robotsTxtUrl || null,
          robotsAiBotHints: Object.prototype.hasOwnProperty.call(aioCheck, 'robotsAiBotHints') ? aioCheck.robotsAiBotHints : null,
          robotsAiBotHintTokens: Array.isArray(aioCheck.robotsAiBotHintTokens) ? aioCheck.robotsAiBotHintTokens.slice(0, 20) : [],
          hasLlmsTxt: Object.prototype.hasOwnProperty.call(aioCheck, 'hasLlmsTxt') ? aioCheck.hasLlmsTxt : null,
          hasLlmsFullTxt: Object.prototype.hasOwnProperty.call(aioCheck, 'hasLlmsFullTxt') ? aioCheck.hasLlmsFullTxt : null,
          llmsTxtUrl: aioCheck.llmsTxtUrl || null,
          llmsFullTxtUrl: aioCheck.llmsFullTxtUrl || null,
          hasSitemapXml: Object.prototype.hasOwnProperty.call(aioCheck, 'hasSitemapXml') ? aioCheck.hasSitemapXml : null,
          sitemapXmlUrl: aioCheck.sitemapXmlUrl || null,
          sitemapDiscoveryMethod: aioCheck.sitemapDiscoveryMethod || 'not_checked',
          sitemapCheckedUrls: Array.isArray(aioCheck.sitemapCheckedUrls) ? aioCheck.sitemapCheckedUrls.slice(0, 10) : [],
          sitemapHttpStatus: Object.prototype.hasOwnProperty.call(aioCheck, 'sitemapHttpStatus') ? aioCheck.sitemapHttpStatus : null,
          sitemapRobotsTxtUrl: aioCheck.sitemapRobotsTxtUrl || null,
          sitemapRobotsHttpStatus: Object.prototype.hasOwnProperty.call(aioCheck, 'sitemapRobotsHttpStatus') ? aioCheck.sitemapRobotsHttpStatus : null,
          checkedLlmsTxtUrls: Array.isArray(aioCheck.checkedLlmsTxtUrls) ? aioCheck.checkedLlmsTxtUrls.slice(0, 10) : [],
          checkedLlmsFullTxtUrls: Array.isArray(aioCheck.checkedLlmsFullTxtUrls) ? aioCheck.checkedLlmsFullTxtUrls.slice(0, 10) : [],
          aiPolicyEvidenceSource: aioCheck.aiPolicyEvidenceSource || 'not_observed',
          source: 'unified_observer_aio_check'
        },
        observed: {
          title: {
            value: basicDom.title || null,
            observed: !!basicDom.title,
            source: 'rendered_dom_light',
            confidence: basicDom.title ? 'high' : 'low'
          },
          metaDescription: {
            value: basicDom.metaDescription || null,
            observed: !!basicDom.metaDescription,
            source: basicDom.metaDescription ? 'basic_dom_eval' : 'not_observed',
            confidence: basicDom.metaDescription ? 'high' : 'low',
            length: Number(basicDom.metaDescriptionLength || (basicDom.metaDescription ? basicDom.metaDescription.length : 0)) || 0
          },
          h1: {
            values: [],
            count: Number(headingsLight.h1Count || 0),
            observed: true,
            source: headingsLight.h1Source || 'not_observed',
            confidence: Number(headingsLight.h1Count || 0) > 0 ? 'high' : 'low',
            hasH1: Number(headingsLight.h1Count || 0) > 0,
            hasSingleH1: Number(headingsLight.h1Count || 0) === 1,
            headingObservationLimited: Number(headingsLight.h1Count || 0) === 0
          },
          headings: null,
          links: {
            navTextsSample: Array.isArray(linksTrust.navTextsSample) ? linksTrust.navTextsSample.slice(0, 50) : [],
            internalLinksSample: Array.isArray(linksTrust.internalLinksSample) ? linksTrust.internalLinksSample.slice(0, 50) : [],
            externalProfileLinksSample: Array.isArray(linksTrust.externalProfileLinksSample) ? linksTrust.externalProfileLinksSample.slice(0, 10) : [],
            socialLinksSample: Array.isArray(linksTrust.socialLinksSample) ? linksTrust.socialLinksSample.slice(0, 10) : [],
            footerExternalLinksSample: Array.isArray(linksTrust.footerExternalLinksSample) ? linksTrust.footerExternalLinksSample.slice(0, 10) : [],
            externalLinksSample: Array.isArray(linksTrust.externalLinksSample) ? linksTrust.externalLinksSample.slice(0, 10) : [],
            hasCompanyLikeLink: linkBoolean('hasCompanyLikeLink'),
            hasServiceLikeLink: linkBoolean('hasServiceLikeLink'),
            hasContactLikeLink: linkBoolean('hasContactLikeLink'),
            hasPrivacyLikeLink: linkBoolean('hasPrivacyLikeLink'),
            contactLinkSource: linksTrust.contactLinkSource || (linkBoolean('hasContactLikeLink') === true ? 'dom' : 'not_observed'),
            companyLinkSource: linksTrust.companyLinkSource || (linkBoolean('hasCompanyLikeLink') === true ? 'dom' : 'not_observed'),
            serviceLinkSource: linksTrust.serviceLinkSource || (linkBoolean('hasServiceLikeLink') === true ? 'dom' : 'not_observed'),
            privacyLinkSource: linksTrust.privacyLinkSource || (linkBoolean('hasPrivacyLikeLink') === true ? 'dom' : 'not_observed'),
            contactLinkSample: linksTrust.contactLinkSample || null,
            companyLinkSample: linksTrust.companyLinkSample || null,
            serviceLinkSample: linksTrust.serviceLinkSample || null,
            privacyLinkSample: linksTrust.privacyLinkSample || null,
            source: linksObserved ? 'rendered_dom_light' : 'phase_failed',
            confidence: linksObserved ? 'medium' : 'low',
            observed: linksObserved,
            phaseError: linksObserved ? '' : (phaseByName('linksAndTrust').errorMessage || 'not_observed')
          },
          structuredData: structuredDataLight,
          articleSignals,
          coverage: null,
          landmarks: null,
          multimodalSignals: null,
          trustSignals: null,
          body: {
            textLength: unifiedBodyTextLength,
            sample: unifiedBodyTextSample || null,
            observed: !!unifiedBodyTextSample,
            source: 'rendered_dom_light',
            confidence: 'medium'
          }
        },
        diagnostics: {
          evaluateCount: phases.length,
          balancedMode: true,
          shortFastMode: true,
          shortFastDedicatedPath: true,
          observer: unifiedBalancedObserverProbe ? 'unified' : undefined,
          unifiedBalancedObserverProbe: !!unifiedBalancedObserverProbe,
          phaseGuardedObserver: !!unifiedBalancedObserverProbe,
          reusedPhaseProbeBuilder: true,
          skippedHeavyBalancedBuilder: true,
          boundedHydrationWaitMs: unifiedBalancedObserverProbe ? 2500 : 0,
          hydrationWaitMs: unifiedBalancedObserverProbe ? Number(hydrationGuardedWait.waitMs || 0) : 0,
          bodyTextBeforeWait: unifiedBalancedObserverProbe && typeof hydrationGuardedWait.bodyTextBeforeWait === 'number' ? hydrationGuardedWait.bodyTextBeforeWait : Number(basicDom.bodyTextLength || 0),
          bodyTextAfterWait: unifiedBodyTextLength,
          hydrationImprovedBodyText: !!(unifiedBalancedObserverProbe && hydrationGuardedWait.hydrationImprovedBodyText),
          hydrationImprovedLinks: !!(unifiedBalancedObserverProbe && hydrationGuardedWait.hydrationImprovedLinks),
          jsBundleAnalysis: false,
          resourceChunkScan: false,
          shadowHeadingScan: !!unifiedBalancedObserverProbe,
          a11yHeadingScan: !!unifiedBalancedObserverProbe,
          appRootHeadingScan: false,
          heroHeadingScan: false,
          iframeHeadingScan: false,
          primaryHeadingScan: true,
          shadowPrimaryHeadingScan: false,
          mainCandidateScan: true,
          htmlContentLdJsonScan: true,
          skippedScans: unifiedBalancedObserverProbe
            ? ['iframe_heading_scan', 'large_samples', 'heavy_balanced_builder', 'resource_chunk_scan']
            : ['deep_shadow_heading_scan', 'a11y_heading_scan', 'a11y_main_scan', 'iframe_heading_scan', 'large_samples', 'heavy_balanced_builder'],
          phaseStatuses,
          observationLimitedByPhase,
          phaseTimings: {
            gotoMs: gotoPhase ? gotoPhase.elapsedMs : null,
            hydrationGuardedWaitMs: phaseByName('hydrationGuardedWait').elapsedMs || null,
            headMetaMs: headMetaPhase ? headMetaPhase.elapsedMs : null,
            basicDomMs: phaseByName('basicDomEval').elapsedMs || null,
            structuredDataMs: phaseByName('structuredDataLight').elapsedMs || null,
            sameOriginScriptJsonLdMs: phaseByName('sameOriginScriptJsonLd').elapsedMs || null,
            linksMs: phaseByName('linksAndTrust').elapsedMs || null,
            multimodalMs: phaseByName('multimodal').elapsedMs || null,
            aioCheckMs: phaseByName('aioCheck').elapsedMs || null,
            headingsMs: phaseByName('headingsLight').elapsedMs || null,
            landmarksMs: phaseByName('landmarksLight').elapsedMs || null,
            totalMs: Math.max(0, Date.now() - probeStartedAt)
          },
          structuredDataPhaseDebug,
          sameOriginScriptJsonLdPhaseDebug
        }
      };
      geoSignalsV1.observed.headings = Object.assign({}, geoSignalsV1.headings, {
        h1: [],
        h2: [],
        h3: [],
        headingTexts: Array.isArray(headingsLight.headingTextsSample) ? headingsLight.headingTextsSample.slice(0, 10) : [],
        a11y: { observed: false, error: 'skipped_shortfast_dedicated_path' }
      });
      geoSignalsV1.observed.landmarks = geoSignalsV1.landmarks;
      geoSignalsV1.observed.multimodalSignals = geoSignalsV1.multimodalSignals;
      geoSignalsV1.observed.trustSignals = geoSignalsV1.trustSignals;
      geoSignalsV1.observed.coverage = geoSignalsV1.coverage;
      geoSignalsV1.observed.aioCheck = geoSignalsV1.aioCheck;
      geoSignalsV1.observed.articleSignals = articleSignals;
      const lightweightSummary = {
        title: basicDom.title || null,
        metaDescription: basicDom.metaDescription || null,
        metaDescriptionLen: Number(basicDom.metaDescriptionLength || (basicDom.metaDescription ? basicDom.metaDescription.length : 0)) || null,
        h1Count: Number(headingsLight.h1Count || 0),
        h2Count: Number(headingsLight.h2Count || 0),
        h1Source: headingsLight.h1Source || 'not_observed',
        headingSource: geoSignalsV1.headings.source,
        primaryHeadingCandidate: geoSignalsV1.headings.primaryHeadingCandidate,
        primaryHeadingCandidateSource: geoSignalsV1.headings.primaryHeadingCandidateSource,
        primaryHeadingConfidence: geoSignalsV1.headings.primaryHeadingConfidence,
        h1EquivalentCandidateFound: geoSignalsV1.headings.h1EquivalentCandidateFound,
        headingObservationLimited: geoSignalsV1.headings.headingObservationLimited,
        hasMainLandmark: geoSignalsV1.landmarks.hasMainLandmark,
        hasMainLandmarkFinal: geoSignalsV1.landmarks.hasMainLandmark_final,
        mainLandmarkSource: geoSignalsV1.landmarks.mainLandmarkSource,
        mainLandmarkCandidateFound: geoSignalsV1.landmarks.mainLandmarkCandidateFound,
        mainLandmarkCandidateSource: geoSignalsV1.landmarks.mainLandmarkCandidateSource,
        mainLandmarkObservationLimited: geoSignalsV1.landmarks.mainLandmarkObservationLimited,
        hydrationWaitMs: unifiedBalancedObserverProbe ? Number(hydrationGuardedWait.waitMs || 0) : 0,
        bodyTextBeforeWait: unifiedBalancedObserverProbe && typeof hydrationGuardedWait.bodyTextBeforeWait === 'number' ? hydrationGuardedWait.bodyTextBeforeWait : Number(basicDom.bodyTextLength || 0),
        bodyTextAfterWait: unifiedBodyTextLength,
        hydrationImprovedBodyText: !!(unifiedBalancedObserverProbe && hydrationGuardedWait.hydrationImprovedBodyText),
        hydrationImprovedLinks: !!(unifiedBalancedObserverProbe && hydrationGuardedWait.hydrationImprovedLinks),
        balancedMode: true,
        shortFastDedicatedPath: true,
        headingShadowScan: false,
        headingA11yScan: false,
        navLinkCount: linkNumber('navLinkCount'),
        internalLinkCount: linkNumber('internalLinkCount'),
        externalProfileLinksSample: Array.isArray(linksTrust.externalProfileLinksSample) ? linksTrust.externalProfileLinksSample.slice(0, 10) : [],
        socialLinksSample: Array.isArray(linksTrust.socialLinksSample) ? linksTrust.socialLinksSample.slice(0, 10) : [],
        footerExternalLinksSample: Array.isArray(linksTrust.footerExternalLinksSample) ? linksTrust.footerExternalLinksSample.slice(0, 10) : [],
        externalLinksSample: Array.isArray(linksTrust.externalLinksSample) ? linksTrust.externalLinksSample.slice(0, 10) : [],
        hasCompanyLikeLink: linkBoolean('hasCompanyLikeLink'),
        hasServiceLikeLink: linkBoolean('hasServiceLikeLink'),
        hasContactLikeLink: linkBoolean('hasContactLikeLink'),
        hasPrivacyLikeLink: linkBoolean('hasPrivacyLikeLink'),
        ctaTexts: Array.isArray(geoSignalsV1.clarity.ctaTexts) ? geoSignalsV1.clarity.ctaTexts.slice(0, 10) : [],
        ctaCandidatesCount: geoSignalsV1.clarity.ctaCandidatesCount,
        ctaObserved: geoSignalsV1.clarity.ctaObserved,
        bodyTextLength: unifiedBodyTextLength,
        bodyTextSample: unifiedBodyTextSample || null,
        mainTextHead: unifiedBodyTextSample || null,
        jsonldCount: structuredDataLight.rawCount,
        jsonldParseableCount: structuredDataLight.parseableCount,
        jsonldParseErrorsCount: structuredDataLight.parseErrorsCount,
        jsonldTypes: structuredDataLight.types.slice(0, 50),
        seoJsonldCount: structuredDataLight.hasSeoJsonLd === true ? structuredDataLight.seoTypes.length : 0,
        seoJsonldTypes: structuredDataLight.seoTypes.slice(0, 50),
        nonSeoJsonldTypes: structuredDataLight.nonSeoTypes.slice(0, 50),
        telemetryJsonldTypes: structuredDataLight.telemetryTypes.slice(0, 50),
        hasJsonLd: structuredDataLight.hasJsonLd,
        hasSeoJsonLd: structuredDataLight.hasSeoJsonLd,
        hasWebsiteJsonLd: structuredDataLight.hasWebsite,
        hasOrgJsonLd: structuredDataLight.hasOrganization,
        hasBreadcrumbJsonLd: structuredDataLight.hasBreadcrumbList,
        hasFaqJsonLd: structuredDataLight.hasFAQPage,
        articleSignals,
        structuredDataBreadcrumbObserved: structuredDataLight.breadcrumbObserved,
        structuredDataBreadcrumbMissing: structuredDataLight.breadcrumbMissing,
        organizationSummary: structuredDataLight.organizationSummary,
        sameAsSummary: structuredDataLight.sameAsSummary,
        orgMissingFields: structuredDataLight.organizationSummary && Array.isArray(structuredDataLight.organizationSummary.missingFields)
          ? structuredDataLight.organizationSummary.missingFields.slice(0, 12)
          : [],
        sameAsObserved: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.observed : null,
        sameAsCount: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.count : null,
        sameAsExternalCount: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.externalCount : null,
        sameAsCountByType: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.sameAsCountByType : null,
        hasOrganizationSameAs: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.hasOrganizationSameAs : null,
        hasWebSiteSameAs: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.hasWebSiteSameAs : null,
        hasPersonSameAs: structuredDataLight.sameAsSummary ? structuredDataLight.sameAsSummary.hasPersonSameAs : null,
        sameAsValuesSample: structuredDataLight.sameAsSummary && Array.isArray(structuredDataLight.sameAsSummary.valuesSample)
          ? structuredDataLight.sameAsSummary.valuesSample.slice(0, 8)
          : [],
        hasFaqLink: geoSignalsV1.coverage.hasFaqLink,
        hasFaqNav: geoSignalsV1.coverage.hasFaqNav,
        hasFaqSection: geoSignalsV1.coverage.hasFaqSection,
        breadcrumbUiObserved: geoSignalsV1.coverage.breadcrumbUiObserved,
        hasBreadcrumbUi: geoSignalsV1.coverage.hasBreadcrumbUi,
        breadcrumbUiSource: geoSignalsV1.coverage.breadcrumbUiSource,
        structuredDataObservationLimited: structuredDataLight.observationLimited,
        structuredDataObservationScope: structuredDataLight.observationScope,
        structuredDataRenderedDomObserved: structuredDataLight.renderedDomObserved,
        structuredDataHtmlContentLdJsonObserved: structuredDataLight.htmlContentLdJsonObserved,
        structuredDataScriptSrcJsonLdObserved: structuredDataLight.scriptSrcJsonLdObserved,
        structuredDataScriptSrcFetchedCount: structuredDataLight.scriptSrcFetchedCount,
        structuredDataScriptSrcJsonLdCandidateCount: structuredDataLight.scriptSrcJsonLdCandidateCount,
        structuredDataScriptSrcJsonLdTypes: structuredDataLight.scriptSrcJsonLdTypes.slice(0, 50),
        structuredDataExcludedFromSeoTypes: structuredDataLight.excludedFromSeoTypes.slice(0, 50),
        structuredDataTypeClassificationSource: structuredDataLight.typeClassificationSource,
        hasOgImage: geoSignalsV1.multimodalSignals.hasOgImage,
        hasTwitterImage: geoSignalsV1.multimodalSignals.hasTwitterImage,
        hasFavicon: geoSignalsV1.multimodalSignals.hasFavicon,
        hasAppleTouchIcon: geoSignalsV1.multimodalSignals.hasAppleTouchIcon,
        hasStructuredLogo: geoSignalsV1.multimodalSignals.hasStructuredLogo,
        hasContactLink: geoSignalsV1.trustSignals.hasContactLink,
        contactPathFound: geoSignalsV1.trustSignals.contactPathFound,
        contactObservedFromDom: geoSignalsV1.trustSignals.contactObservedFromDom,
        contactObservedFromScriptHint: geoSignalsV1.trustSignals.contactObservedFromScriptHint,
        contactPathHintOnly: geoSignalsV1.trustSignals.contactPathHintOnly,
        contactLinkSource: geoSignalsV1.trustSignals.contactLinkSource || null,
        companyLinkSource: geoSignalsV1.trustSignals.companyLinkSource || null,
        serviceLinkSource: geoSignalsV1.trustSignals.serviceLinkSource || null,
        privacyLinkSource: geoSignalsV1.trustSignals.privacyLinkSource || null,
        addressObserved: geoSignalsV1.trustSignals.addressObserved,
        hasAddress: geoSignalsV1.trustSignals.hasAddress,
        addressSource: geoSignalsV1.trustSignals.addressSource,
        contactPointObserved: geoSignalsV1.trustSignals.contactPointObserved,
        hasContactPoint: geoSignalsV1.trustSignals.hasContactPoint,
        contactPointMissingFields: geoSignalsV1.trustSignals.contactPointMissingFields,
        contactPointSource: geoSignalsV1.trustSignals.contactPointSource,
        footerSignals: geoSignalsV1.coverage.footerSignals,
        aioCheck: geoSignalsV1.aioCheck,
        contactConfidence: geoSignalsV1.trustSignals.contactConfidence || null,
        geoThemeSignalSummary: geoThemeSignals.summary
      };
      try {
        const payloadBytesEstimate = Buffer.byteLength(JSON.stringify(geoThemeSignals || {}), 'utf8');
        console.log('[SF][GEO_THEME_SIGNALS]', JSON.stringify({
          url: String(urlToFetch || ''),
          finalUrl: String(finalUrl || urlToFetch || ''),
          checkedTextLength: geoThemeSignals.checkedTextLength,
          positiveSignals: geoThemeSignals.summary.positiveSignals,
          weakSignals: geoThemeSignals.summary.weakSignals,
          confidenceSummary: geoThemeSignals.summary.confidenceSummary,
          payloadBytesEstimate
        }));
      } catch (_) {}
      const phaseFailed = (name) => {
        const p = phaseByName(name);
        return !!(p && p.name && !p.ok && !(p.minimalResult && p.minimalResult.skipped));
      };
      const gotoPartialRecovered = !!(gotoPhase && gotoPhase.minimalResult && gotoPhase.minimalResult.gotoPartial);
      const limitedPhaseNames = observationLimitedByPhase.map((p) => p.phase);
      const structuredDataReady = structuredDataLight.hasJsonLd === true || structuredObserved || scriptObserved;
      const linksReady = !phaseFailed('linksAndTrust') && (
        Number(linksTrust.navLinkCount || 0) > 0 ||
        Number(linksTrust.internalLinkCount || 0) > 0 ||
        Number(linksTrust.anchorCount || 0) > 0
      );
      const headingsReady = !phaseFailed('headingsLight') && Object.prototype.hasOwnProperty.call(headingsLight, 'h1Count');
      const landmarksReady = !phaseFailed('landmarksLight') && (
        Object.prototype.hasOwnProperty.call(landmarksLight, 'hasMainLandmark') ||
        Object.prototype.hasOwnProperty.call(landmarksLight, 'hasMainLandmark_final') ||
        typeof optionalA11y.mainCount === 'number'
      );
      const trustReady = !phaseFailed('linksAndTrust') && (
        typeof linksTrust.hasContactLikeLink === 'boolean' ||
        typeof linksTrust.hasCompanyLikeLink === 'boolean' ||
        typeof linksTrust.hasPrivacyLikeLink === 'boolean'
      );
      const multimodalReady = !phaseFailed('multimodal') && (
        typeof multimodal.hasOgImage === 'boolean' ||
        typeof multimodal.hasFavicon === 'boolean' ||
        typeof multimodal.imgCount === 'number'
      );
      const recoveredCoreSignals = [
        structuredDataReady,
        linksReady,
        headingsReady,
        landmarksReady,
        trustReady,
        multimodalReady
      ];
      const recoveredCoreSignalCount = recoveredCoreSignals.filter(Boolean).length;
      const basicDomFailed = phaseFailed('basicDomEval');
      const basicDomFatalSuppressed = basicDomFailed && !phaseFailed('goto') && recoveredCoreSignalCount >= 4;
      const recoveredFromBasicDomTimeout = basicDomFatalSuppressed;
      const coreSignalsReady = (!phaseFailed('goto') || gotoPartialRecovered) && (
        !basicDomFailed ||
        basicDomFatalSuppressed ||
        !!basicDom.title ||
        unifiedBodyTextLength > 0 ||
        Number(linksTrust.anchorCount || 0) > 0 ||
        Number(linksTrust.internalLinkCount || 0) > 0
      );
      const fatalPhaseFailures = phaseStatuses
        .filter((p) => {
          if (!p.ok && p.name === 'goto') return !gotoPartialRecovered;
          if (!p.ok && p.name === 'basicDomEval') return !basicDomFatalSuppressed;
          return false;
        })
        .map((p) => ({
          phase: p.name,
          errorMessage: p.errorMessage || 'core_phase_failed'
        }));
      const corePhaseFailures = ['structuredDataLight', 'sameOriginScriptJsonLd', 'linksAndTrust', 'multimodal', 'headingsLight', 'landmarksLight']
        .filter((name) => phaseFailed(name));
      const qualityReasons = [];
      if (gotoPartialRecovered) qualityReasons.push('goto_timeout_but_partial_dom_recovered');
      if (recoveredFromBasicDomTimeout) qualityReasons.push('basic_dom_timeout_but_core_signals_recovered');
      if (!basicDom.title) qualityReasons.push('title_not_observed');
      if (!unifiedBodyTextLength) qualityReasons.push('body_text_not_observed');
      if (!coreSignalsReady) qualityReasons.push('core_signals_not_ready');
      if (!structuredDataLight.hasJsonLd) qualityReasons.push('structured_data_not_observed_or_limited');
      if (!linksReady) qualityReasons.push('links_not_ready');
      if (!headingsReady) qualityReasons.push('headings_not_ready');
      if (!landmarksReady) qualityReasons.push('landmarks_not_ready');
      if (observationLimitedByPhase.length) qualityReasons.push('phase_observation_limited');
      if (corePhaseFailures.length) qualityReasons.push('core_phase_failures:' + corePhaseFailures.join(','));
      let qualityStatus = 'ready';
      if (fatalPhaseFailures.length || !coreSignalsReady) {
        qualityStatus = 'failed';
      } else if (corePhaseFailures.length >= 2 || (!linksReady && !structuredDataReady)) {
        qualityStatus = 'degraded';
      } else if (qualityReasons.length || !structuredDataLight.hasJsonLd) {
        qualityStatus = 'limited';
      }
      if (!qualityReasons.length) qualityReasons.push('all_core_observer_phases_ready');
      lightweightSummary.qualityStatus = qualityStatus;
      lightweightSummary.coreSignalsReady = coreSignalsReady;
      lightweightSummary.observationLimitedByPhaseCount = observationLimitedByPhase.length;
      const diagnostics = {
        probeOnly: false,
        responseMode: 'shortFast',
        shortFastMode: true,
        shortFastDedicatedPath: true,
        observer: unifiedBalancedObserverProbe ? 'unified' : undefined,
        unifiedBalancedObserverProbe: !!unifiedBalancedObserverProbe,
        phaseGuardedObserver: !!unifiedBalancedObserverProbe,
        reusedPhaseProbeBuilder: true,
        skippedHeavyBalancedBuilder: true,
        balancedMode: true,
        htmlSkipped: true,
        scoringSkipped: true,
        auditSigSkipped: true,
        jsScanSkipped: true,
        chunkScanSkipped: true,
        phaseTimings: geoSignalsV1.diagnostics.phaseTimings,
        phases: phases.map((p) => ({ name: p.name, ok: p.ok, elapsedMs: p.elapsedMs, errorMessage: p.errorMessage || '' })),
        phaseStatuses,
        observationLimitedByPhase,
        qualityStatus,
        qualityReasons,
        fatalPhaseFailures,
        limitedPhaseNames,
        structuredDataPhaseDebug,
        sameOriginScriptJsonLdPhaseDebug,
        coreSignalsReady,
        recoveredFromBasicDomTimeout,
        recoveredCoreSignalCount,
        basicDomFatalSuppressed,
        structuredDataReady,
        linksReady,
        headingsReady,
        landmarksReady,
        trustReady,
        multimodalReady,
        blockedCounts,
        skippedScans: geoSignalsV1.diagnostics.skippedScans,
        timeoutGuardMs: 60000
      };
      const memoryHints = {
        avoidedHeavyBlocks: [
          'html',
          'scoring.html',
          'auditSig',
          'heavy_balanced_builder',
          'deep_shadow_heading_scan',
          'a11y_heading_scan',
          'iframe_heading_scan',
          'resource_js_tap',
          'chunk_tap',
          'productSpecComparisonSignals',
          'responsePayloadHugeMerge'
        ],
        estimatedSavedBytes: null,
        shortFastMode: true,
        observer: unifiedBalancedObserverProbe ? 'unified' : undefined,
        skippedScans: diagnostics.skippedScans
      };
      if (unifiedBalancedObserverProbe) {
        const unifiedPayload = {
          ok: qualityStatus !== 'failed',
          mode: 'unifiedBalancedObserverProbe',
          qualityStatus,
          qualityReasons,
          fatalPhaseFailures,
          limitedPhaseNames,
          observer: 'unified',
          url: urlToFetch,
          finalUrl,
          status,
          aioCheck: geoSignalsV1.aioCheck,
          geoSignalsV1,
          lightweightSummary,
          diagnostics: Object.assign({}, diagnostics, {
            probeOnly: true,
            responseMode: undefined,
            shortFastMode: false,
            shortFastDedicatedPath: false,
            fullScrapeSkipped: true,
            balancedMainlineSkipped: true,
            rawHtmlReturned: false,
            rawJsReturned: false,
            phaseTimeoutsMs: {
              goto: 12000,
              hydrationGuardedWait: 3000,
              basicDom: 2000,
              structuredDataLight: 3000,
              sameOriginScriptJsonLd: 8000,
              linksAndTrust: 3000,
              multimodal: 1000,
              headingsLight: 2000,
              landmarksLight: 2000,
              optionalEnhancedShadow: 2000,
              optionalA11y: 2000
            }
          }),
          memoryHints
        };
        mergeTopPageStaticSignalsIntoPayload_(geoSignalsV1, lightweightSummary, topPageStaticFetchResult);
        attachMediaArticleLinkFreshnessSignals_(geoSignalsV1, lightweightSummary, { siteMode, url: finalUrl || urlToFetch });
        unifiedPayload.geoSignalsV1 = geoSignalsV1;
        unifiedPayload.lightweightSummary = lightweightSummary;
        unifiedPayload.diagnostics.topPageStaticFetch = geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.topPageStaticFetch || {
          used: !!topPageStaticFetchResult,
          success: !!(topPageStaticFetchResult && topPageStaticFetchResult.success),
          elapsedMs: Number(topPageStaticFetchResult && topPageStaticFetchResult.elapsedMs || 0),
          usedAsFallback: false,
          error: topPageStaticFetchResult && topPageStaticFetchResult.error || ''
        };
        unifiedPayload.diagnostics.playwrightTimedOut = false;
        unifiedPayload.diagnostics.playwrightFailed = false;
        try {
          unifiedPayload.diagnostics.responseBytesApprox = Buffer.byteLength(JSON.stringify(unifiedPayload), 'utf8');
        } catch (_) {}
        logSf('UNIFIED_BALANCED_OBSERVER_PROBE_SEND', {
          ok: unifiedPayload.ok,
          status,
          totalMs: unifiedPayload.diagnostics.phaseTimings && unifiedPayload.diagnostics.phaseTimings.totalMs,
          phaseStatuses: unifiedPayload.diagnostics.phaseStatuses,
          observationLimitedByPhase: unifiedPayload.diagnostics.observationLimitedByPhase,
          jsonldTypes: lightweightSummary.jsonldTypes,
          navLinkCount: lightweightSummary.navLinkCount,
          internalLinkCount: lightweightSummary.internalLinkCount,
          h1Count: lightweightSummary.h1Count,
          hasMainLandmark: lightweightSummary.hasMainLandmarkFinal
        });
        logSfMemory('unified_balanced_observer_probe_send');
        return res.status(200).json(unifiedPayload);
      }
      if (balancedShortFastResponse) {
      const dedicatedPayload = {
        ok: phases.every((p) => p.ok),
        mode: 'signalsFirstBalanced',
        responseMode: 'shortFast',
        shortFastMode: true,
        url: urlToFetch,
        finalUrl,
        status,
        aioCheck: geoSignalsV1.aioCheck,
        geoSignalsV1,
        lightweightSummary,
        diagnostics,
        memoryHints
      };
      mergeTopPageStaticSignalsIntoPayload_(geoSignalsV1, lightweightSummary, topPageStaticFetchResult);
      attachMediaArticleLinkFreshnessSignals_(geoSignalsV1, lightweightSummary, { siteMode, url: finalUrl || urlToFetch });
      dedicatedPayload.geoSignalsV1 = geoSignalsV1;
      dedicatedPayload.lightweightSummary = lightweightSummary;
      dedicatedPayload.diagnostics.topPageStaticFetch = geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.topPageStaticFetch || {
        used: !!topPageStaticFetchResult,
        success: !!(topPageStaticFetchResult && topPageStaticFetchResult.success),
        elapsedMs: Number(topPageStaticFetchResult && topPageStaticFetchResult.elapsedMs || 0),
        usedAsFallback: false,
        error: topPageStaticFetchResult && topPageStaticFetchResult.error || ''
      };
      dedicatedPayload.diagnostics.playwrightTimedOut = false;
      dedicatedPayload.diagnostics.playwrightFailed = false;
      try {
        dedicatedPayload.diagnostics.responseBytesApprox = Buffer.byteLength(JSON.stringify(dedicatedPayload), 'utf8');
      } catch (_) {}
      logSf('SIGNALS_FIRST_BALANCED_SHORTFAST_DEDICATED_SEND', {
        ok: dedicatedPayload.ok,
        status,
        phaseTimings: diagnostics.phaseTimings,
        navLinkCount: lightweightSummary.navLinkCount,
        internalLinkCount: lightweightSummary.internalLinkCount,
        h1Source: lightweightSummary.h1Source,
        hasMainLandmark: lightweightSummary.hasMainLandmarkFinal,
        jsonldCount: lightweightSummary.jsonldCount
      });
      logSfMemory('signals_first_balanced_shortfast_dedicated_send');
      return res.status(200).json(dedicatedPayload);
      }

      const out = {
        ok: phases.every((p) => p.ok),
        mode: 'shortFastPhaseProbe',
        url: urlToFetch,
        finalUrl,
        status,
        timings: {
          browserReadyMs: typeof scrapeTiming.browserReadyMs === 'number' ? scrapeTiming.browserReadyMs : null,
          pageReadyMs: typeof scrapeTiming.pageReadyMs === 'number' ? scrapeTiming.pageReadyMs : null,
          routeSetupMs,
          gotoMs: gotoPhase ? gotoPhase.elapsedMs : null,
          totalMs: Math.max(0, Date.now() - probeStartedAt)
        },
        phases,
        blockedCounts,
        diagnostics: {
          probeOnly: true,
          shortFastSkipped: true,
          phaseProbe: true,
          balancedSkipped: true,
          fullScrapeSkipped: true,
          rawHtmlReturned: false,
          rawJsReturned: false,
          phaseTimeoutMs: 3000,
          sameOriginScriptFetchTimeoutMs: 3000,
          sameOriginScriptMaxScripts: 3,
          sameOriginScriptMaxBytes: 512000
        }
      };
      logSf('SHORTFAST_PHASE_PROBE_SEND', {
        ok: out.ok,
        status: out.status,
        timings: out.timings,
        phaseTimings: phases.map((p) => ({ name: p.name, ok: p.ok, elapsedMs: p.elapsedMs, errorMessage: p.errorMessage })),
        blockedCounts
      });
      logSfMemory('shortfast_phase_probe_send');
      return res.status(200).json(out);
    }

    let jsonLdResourceTapState = null;
    if (probeMode === 'jsonldresourcetap') {
      jsonLdResourceTapState = {
        startedAt: Date.now(),
        promises: [],
        candidates: [],
        seen: new Set(),
        skippedLargeCount: 0,
        skippedNoHintCount: 0,
        responseSeenCount: 0
      };
      const MAX_JSONLD_RESOURCE_CANDIDATES = 20;
      const MAX_JSONLD_RESOURCE_BODY = 200000;
      const cleanResourceJsonLdText = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const walkResourceJsonLd = (node, out, depth = 0) => {
        if (depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((item) => walkResourceJsonLd(item, out, depth + 1));
          return;
        }
        if (!node || typeof node !== 'object') return;
        const t = node['@type'];
        if (Array.isArray(t)) t.forEach((x) => out.push(cleanResourceJsonLdText(x)));
        else if (t) out.push(cleanResourceJsonLdText(t));
        if (Array.isArray(node['@graph'])) node['@graph'].forEach((item) => walkResourceJsonLd(item, out, depth + 1));
      };
      const regexTypesFromResourceText = (text) => {
        const out = [];
        const re = /["\\]?@type["\\]?\s*[:=]\s*(?:\\?["'])([^"'\\]{1,80})/g;
        let m;
        while ((m = re.exec(String(text || ''))) && out.length < 20) {
          out.push(cleanResourceJsonLdText(m[1]));
        }
        return out;
      };
      page.on('response', (response) => {
        try {
          if (!jsonLdResourceTapState || jsonLdResourceTapState.candidates.length >= MAX_JSONLD_RESOURCE_CANDIDATES) return;
          jsonLdResourceTapState.responseSeenCount += 1;
          const responseUrl = String(response.url && response.url() || '');
          if (!responseUrl || jsonLdResourceTapState.seen.has(responseUrl)) return;
          const headers = response.headers ? response.headers() : {};
          const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
          const contentLengthHeader = headers['content-length'] || headers['Content-Length'];
          const contentLength = Number(contentLengthHeader || 0);
          const urlLooksRelevant = /json|ld|schema|structured|wp-json|\/api\/|api[.-]/i.test(responseUrl);
          const typeLooksRelevant = /application\/ld\+json|application\/json|text\/json|javascript|ecmascript/i.test(contentType);
          if (!typeLooksRelevant && !urlLooksRelevant) return;
          if (/javascript|ecmascript/i.test(contentType) && !urlLooksRelevant) return;
          if (contentLength && contentLength > MAX_JSONLD_RESOURCE_BODY) {
            jsonLdResourceTapState.skippedLargeCount += 1;
            return;
          }
          jsonLdResourceTapState.seen.add(responseUrl);
          const p = (async () => {
            try {
              const text = await response.text();
              const approxLength = String(text || '').length;
              if (approxLength > MAX_JSONLD_RESOURCE_BODY) {
                jsonLdResourceTapState.skippedLargeCount += 1;
                return;
              }
              const hasContext = /@context/.test(text);
              const hasType = /@type/.test(text);
              const hasSchemaOrg = /schema\.org/i.test(text);
              if (!hasContext && !hasType && !hasSchemaOrg) {
                jsonLdResourceTapState.skippedNoHintCount += 1;
                return;
              }
              const types = [];
              let parseable = false;
              let parseError = '';
              try {
                const parsed = JSON.parse(text);
                parseable = true;
                walkResourceJsonLd(parsed, types, 0);
              } catch (e) {
                parseError = String(e && (e.message || e) || '').slice(0, 160);
                regexTypesFromResourceText(text).forEach((t) => types.push(t));
              }
              if (jsonLdResourceTapState.candidates.length >= MAX_JSONLD_RESOURCE_CANDIDATES) return;
              jsonLdResourceTapState.candidates.push({
                urlSample: responseUrl.slice(0, 220),
                contentType: contentType.slice(0, 120),
                approxLength,
                hasContext,
                hasType,
                hasSchemaOrg,
                parseable,
                typesSample: Array.from(new Set(types.filter(Boolean))).slice(0, 20),
                textSample: cleanResourceJsonLdText(text).slice(0, 260),
                parseError
              });
            } catch (_) {}
          })();
          jsonLdResourceTapState.promises.push(p);
        } catch (_) {}
      });
    }

    // ---- 主要待機（軽め） ----
    const __timingInitialWaitStart = Date.now();
    logSf('BEFORE_GOTO', { url: String(urlToFetch || '').slice(0, 180) });
    logSfMemory('before_goto');
    logHeavySiteTopPageAudit('page_goto_start', {
      waitUntil: 'domcontentloaded',
      timeoutMs: 60000
    });
    const resp = await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    scrapeTiming.gotoMs = Math.max(0, Date.now() - __timingInitialWaitStart);
    logHeavySiteTopPageAudit('page_goto_end', {
      status: resp && typeof resp.status === 'function' ? resp.status() : null,
      finalUrl: page && typeof page.url === 'function' ? page.url() : null,
      gotoMs: scrapeTiming.gotoMs
    });
    logSf('AFTER_GOTO', {
      status: resp && typeof resp.status === 'function' ? resp.status() : null,
      finalUrl: page && typeof page.url === 'function' ? page.url() : null
    });
    logSfMemory('after_goto');
    if (probeMode === 'jsonldresourcetap') {
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      const status = resp && typeof resp.status === 'function' ? resp.status() : null;
      logSf('JSONLD_RESOURCE_TAP_PROBE_ENTER', {
        url: String(urlToFetch || '').slice(0, 180),
        finalUrl: String(finalUrl || '').slice(0, 180),
        status
      });
      logSfMemory('jsonld_resource_tap_probe_enter');
      await page.waitForTimeout(1500).catch(() => {});
      try {
        await Promise.allSettled((jsonLdResourceTapState && jsonLdResourceTapState.promises || []).slice(0, 80));
      } catch (_) {}
      const candidates = (jsonLdResourceTapState && jsonLdResourceTapState.candidates || []).slice(0, 20);
      const types = Array.from(new Set([].concat.apply([], candidates.map((c) => Array.isArray(c.typesSample) ? c.typesSample : [])).filter(Boolean))).slice(0, 50);
      const typeSet = new Set(types.map((t) => String(t || '').toLowerCase()));
      const parsedJsonLdCount = candidates.filter((c) => c && c.parseable && (c.hasContext || c.hasType || c.hasSchemaOrg)).length;
      const out = {
        ok: true,
        mode: 'jsonLdResourceTapProbe',
        url: urlToFetch,
        finalUrl,
        status,
        candidateResponseCount: candidates.length,
        parsedJsonLdCount,
        types,
        hasWebsite: typeSet.has('website'),
        hasOrganization: typeSet.has('organization') || typeSet.has('corporation') || typeSet.has('localbusiness'),
        hasBreadcrumbList: typeSet.has('breadcrumblist'),
        hasFAQPage: typeSet.has('faqpage'),
        candidates,
        diagnostics: {
          probeOnly: true,
          fullScrapeSkipped: true,
          jsScanSkipped: true,
          chunkScanSkipped: true,
          rawBodyReturned: false,
          responseSeenCount: jsonLdResourceTapState ? jsonLdResourceTapState.responseSeenCount : 0,
          skippedLargeCount: jsonLdResourceTapState ? jsonLdResourceTapState.skippedLargeCount : 0,
          skippedNoHintCount: jsonLdResourceTapState ? jsonLdResourceTapState.skippedNoHintCount : 0,
          maxCandidateCount: 20,
          maxBodyBytes: 200000,
          elapsedMs: jsonLdResourceTapState ? (Date.now() - jsonLdResourceTapState.startedAt) : null
        }
      };
      logSf('JSONLD_RESOURCE_TAP_PROBE_SEND', {
        candidateResponseCount: out.candidateResponseCount,
        parsedJsonLdCount: out.parsedJsonLdCount,
        types: out.types,
        skippedLargeCount: out.diagnostics.skippedLargeCount,
        skippedNoHintCount: out.diagnostics.skippedNoHintCount
      });
      logSfMemory('jsonld_resource_tap_probe_send');
      return res.status(200).json(out);
    }
    if (probeMode === 'jsonldbalanced') {
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      const status = resp && typeof resp.status === 'function' ? resp.status() : null;
      const startedAt = Date.now();
      logSf('JSONLD_BALANCED_PROBE_ENTER', {
        url: String(urlToFetch || '').slice(0, 180),
        finalUrl: String(finalUrl || '').slice(0, 180),
        status
      });
      logSfMemory('jsonld_balanced_probe_enter');

      const summarizeTexts = (texts, source) => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const nodeTypes = [];
        const samples = [];
        const parseErrors = [];
        const walkJsonLd = (node, depth = 0) => {
          if (depth > 8) return;
          if (Array.isArray(node)) {
            node.forEach((item) => walkJsonLd(item, depth + 1));
            return;
          }
          if (!node || typeof node !== 'object') return;
          const t = node['@type'];
          if (Array.isArray(t)) t.forEach((x) => nodeTypes.push(clean(x)));
          else if (t) nodeTypes.push(clean(t));
          if (Array.isArray(node['@graph'])) node['@graph'].forEach((item) => walkJsonLd(item, depth + 1));
        };
        let parseableCount = 0;
        let parseErrorsCount = 0;
        (Array.isArray(texts) ? texts : []).forEach((entry, idx) => {
          const text = typeof entry === 'string' ? entry : String((entry && entry.text) || '');
          const type = typeof entry === 'object' && entry ? String(entry.type || '') : '';
          const id = typeof entry === 'object' && entry ? String(entry.id || '') : '';
          const head = clean(text).slice(0, 220);
          if (samples.length < 8) samples.push({ source, index: idx, type, id, length: text.length, head });
          try {
            const parsed = JSON.parse(text);
            parseableCount += 1;
            walkJsonLd(parsed);
          } catch (e) {
            parseErrorsCount += 1;
            if (parseErrors.length < 5) {
              parseErrors.push({
                source,
                index: idx,
                message: String(e && (e.message || e) || '').slice(0, 180),
                head
              });
            }
          }
        });
        const types = Array.from(new Set(nodeTypes.filter(Boolean))).slice(0, 50);
        return {
          source,
          rawCount: Array.isArray(texts) ? texts.length : 0,
          parseableCount,
          parseErrorsCount,
          types,
          samples,
          parseErrors
        };
      };

      const collectDomJsonLd = async () => page.evaluate(() => {
        const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
        const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map((s) => ({ type: s.getAttribute('type') || '', id: s.id || '', text: s.textContent || '' }))
          .filter((s) => clean(s.text));
        const alternateJsonScripts = Array.from(document.querySelectorAll('script[type]'))
          .map((s) => ({ type: s.getAttribute('type') || '', id: s.id || '', text: s.textContent || '' }))
          .filter((s) => {
            const type = String(s.type || '').toLowerCase();
            if (type === 'application/ld+json') return false;
            if (!/json|x-json|javascript|ecmascript/i.test(type)) return false;
            return clean(s.text);
          });
        const nextEl = document.querySelector('script#__NEXT_DATA__');
        const nuxtEl = document.querySelector('script#__NUXT_DATA__');
        const htmlText = document.documentElement ? String(document.documentElement.innerHTML || '') : '';
        const dataAttrCount = Array.from(document.querySelectorAll('[data-json],[data-schema],[data-ld],[data-structured]')).length;
        return {
          jsonLdTexts: jsonLdScripts,
          alternateJsonScripts: alternateJsonScripts.slice(0, 20).map((s) => ({
            type: s.type,
            id: s.id,
            length: String(s.text || '').length,
            text: String(s.text || '').slice(0, 20000)
          })),
          nextDataFound: !!nextEl,
          nuxtDataFound: !!nuxtEl || /\bwindow\.__NUXT__\b/.test(htmlText),
          nextDataLength: nextEl ? String(nextEl.textContent || '').length : 0,
          nuxtDataLength: nuxtEl ? String(nuxtEl.textContent || '').length : 0,
          dataAttributeJsonCandidateCount: dataAttrCount,
          escapedLdJsonHint: /application\\?\/ld\+json|@type|@graph/.test(htmlText)
        };
      }).catch(() => ({
        jsonLdTexts: [],
        alternateJsonScripts: [],
        nextDataFound: false,
        nuxtDataFound: false,
        nextDataLength: 0,
        nuxtDataLength: 0,
        dataAttributeJsonCandidateCount: 0,
        escapedLdJsonHint: false
      }));

      const beforeWaitDom = await collectDomJsonLd();
      await page.waitForTimeout(1000).catch(() => {});
      const afterWaitDom = await collectDomJsonLd();

      const html = await page.content().catch(() => '');
      const $ = cheerio.load(html || '');
      const htmlContentTexts = [];
      $('script[type="application/ld+json"]').each((_, el) => {
        if (htmlContentTexts.length >= 120) return;
        const txt = String($(el).text() || '').trim();
        if (!txt) return;
        htmlContentTexts.push({
          type: String($(el).attr('type') || ''),
          id: String($(el).attr('id') || ''),
          text: txt.length > 300000 ? txt.slice(0, 300000) : txt
        });
      });
      const htmlAlternateJsonScripts = [];
      $('script[type]').each((_, el) => {
        if (htmlAlternateJsonScripts.length >= 20) return;
        const type = String($(el).attr('type') || '').toLowerCase();
        if (type === 'application/ld+json') return;
        if (!/json|x-json|javascript|ecmascript/i.test(type)) return;
        const txt = String($(el).text() || '').trim();
        if (!txt) return;
        htmlAlternateJsonScripts.push({
          type: String($(el).attr('type') || ''),
          id: String($(el).attr('id') || ''),
          length: txt.length,
          text: txt.slice(0, 20000)
        });
      });

      const renderedBeforeSummary = summarizeTexts(beforeWaitDom.jsonLdTexts || [], 'rendered_dom_before_wait');
      const renderedAfterSummary = summarizeTexts(afterWaitDom.jsonLdTexts || [], 'rendered_dom_after_wait');
      const htmlSummary = summarizeTexts(htmlContentTexts, 'page_content_ldjson');
      const alternateSummary = summarizeTexts(
        (afterWaitDom.alternateJsonScripts || []).concat(htmlAlternateJsonScripts || []),
        'alternate_json_scripts'
      );
      const types = Array.from(new Set(
        []
          .concat(renderedBeforeSummary.types || [])
          .concat(renderedAfterSummary.types || [])
          .concat(htmlSummary.types || [])
          .concat(alternateSummary.types || [])
          .filter(Boolean)
      )).slice(0, 50);
      const samples = []
        .concat(renderedBeforeSummary.samples || [])
        .concat(renderedAfterSummary.samples || [])
        .concat(htmlSummary.samples || [])
        .concat(alternateSummary.samples || [])
        .slice(0, 16);
      const parseErrors = []
        .concat(renderedBeforeSummary.parseErrors || [])
        .concat(renderedAfterSummary.parseErrors || [])
        .concat(htmlSummary.parseErrors || [])
        .concat(alternateSummary.parseErrors || [])
        .slice(0, 10);
      const parseableCount =
        renderedAfterSummary.parseableCount +
        htmlSummary.parseableCount +
        alternateSummary.parseableCount;
      const parseErrorsCount =
        renderedAfterSummary.parseErrorsCount +
        htmlSummary.parseErrorsCount +
        alternateSummary.parseErrorsCount;

      const out = {
        ok: true,
        mode: 'balancedJsonLdProbe',
        url: urlToFetch,
        finalUrl,
        status,
        renderedDomRawCount: renderedAfterSummary.rawCount,
        renderedDomBeforeWaitRawCount: renderedBeforeSummary.rawCount,
        renderedDomAfterWaitRawCount: renderedAfterSummary.rawCount,
        htmlContentRawCount: htmlSummary.rawCount,
        alternateJsonScriptCount: alternateSummary.rawCount,
        nextDataFound: !!(afterWaitDom.nextDataFound),
        nuxtDataFound: !!(afterWaitDom.nuxtDataFound),
        nextDataLength: Number(afterWaitDom.nextDataLength || 0),
        nuxtDataLength: Number(afterWaitDom.nuxtDataLength || 0),
        dataAttributeJsonCandidateCount: Number(afterWaitDom.dataAttributeJsonCandidateCount || 0),
        escapedLdJsonHint: !!(afterWaitDom.escapedLdJsonHint || /application\\?\/ld\+json|@type|@graph/.test(String(html || ''))),
        parseableCount,
        types,
        parseErrorsCount,
        samples,
        parseErrors,
        diagnostics: {
          fullScrapeSkipped: true,
          rawHtmlReturned: false,
          rawJsonLdReturned: false,
          boundedWaitMs: 1000,
          htmlLength: String(html || '').length,
          elapsedMs: Date.now() - startedAt
        }
      };
      logSf('JSONLD_BALANCED_PROBE_SEND', {
        renderedDomRawCount: out.renderedDomRawCount,
        htmlContentRawCount: out.htmlContentRawCount,
        alternateJsonScriptCount: out.alternateJsonScriptCount,
        parseableCount: out.parseableCount,
        types: out.types,
        elapsedMs: out.diagnostics.elapsedMs
      });
      logSfMemory('jsonld_balanced_probe_send');
      return res.status(200).json(out);
    }
    if (probeMode === 'jsonldscriptsrc') {
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      const status = resp && typeof resp.status === 'function' ? resp.status() : null;
      const startedAt = Date.now();
      const MAX_SCRIPTS = 10;
      const MAX_BYTES_PER_SCRIPT = 1000000;
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const safeUrlSample = (v) => String(v || '').slice(0, 220);
      const extractSchemaTypes = (text) => {
        const body = String(text || '');
        const types = [];
        const patterns = [
          /["@]type["']?\s*:\s*["']([^"']{1,100})["']/gi,
          /\\"@type\\"\s*:\s*\\"([^"\\]{1,100})\\"/gi,
          /@type\\?["']?\s*[:=]\s*\\?["']([^"'\\]{1,100})/gi
        ];
        patterns.forEach((re) => {
          let m;
          while ((m = re.exec(body)) && types.length < 80) {
            const t = clean(m[1]);
            if (t) types.push(t);
          }
        });
        return Array.from(new Set(types)).slice(0, 50);
      };
      const makeTextSample = (text) => {
        const body = String(text || '');
        const idxs = [
          body.indexOf('@context'),
          body.indexOf('\\"@context\\"'),
          body.indexOf('schema.org'),
          body.indexOf('@type'),
          body.indexOf('\\"@type\\"')
        ].filter((n) => n >= 0);
        const idx = idxs.length ? Math.min.apply(null, idxs) : 0;
        return clean(body.slice(Math.max(0, idx - 80), idx + 260));
      };
      const parseWholeJsonTypes = (text) => {
        const found = [];
        const walk = (node, depth = 0) => {
          if (depth > 10 || node == null) return;
          if (Array.isArray(node)) {
            node.forEach((item) => walk(item, depth + 1));
            return;
          }
          if (typeof node !== 'object') return;
          const t = node['@type'];
          if (Array.isArray(t)) t.forEach((x) => found.push(clean(x)));
          else if (t) found.push(clean(t));
          Object.keys(node).forEach((k) => {
            if (k === '@type') return;
            if (k === '@context') return;
            walk(node[k], depth + 1);
          });
        };
        try {
          walk(JSON.parse(String(text || '')));
          return Array.from(new Set(found.filter(Boolean))).slice(0, 50);
        } catch (_) {
          return [];
        }
      };
      logSf('JSONLD_SCRIPT_SRC_PROBE_ENTER', {
        url: String(urlToFetch || '').slice(0, 180),
        finalUrl: String(finalUrl || '').slice(0, 180),
        status
      });
      logSfMemory('jsonld_script_src_probe_enter');

      let scriptSrcs = [];
      let renderedScriptSrcs = [];
      let htmlScriptSrcs = [];
      let htmlLength = 0;
      try {
        renderedScriptSrcs = await page.evaluate(() => {
          const out = [];
          Array.from(document.querySelectorAll('script[src]')).forEach((s) => {
            const src = s && s.getAttribute && s.getAttribute('src');
            if (!src) return;
            try {
              out.push(new URL(src, location.href).toString());
            } catch (_) {}
          });
          return out;
        }).catch(() => []);
        const html = await page.content().catch(() => '');
        htmlLength = String(html || '').length;
        const $ = cheerio.load(html || '');
        $('script[src]').each((_, el) => {
          const src = String($(el).attr('src') || '').trim();
          if (!src) return;
          try {
            htmlScriptSrcs.push(new URL(src, finalUrl || urlToFetch).toString());
          } catch (_) {}
        });
      } catch (_) {}

      scriptSrcs = uniq([].concat(renderedScriptSrcs || []).concat(htmlScriptSrcs || []).filter(Boolean));
      let origin = '';
      try { origin = new URL(finalUrl || urlToFetch).origin; } catch (_) {}
      const sameOriginScripts = scriptSrcs.filter((u) => {
        try { return new URL(u).origin === origin; } catch (_) { return false; }
      });
      const targetScripts = sameOriginScripts.slice(0, MAX_SCRIPTS);
      const candidates = [];
      let fetchedScriptCount = 0;
      let skippedLargeScriptCount = 0;
      let parseableCount = 0;
      let totalFetchedBytes = 0;
      let maxScriptLength = 0;
      for (const scriptUrl of targetScripts) {
        const result = {
          urlSample: safeUrlSample(scriptUrl),
          approxLength: 0,
          hasContext: false,
          hasType: false,
          hasSchemaOrg: false,
          parseable: false,
          typesSample: [],
          textSample: ''
        };
        try {
          const r = await page.request.get(scriptUrl, { timeout: 10000 });
          const headers = typeof r.headers === 'function' ? r.headers() : {};
          const contentLength = Number(headers['content-length'] || headers['Content-Length'] || 0);
          if (contentLength > MAX_BYTES_PER_SCRIPT) {
            skippedLargeScriptCount += 1;
            result.approxLength = contentLength;
            result.skippedReason = 'script_too_large_header';
            if (candidates.length < 20) candidates.push(result);
            continue;
          }
          const text = await r.text();
          const len = String(text || '').length;
          result.approxLength = len;
          totalFetchedBytes += len;
          maxScriptLength = Math.max(maxScriptLength, len);
          if (len > MAX_BYTES_PER_SCRIPT) {
            skippedLargeScriptCount += 1;
            result.skippedReason = 'script_too_large_body';
            if (candidates.length < 20) candidates.push(result);
            continue;
          }
          fetchedScriptCount += 1;
          result.hasContext = /@context|\\"@context\\"/.test(text);
          result.hasType = /@type|\\"@type\\"/.test(text);
          result.hasSchemaOrg = /schema\.org/i.test(text);
          const parsedTypes = parseWholeJsonTypes(text);
          const regexTypes = extractSchemaTypes(text);
          result.parseable = parsedTypes.length > 0;
          if (result.parseable) parseableCount += 1;
          result.typesSample = Array.from(new Set([].concat(parsedTypes, regexTypes).filter(Boolean))).slice(0, 20);
          result.textSample = (result.hasContext || result.hasType || result.hasSchemaOrg) ? makeTextSample(text).slice(0, 360) : '';
          if ((result.hasContext || result.hasType || result.hasSchemaOrg || result.typesSample.length) && candidates.length < 20) {
            candidates.push(result);
          }
        } catch (e) {
          result.errorMessage = String(e && (e.message || e) || '').slice(0, 180);
          if (candidates.length < 20) candidates.push(result);
        }
      }

      const types = Array.from(new Set([].concat.apply([], candidates.map((c) => Array.isArray(c.typesSample) ? c.typesSample : [])).filter(Boolean))).slice(0, 50);
      const typeSet = new Set(types.map((t) => String(t || '').toLowerCase()));
      const out = {
        ok: true,
        mode: 'jsonLdScriptSrcProbe',
        url: urlToFetch,
        finalUrl,
        status,
        scriptSrcCount: scriptSrcs.length,
        sameOriginScriptCount: sameOriginScripts.length,
        fetchedScriptCount,
        skippedLargeScriptCount,
        jsonLdCandidateCount: candidates.filter((c) => c && (c.hasContext || c.hasType || c.hasSchemaOrg || (Array.isArray(c.typesSample) && c.typesSample.length))).length,
        parseableCount,
        types,
        hasWebsite: typeSet.has('website'),
        hasOrganization: typeSet.has('organization') || typeSet.has('corporation') || typeSet.has('localbusiness'),
        hasBreadcrumbList: typeSet.has('breadcrumblist'),
        hasFAQPage: typeSet.has('faqpage'),
        candidates,
        diagnostics: {
          probeOnly: true,
          fullScrapeSkipped: true,
          rawJsReturned: false,
          maxScripts: MAX_SCRIPTS,
          maxBytesPerScript: MAX_BYTES_PER_SCRIPT,
          htmlLength,
          renderedScriptSrcCount: Array.isArray(renderedScriptSrcs) ? renderedScriptSrcs.length : 0,
          htmlScriptSrcCount: Array.isArray(htmlScriptSrcs) ? htmlScriptSrcs.length : 0,
          appIndexDetected: sameOriginScripts.some((u) => /\/app-index\.js(?:[?#]|$)/.test(String(u || ''))),
          totalFetchedBytes,
          maxScriptLength,
          elapsedMs: Date.now() - startedAt
        }
      };
      logSf('JSONLD_SCRIPT_SRC_PROBE_SEND', {
        scriptSrcCount: out.scriptSrcCount,
        sameOriginScriptCount: out.sameOriginScriptCount,
        fetchedScriptCount: out.fetchedScriptCount,
        skippedLargeScriptCount: out.skippedLargeScriptCount,
        jsonLdCandidateCount: out.jsonLdCandidateCount,
        parseableCount: out.parseableCount,
        types: out.types,
        appIndexDetected: out.diagnostics.appIndexDetected,
        elapsedMs: out.diagnostics.elapsedMs
      });
      logSfMemory('jsonld_script_src_probe_send');
      return res.status(200).json(out);
    }
    if (probeMode === 'primaryrisk') {
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      const status = resp && typeof resp.status === 'function' ? resp.status() : null;
      logSf('PRIMARY_RISK_PROBE_ENTER', {
        url: String(urlToFetch || '').slice(0, 180),
        finalUrl: String(finalUrl || '').slice(0, 180),
        status
      });
      logSfMemory('primary_risk_probe_enter');
      const startedAt = Date.now();
      let probe = null;
      let probeError = null;
      try {
        probe = await page.evaluate(() => {
          const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();
          const lower = (v) => clean(v).toLowerCase();
          const title = clean(document.title || '');
          const bodyText = clean(document.body && (document.body.innerText || document.body.textContent));
          const htmlLengthEstimate = String((document.documentElement && document.documentElement.outerHTML) || '').length;
          const scripts = Array.from(document.querySelectorAll('script'));
          const scriptsWithSrc = scripts
            .map((s) => {
              const src = s && s.getAttribute ? (s.getAttribute('src') || '') : '';
              let href = '';
              try { href = src ? new URL(src, location.href).toString() : ''; } catch (_) { href = src; }
              return {
                src: href,
                type: clean(s && s.getAttribute ? s.getAttribute('type') : ''),
                async: !!(s && s.async),
                defer: !!(s && s.defer)
              };
            })
            .filter((s) => s.src);
          const perfScripts = (() => {
            try {
              return performance.getEntriesByType('resource')
                .filter((r) => r && /script|javascript|ecmascript/i.test(String(r.initiatorType || '') + ' ' + String(r.name || '')))
                .map((r) => ({
                  name: String(r.name || ''),
                  transferSize: Number(r.transferSize || 0),
                  encodedBodySize: Number(r.encodedBodySize || 0),
                  duration: Number(r.duration || 0)
                }));
            } catch (_) {
              return [];
            }
          })();
          const hasRoot = (sel) => !!document.querySelector(sel);
          const rootIndicators = {
            hasNextRoot: hasRoot('#__next'),
            hasNuxtRoot: hasRoot('#__nuxt'),
            hasAppRoot: hasRoot('#app,#root,[data-reactroot],[id*="app" i]'),
            hasMain: hasRoot('main,[role="main"]')
          };
          const textAll = lower(`${title} ${bodyText.slice(0, 3000)} ${location.href}`);
          const blockedPageIndications = {
            errBlockedByClient: /err_blocked_by_client/i.test(textAll),
            extensionBlocked: /拡張機能によってブロック|ブロックされています/i.test(textAll),
            chromeError: /^chrome-error:/i.test(String(location.href || '')),
            accessDenied: /access denied|forbidden|permission denied|アクセスできません|拒否されました/i.test(textAll),
            ageGate: /年齢確認|age verification|生年月日|18歳以上/i.test(textAll)
          };
          const scriptUrls = scriptsWithSrc.map((s) => s.src);
          const chunkLikeUrls = scriptUrls.filter((u) => /chunk|webpack|next\/static|_next\/static|app-|main-|runtime|vendor|bundle|\.m?js(?:\?|$)/i.test(u));
          const scriptHosts = scriptUrls.map((u) => {
            try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
          }).filter(Boolean);
          const locationHost = String(location.hostname || '').replace(/^www\./, '');
          const externalScriptHosts = Array.from(new Set(scriptHosts.filter((h) => h && h !== locationHost && !h.endsWith('.' + locationHost))));
          const widgetScriptUrls = scriptUrls.filter((u) => /googletagmanager|google-analytics|youtube|probo|poplink|creativecdn|chat|karte|clarity|hotjar|doubleclick/i.test(u));
          const moduleScriptCount = scriptsWithSrc.filter((s) => /module/i.test(s.type)).length;
          const preloadScriptCount = Array.from(document.querySelectorAll('link[rel="preload"],link[rel="modulepreload"]'))
            .filter((l) => /script|javascript|\.m?js/i.test(String(l.getAttribute('as') || '') + ' ' + String(l.getAttribute('href') || '')))
            .length;
          const perfTotalTransferSize = perfScripts.reduce((sum, r) => sum + Number(r.transferSize || r.encodedBodySize || 0), 0);
          const perfMaxTransferSize = perfScripts.reduce((max, r) => Math.max(max, Number(r.transferSize || r.encodedBodySize || 0)), 0);
          return {
            title,
            bodyTextLength: bodyText.length,
            htmlLengthEstimate,
            scriptCount: scriptsWithSrc.length,
            inlineScriptCount: Math.max(0, scripts.length - scriptsWithSrc.length),
            moduleScriptCount,
            preloadScriptCount,
            chunkLikeCount: chunkLikeUrls.length,
            nextStaticCount: scriptUrls.filter((u) => /_next\/static|next\/static/i.test(u)).length,
            externalScriptHostCount: externalScriptHosts.length,
            widgetScriptCount: widgetScriptUrls.length,
            sampleExternalScriptHosts: externalScriptHosts.slice(0, 10),
            sampleWidgetScriptUrls: widgetScriptUrls.slice(0, 10),
            sampleScriptUrls: scriptUrls.slice(0, 10),
            sampleChunkUrls: chunkLikeUrls.slice(0, 10),
            totalScriptUrlChars: scriptUrls.reduce((sum, u) => sum + String(u || '').length, 0),
            perfScriptCount: perfScripts.length,
            perfTotalTransferSize,
            perfMaxTransferSize,
            rootIndicators,
            blockedPageIndications
          };
        });
      } catch (e) {
        probeError = String(e && (e.message || e) || 'primary_risk_probe_error').slice(0, 240);
      }
      const reasons = [];
      const estimates = {
        htmlLengthEstimate: probe && typeof probe.htmlLengthEstimate === 'number' ? probe.htmlLengthEstimate : null,
        bodyTextLength: probe && typeof probe.bodyTextLength === 'number' ? probe.bodyTextLength : null,
        scriptCount: probe && typeof probe.scriptCount === 'number' ? probe.scriptCount : null,
        chunkLikeCount: probe && typeof probe.chunkLikeCount === 'number' ? probe.chunkLikeCount : null,
        externalScriptHostCount: probe && typeof probe.externalScriptHostCount === 'number' ? probe.externalScriptHostCount : null,
        widgetScriptCount: probe && typeof probe.widgetScriptCount === 'number' ? probe.widgetScriptCount : null,
        perfScriptCount: probe && typeof probe.perfScriptCount === 'number' ? probe.perfScriptCount : null,
        perfTotalTransferSize: probe && typeof probe.perfTotalTransferSize === 'number' ? probe.perfTotalTransferSize : null,
        perfMaxTransferSize: probe && typeof probe.perfMaxTransferSize === 'number' ? probe.perfMaxTransferSize : null
      };
      const rootIndicators = probe && probe.rootIndicators ? probe.rootIndicators : {};
      const blockedPageIndications = probe && probe.blockedPageIndications ? probe.blockedPageIndications : {};
      if (probeError) reasons.push('probe_evaluate_failed');
      if (status != null && status >= 500) reasons.push('status_5xx');
      if (status != null && status >= 400 && status < 500) reasons.push('status_4xx');
      if (estimates.htmlLengthEstimate != null && estimates.htmlLengthEstimate > 500000) reasons.push('large_rendered_html_estimate');
      if (estimates.scriptCount != null && estimates.scriptCount >= 35) reasons.push('many_script_resources');
      if (estimates.chunkLikeCount != null && estimates.chunkLikeCount >= 15) reasons.push('many_chunk_like_scripts');
      if (estimates.scriptCount != null && estimates.scriptCount >= 8 && estimates.chunkLikeCount != null && estimates.chunkLikeCount >= 6) reasons.push('js_bundle_risk');
      if (estimates.externalScriptHostCount != null && estimates.externalScriptHostCount >= 3) reasons.push('third_party_script_stack');
      if (estimates.widgetScriptCount != null && estimates.widgetScriptCount >= 2) reasons.push('third_party_widget_scripts');
      if (estimates.bodyTextLength != null && estimates.bodyTextLength < 2500 && estimates.chunkLikeCount != null && estimates.chunkLikeCount >= 5) reasons.push('script_rendered_site_indicator');
      if (estimates.perfTotalTransferSize != null && estimates.perfTotalTransferSize > 3000000) reasons.push('large_script_transfer_estimate');
      if (estimates.perfMaxTransferSize != null && estimates.perfMaxTransferSize > 1000000) reasons.push('large_single_script_transfer_estimate');
      if (rootIndicators.hasNextRoot || rootIndicators.hasNuxtRoot || rootIndicators.hasAppRoot) reasons.push('spa_root_indicator');
      if (blockedPageIndications.errBlockedByClient || blockedPageIndications.extensionBlocked || blockedPageIndications.chromeError) reasons.push('browser_or_extension_block_page_indicator');
      if (blockedPageIndications.accessDenied) reasons.push('access_denied_indicator');
      if (blockedPageIndications.ageGate) reasons.push('age_gate_indicator');
      const highReasons = reasons.filter((r) => [
        'status_5xx',
        'large_rendered_html_estimate',
        'many_script_resources',
        'many_chunk_like_scripts',
        'js_bundle_risk',
        'large_script_transfer_estimate',
        'large_single_script_transfer_estimate',
        'browser_or_extension_block_page_indicator'
      ].includes(r));
      const risk = highReasons.length ? 'high' : (reasons.length ? 'medium' : 'low');
      const shouldUseBalanced = risk === 'high' || (
        risk === 'medium' &&
        (reasons.includes('spa_root_indicator') || reasons.includes('age_gate_indicator') || reasons.includes('access_denied_indicator'))
      );
      const elapsedMs = Date.now() - startedAt;
      logSf('PRIMARY_RISK_PROBE_SEND', {
        risk,
        shouldUseBalanced,
        reasons,
        elapsedMs
      });
      logSfMemory('primary_risk_probe_send');
      return res.status(200).json({
        ok: !probeError,
        mode: 'primaryRiskProbe',
        url: urlToFetch,
        finalUrl,
        status,
        risk,
        shouldUseBalanced,
        reasons,
        estimates,
        title: probe && probe.title ? probe.title : null,
        rootIndicators,
        blockedPageIndications,
        scriptSummary: probe ? {
          inlineScriptCount: probe.inlineScriptCount,
          moduleScriptCount: probe.moduleScriptCount,
          preloadScriptCount: probe.preloadScriptCount,
          chunkLikeCount: probe.chunkLikeCount,
          nextStaticCount: probe.nextStaticCount,
          externalScriptHostCount: probe.externalScriptHostCount,
          widgetScriptCount: probe.widgetScriptCount,
          totalScriptUrlChars: probe.totalScriptUrlChars,
          sampleExternalScriptHosts: Array.isArray(probe.sampleExternalScriptHosts) ? probe.sampleExternalScriptHosts : [],
          sampleWidgetScriptUrls: Array.isArray(probe.sampleWidgetScriptUrls) ? probe.sampleWidgetScriptUrls : [],
          sampleScriptUrls: Array.isArray(probe.sampleScriptUrls) ? probe.sampleScriptUrls : [],
          sampleChunkUrls: Array.isArray(probe.sampleChunkUrls) ? probe.sampleChunkUrls : []
        } : null,
        diagnostics: {
          probeOnly: true,
          fullScrapeSkipped: true,
          scoringSkipped: true,
          auditSigSkipped: true,
          jsScanSkipped: true,
          chunkScanSkipped: true,
          elapsedMs,
          errorMessage: probeError
        }
      });
    }
    if (signalsFirstLight || signalsFirstBalanced) {
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      const heavySiteMemorySnapshot = () => {
        try {
          const memory = process.memoryUsage();
          return {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers
          };
        } catch (_) {
          return null;
        }
      };
      const logHeavySiteInvestigationAudit = (phase, details = {}) => {
        if (!debugHeavySite) return;
        try {
          console.log('[DEBUG][HEAVY_SITE_INVESTIGATION_AUDIT]', JSON.stringify({
            phase,
            route: '/scrape',
            url: urlToFetch,
            finalUrl,
            origin: (() => { try { return new URL(String(finalUrl || urlToFetch || '')).origin; } catch (_) { return ''; } })(),
            signalsMode,
            responseMode,
            subpageObservationMode,
            normalizedSubpageObservationMode: subpageObservationMode.replace(/[^a-z]/g, ''),
            debugHeavySite: true,
            elapsedMs: Date.now() - debugHeavySiteStartedAt,
            memory: heavySiteMemorySnapshot(),
            details
          }));
        } catch (_) {}
      };
      logHeavySiteInvestigationAudit('request_mode', {
        signalsFirstLight,
        signalsFirstBalanced,
        balancedShortResponse,
        balancedShortFastResponse
      });
      logSf(signalsFirstBalanced ? 'SIGNALS_FIRST_BALANCED_ENTER' : 'SIGNALS_FIRST_LIGHT_ENTER', {
        url: String(urlToFetch || '').slice(0, 180),
        finalUrl: String(finalUrl || '').slice(0, 180),
        responseMode: balancedShortFastResponse ? 'shortFast' : (balancedShortResponse ? 'short' : 'default')
      });
      logSfMemory(signalsFirstBalanced ? 'signals_first_balanced_enter' : 'signals_first_light_enter');
      const boundedHydrationWaitMs = signalsFirstBalanced ? (balancedShortFastResponse ? 1200 : 3500) : 3500;
      logHeavySiteTopPageAudit('collectBalancedHydrationMetrics_start', {
        boundedHydrationWaitMs,
        shortFastMode: balancedShortFastResponse
      });
      const hydrationMetrics = await collectBalancedHydrationMetrics(page, boundedHydrationWaitMs, {
        shortFastMode: balancedShortFastResponse,
        debugHeavySite,
        debugHeavySiteStartedAt,
        url: String(urlToFetch || ''),
        finalUrl: String(finalUrl || '')
      });
      logHeavySiteTopPageAudit('collectBalancedHydrationMetrics_end', {
        waitMs: hydrationMetrics && hydrationMetrics.waitMs,
        bodyTextBeforeWait: hydrationMetrics && hydrationMetrics.bodyTextBeforeWait,
        bodyTextAfterWait: hydrationMetrics && hydrationMetrics.bodyTextAfterWait,
        anchorCountBeforeWait: hydrationMetrics && hydrationMetrics.anchorCountBeforeWait,
        anchorCountAfterWait: hydrationMetrics && hydrationMetrics.anchorCountAfterWait
      });
      if (signalsFirstBalanced || signalsFirstLight) {
        logSf(signalsFirstBalanced ? 'SIGNALS_FIRST_BALANCED_HYDRATION_WAIT' : 'SIGNALS_FIRST_LIGHT_HYDRATION_WAIT', {
          waitMs: hydrationMetrics && hydrationMetrics.waitMs,
          bodyTextBeforeWait: hydrationMetrics && hydrationMetrics.bodyTextBeforeWait,
          bodyTextAfterWait: hydrationMetrics && hydrationMetrics.bodyTextAfterWait,
          anchorCountBeforeWait: hydrationMetrics && hydrationMetrics.anchorCountBeforeWait,
          anchorCountAfterWait: hydrationMetrics && hydrationMetrics.anchorCountAfterWait,
          navLinkCountBeforeWait: hydrationMetrics && hydrationMetrics.navLinkCountBeforeWait,
          navLinkCountAfterWait: hydrationMetrics && hydrationMetrics.navLinkCountAfterWait,
          improvedBodyText: hydrationMetrics && hydrationMetrics.improvedBodyText,
          improvedLinks: hydrationMetrics && hydrationMetrics.improvedLinks,
          warningTextAfterWait: hydrationMetrics && hydrationMetrics.warningTextAfterWait
        });
      }
      logHeavySiteTopPageAudit('buildGeoSignalsV1_start', {
        balancedMode: signalsFirstBalanced,
        shortFastMode: balancedShortFastResponse
      });
      const geoSignalsV1 = await buildGeoSignalsV1(page, finalUrl || urlToFetch, {
        balancedMode: signalsFirstBalanced,
        shortFastMode: balancedShortFastResponse,
        siteMode,
        boundedHydrationWaitMs,
        hydrationMetrics,
        gotoMs: typeof scrapeTiming.gotoMs === 'number'
          ? scrapeTiming.gotoMs
          : (scrapeTiming && scrapeTiming.spans ? Number(scrapeTiming.spans.initial_goto_and_waits || 0) : null),
        debugHeavySite,
        debugHeavySiteStartedAt
      });
      logHeavySiteTopPageAudit('buildGeoSignalsV1_end', {
        hasGeoSignalsV1: !!geoSignalsV1,
        geoKeys: geoSignalsV1 && typeof geoSignalsV1 === 'object' ? Object.keys(geoSignalsV1).slice(0, 40) : []
      });
      logHeavySiteTopPageAudit('structuredData_extraction_end', {
        hasStructuredData: !!(geoSignalsV1 && geoSignalsV1.structuredData),
        hasJsonLd: geoSignalsV1 && geoSignalsV1.structuredData && geoSignalsV1.structuredData.hasJsonLd,
        hasWebsite: geoSignalsV1 && geoSignalsV1.structuredData && geoSignalsV1.structuredData.hasWebsite,
        hasOrganization: geoSignalsV1 && geoSignalsV1.structuredData && geoSignalsV1.structuredData.hasOrganization,
        rawCount: geoSignalsV1 && geoSignalsV1.structuredData && geoSignalsV1.structuredData.rawCount
      });
      logHeavySiteTopPageAudit('headings_extraction_end', {
        hasHeadings: !!(geoSignalsV1 && geoSignalsV1.headings),
        h1Count: geoSignalsV1 && geoSignalsV1.headings && geoSignalsV1.headings.h1Count,
        hasH1: geoSignalsV1 && geoSignalsV1.headings && geoSignalsV1.headings.hasH1,
        source: geoSignalsV1 && geoSignalsV1.headings && geoSignalsV1.headings.source
      });
      logHeavySiteTopPageAudit('link_extraction_end', {
        navLinkCount: geoSignalsV1 && geoSignalsV1.observed && geoSignalsV1.observed.links && geoSignalsV1.observed.links.navLinkCount,
        internalLinkCount: geoSignalsV1 && geoSignalsV1.observed && geoSignalsV1.observed.links && geoSignalsV1.observed.links.internalLinkCount,
        externalLinkCount: geoSignalsV1 && geoSignalsV1.observed && geoSignalsV1.observed.links && geoSignalsV1.observed.links.externalLinkCount
      });
      logHeavySiteTopPageAudit('trust_social_footer_extraction_end', {
        hasTrustSignals: !!(geoSignalsV1 && geoSignalsV1.trustSignals),
        hasFooterSignals: !!(geoSignalsV1 && geoSignalsV1.footerSignals),
        sameAsObserved: geoSignalsV1 && geoSignalsV1.structuredData && geoSignalsV1.structuredData.sameAsSummary && geoSignalsV1.structuredData.sameAsSummary.observed,
        sameAsCount: geoSignalsV1 && geoSignalsV1.structuredData && geoSignalsV1.structuredData.sameAsSummary && geoSignalsV1.structuredData.sameAsSummary.count
      });
      logHeavySiteTopPageAudit('attachCoverageSignalsToGeoSignalsLight_call_start', {
        subpageObservationMode,
        maxObserve: 2
      });
      await attachCoverageSignalsToGeoSignalsLight_(geoSignalsV1, finalUrl || urlToFetch, {
        page,
        context,
        reuseBrowser: true,
        maxObserve: 2,
        subpageObservationMode,
        siteMode,
        signalsMode,
        debugHeavySite,
        debugHeavySiteStartedAt
      });
      logHeavySiteTopPageAudit('attachCoverageSignalsToGeoSignalsLight_call_end', {
        hasCoverageSignals: !!(geoSignalsV1 && geoSignalsV1.coverageSignals),
        observedSubpageCount: geoSignalsV1 && geoSignalsV1.coverageSignals && geoSignalsV1.coverageSignals.observedSubpageCount
      });
      const observed = geoSignalsV1 && geoSignalsV1.observed ? geoSignalsV1.observed : {};
      const linksObserved = observed.links || {};
      const headingsObserved = observed.headings || {};
      const topHeadingsObserved = geoSignalsV1 && geoSignalsV1.headings ? geoSignalsV1.headings : {};
      const landmarksObserved = (geoSignalsV1 && geoSignalsV1.landmarks) || observed.landmarks || {};
      const structuredObserved = observed.structuredData || {};
      const multimodalObserved = (geoSignalsV1 && geoSignalsV1.multimodalSignals) || observed.multimodalSignals || {};
      const clarityObserved = (geoSignalsV1 && geoSignalsV1.clarity) || observed.clarity || {};
      const trustObserved = (geoSignalsV1 && geoSignalsV1.trustSignals) || observed.trustSignals || {};
      const coverageObserved = (geoSignalsV1 && geoSignalsV1.coverage) || observed.coverage || {};
      const semanticObserved = coverageObserved && coverageObserved.semanticElements && typeof coverageObserved.semanticElements === 'object'
        ? coverageObserved.semanticElements
        : {};
      const bodyObserved = observed.body || {};
      const sitemapDiscoveryLight = await (async () => {
        let origin = '';
        try { origin = new URL(String(finalUrl || urlToFetch || '')).origin; } catch (_) {}
        if (!origin) return { checked: false, exists: null, url: null, httpStatus: null, discoveryMethod: 'not_checked', checkedUrls: [], robotsHttpStatus: null, robotsTxtUrl: null };
        const fetchTextWithPageRequest = async (targetUrl, timeoutMs = 1500) => {
          try {
            const response = await page.request.get(targetUrl, {
              timeout: timeoutMs,
              headers: { 'Accept': 'application/xml,text/xml,text/plain,*/*;q=0.8' }
            });
            const status = response && typeof response.status === 'function' ? response.status() : null;
            const headers = response && typeof response.headers === 'function' ? response.headers() : {};
            const contentType = String((headers && (headers['content-type'] || headers['Content-Type'])) || '');
            if (!response || !response.ok()) return { ok: false, status, text: '', contentType };
            const text = String(await response.text() || '').slice(0, 120000);
            return { ok: true, status, text, contentType };
          } catch (e) {
            return { ok: false, status: null, text: '', contentType: '', errorMessage: String(e && (e.message || e) || '').slice(0, 160) };
          }
        };
        return discoverSitemapFromOrigin_(origin, fetchTextWithPageRequest, { timeoutMs: 2500 });
      })();
      const aioCheckLight = {
        checked: sitemapDiscoveryLight.checked === true,
        hasRobotsTxt: sitemapDiscoveryLight.robotsHttpStatus === 200 ? true : (sitemapDiscoveryLight.robotsHttpStatus === 404 ? false : null),
        robotsTxtUrl: sitemapDiscoveryLight.robotsTxtUrl || null,
        robotsAiBotHints: null,
        robotsAiBotHintTokens: [],
        hasSitemapXml: sitemapDiscoveryLight.exists,
        sitemapXmlUrl: sitemapDiscoveryLight.url,
        sitemapDiscoveryMethod: sitemapDiscoveryLight.discoveryMethod,
        sitemapCheckedUrls: Array.isArray(sitemapDiscoveryLight.checkedUrls) ? sitemapDiscoveryLight.checkedUrls.slice(0, 10) : [],
        sitemapHttpStatus: sitemapDiscoveryLight.httpStatus,
        sitemapRobotsTxtUrl: sitemapDiscoveryLight.robotsTxtUrl || null,
        sitemapRobotsHttpStatus: sitemapDiscoveryLight.robotsHttpStatus,
        aiPolicyEvidenceSource: 'not_observed'
      };
      if (geoSignalsV1 && typeof geoSignalsV1 === 'object') {
        attachSitemapDiscoveryToGeoSignals_(geoSignalsV1, sitemapDiscoveryLight);
        geoSignalsV1.aioCheck = Object.assign({}, geoSignalsV1.aioCheck || {}, aioCheckLight);
        geoSignalsV1.observed = geoSignalsV1.observed || {};
        geoSignalsV1.observed.aioCheck = geoSignalsV1.aioCheck;
      }
      const lightweightSummary = {
        title: observed.title && typeof observed.title.value === 'string' ? observed.title.value : null,
        metaDescription: observed.metaDescription && typeof observed.metaDescription.value === 'string' ? observed.metaDescription.value : null,
        h1Count: observed.h1 && typeof observed.h1.count === 'number' ? observed.h1.count : 0,
        h2Count: Array.isArray(headingsObserved.h2) ? headingsObserved.h2.length : 0,
        h1Source: topHeadingsObserved.h1Source || (observed.h1 && observed.h1.source) || null,
        headingSource: topHeadingsObserved.source || headingsObserved.source || null,
        primaryHeadingCandidate: topHeadingsObserved.primaryHeadingCandidate || headingsObserved.primaryHeadingCandidate || null,
        primaryHeadingCandidateSource: topHeadingsObserved.primaryHeadingCandidateSource || headingsObserved.primaryHeadingCandidateSource || null,
        primaryHeadingConfidence: topHeadingsObserved.primaryHeadingConfidence || headingsObserved.primaryHeadingConfidence || null,
        h1EquivalentCandidateFound: Object.prototype.hasOwnProperty.call(topHeadingsObserved, 'h1EquivalentCandidateFound')
          ? topHeadingsObserved.h1EquivalentCandidateFound
          : (Object.prototype.hasOwnProperty.call(headingsObserved, 'h1EquivalentCandidateFound') ? headingsObserved.h1EquivalentCandidateFound : null),
        sectionHeadingCandidate: topHeadingsObserved.sectionHeadingCandidate || headingsObserved.sectionHeadingCandidate || null,
        sectionHeadingCandidateSource: topHeadingsObserved.sectionHeadingCandidateSource || headingsObserved.sectionHeadingCandidateSource || null,
        sectionHeadingConfidence: topHeadingsObserved.sectionHeadingConfidence || headingsObserved.sectionHeadingConfidence || null,
        headingObservationLimited: Object.prototype.hasOwnProperty.call(topHeadingsObserved, 'headingObservationLimited')
          ? topHeadingsObserved.headingObservationLimited
          : !!(observed.h1 && observed.h1.headingObservationLimited),
        hasMainLandmark: Object.prototype.hasOwnProperty.call(landmarksObserved, 'hasMainLandmark') ? landmarksObserved.hasMainLandmark : null,
        hasMainLandmarkFinal: Object.prototype.hasOwnProperty.call(landmarksObserved, 'hasMainLandmark_final') ? landmarksObserved.hasMainLandmark_final : null,
        mainLandmarkSource: landmarksObserved.mainLandmarkSource || null,
        mainLandmarkCandidateFound: Object.prototype.hasOwnProperty.call(landmarksObserved, 'mainLandmarkCandidateFound') ? landmarksObserved.mainLandmarkCandidateFound : null,
        mainLandmarkCandidateSource: landmarksObserved.mainLandmarkCandidateSource || null,
        mainLandmarkObservationLimited: Object.prototype.hasOwnProperty.call(landmarksObserved, 'mainLandmarkObservationLimited')
          ? landmarksObserved.mainLandmarkObservationLimited
          : true,
        hydrationWaitMs: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.hydrationWaitMs === 'number' ? geoSignalsV1.diagnostics.hydrationWaitMs : null,
        bodyTextBeforeWait: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.bodyTextBeforeWait === 'number' ? geoSignalsV1.diagnostics.bodyTextBeforeWait : null,
        bodyTextAfterWait: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.bodyTextAfterWait === 'number' ? geoSignalsV1.diagnostics.bodyTextAfterWait : null,
        hydrationImprovedBodyText: !!(geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.hydrationImprovedBodyText),
        hydrationImprovedLinks: !!(geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.hydrationImprovedLinks),
        balancedMode: signalsFirstBalanced,
        headingShadowScan: !!(geoSignalsV1 && geoSignalsV1.balanced && geoSignalsV1.balanced.shadowHeadingScan),
        headingA11yScan: !balancedShortFastResponse,
        navLinkCount: Array.isArray(linksObserved.navTextsSample) ? linksObserved.navTextsSample.length : 0,
        internalLinkCount: Array.isArray(linksObserved.internalLinksSample) ? linksObserved.internalLinksSample.length : 0,
        externalProfileLinksSample: Array.isArray(linksObserved.externalProfileLinksSample) ? linksObserved.externalProfileLinksSample.slice(0, 10) : [],
        socialLinksSample: Array.isArray(linksObserved.socialLinksSample) ? linksObserved.socialLinksSample.slice(0, 10) : [],
        footerExternalLinksSample: Array.isArray(linksObserved.footerExternalLinksSample) ? linksObserved.footerExternalLinksSample.slice(0, 10) : [],
        externalLinksSample: Array.isArray(linksObserved.externalLinksSample) ? linksObserved.externalLinksSample.slice(0, 10) : [],
        hasCompanyLikeLink: Object.prototype.hasOwnProperty.call(linksObserved, 'hasCompanyLikeLink') ? linksObserved.hasCompanyLikeLink : null,
        hasServiceLikeLink: Object.prototype.hasOwnProperty.call(linksObserved, 'hasServiceLikeLink') ? linksObserved.hasServiceLikeLink : null,
        hasContactLikeLink: Object.prototype.hasOwnProperty.call(linksObserved, 'hasContactLikeLink') ? linksObserved.hasContactLikeLink : null,
        hasPrivacyLikeLink: Object.prototype.hasOwnProperty.call(linksObserved, 'hasPrivacyLikeLink') ? linksObserved.hasPrivacyLikeLink : null,
        ctaTexts: Array.isArray(clarityObserved.ctaTexts) ? clarityObserved.ctaTexts.slice(0, 10) : [],
        ctaCandidatesCount: typeof clarityObserved.ctaCandidatesCount === 'number' ? clarityObserved.ctaCandidatesCount : null,
        ctaObserved: Object.prototype.hasOwnProperty.call(clarityObserved, 'ctaObserved') ? clarityObserved.ctaObserved : null,
        hasHeaderElement: Object.prototype.hasOwnProperty.call(semanticObserved, 'hasHeaderElement') ? semanticObserved.hasHeaderElement : null,
        hasNavElement: Object.prototype.hasOwnProperty.call(semanticObserved, 'hasNavElement') ? semanticObserved.hasNavElement : null,
        hasFooterElement: Object.prototype.hasOwnProperty.call(semanticObserved, 'hasFooterElement') ? semanticObserved.hasFooterElement : null,
        hasFaqLink: Object.prototype.hasOwnProperty.call(coverageObserved, 'hasFaqLink') ? coverageObserved.hasFaqLink : null,
        hasFaqNav: Object.prototype.hasOwnProperty.call(coverageObserved, 'hasFaqNav') ? coverageObserved.hasFaqNav : null,
        hasFaqSection: Object.prototype.hasOwnProperty.call(coverageObserved, 'hasFaqSection') ? coverageObserved.hasFaqSection : null,
        breadcrumbUiObserved: Object.prototype.hasOwnProperty.call(coverageObserved, 'breadcrumbUiObserved') ? coverageObserved.breadcrumbUiObserved : null,
        hasBreadcrumbUi: Object.prototype.hasOwnProperty.call(coverageObserved, 'hasBreadcrumbUi') ? coverageObserved.hasBreadcrumbUi : null,
        breadcrumbUiSource: coverageObserved.breadcrumbUiSource || null,
        bodyTextLength: typeof bodyObserved.textLength === 'number' ? bodyObserved.textLength : 0,
        jsonldCount: typeof structuredObserved.rawCount === 'number' ? structuredObserved.rawCount : 0,
        jsonldParseableCount: typeof structuredObserved.parseableCount === 'number' ? structuredObserved.parseableCount : 0,
        jsonldParseErrorsCount: typeof structuredObserved.parseErrorsCount === 'number' ? structuredObserved.parseErrorsCount : 0,
        jsonldTypes: Array.isArray(structuredObserved.types) ? structuredObserved.types.slice(0, 50) : [],
        seoJsonldCount: Array.isArray(structuredObserved.seoTypes) ? structuredObserved.seoTypes.length : 0,
        seoJsonldTypes: Array.isArray(structuredObserved.seoTypes) ? structuredObserved.seoTypes.slice(0, 50) : [],
        nonSeoJsonldTypes: Array.isArray(structuredObserved.nonSeoTypes) ? structuredObserved.nonSeoTypes.slice(0, 50) : [],
        telemetryJsonldTypes: Array.isArray(structuredObserved.telemetryTypes) ? structuredObserved.telemetryTypes.slice(0, 50) : [],
        hasJsonLd: Object.prototype.hasOwnProperty.call(structuredObserved, 'hasJsonLd') ? structuredObserved.hasJsonLd : null,
        hasSeoJsonLd: Object.prototype.hasOwnProperty.call(structuredObserved, 'hasSeoJsonLd') ? structuredObserved.hasSeoJsonLd : null,
        hasWebsiteJsonLd: Object.prototype.hasOwnProperty.call(structuredObserved, 'hasWebsite') ? structuredObserved.hasWebsite : null,
        hasOrgJsonLd: Object.prototype.hasOwnProperty.call(structuredObserved, 'hasOrganization') ? structuredObserved.hasOrganization : null,
        hasBreadcrumbJsonLd: Object.prototype.hasOwnProperty.call(structuredObserved, 'hasBreadcrumbList') ? structuredObserved.hasBreadcrumbList : null,
        hasFaqJsonLd: Object.prototype.hasOwnProperty.call(structuredObserved, 'hasFAQPage') ? structuredObserved.hasFAQPage : null,
        articleSignals: geoSignalsV1 && geoSignalsV1.articleSignals && typeof geoSignalsV1.articleSignals === 'object' ? geoSignalsV1.articleSignals : null,
        structuredDataObservationLimited: Object.prototype.hasOwnProperty.call(structuredObserved, 'observationLimited') ? structuredObserved.observationLimited : true,
        structuredDataObservationScope: structuredObserved.observationScope || 'rendered_dom_only',
        structuredDataRenderedDomObserved: Object.prototype.hasOwnProperty.call(structuredObserved, 'renderedDomObserved') ? structuredObserved.renderedDomObserved : true,
        structuredDataHtmlContentLdJsonObserved: Object.prototype.hasOwnProperty.call(structuredObserved, 'htmlContentLdJsonObserved') ? structuredObserved.htmlContentLdJsonObserved : false,
        structuredDataHtmlContentRawCount: typeof structuredObserved.htmlContentRawCount === 'number' ? structuredObserved.htmlContentRawCount : 0,
        structuredDataHtmlContentParseableCount: typeof structuredObserved.htmlContentParseableCount === 'number' ? structuredObserved.htmlContentParseableCount : 0,
        structuredDataScriptSrcJsonLdObserved: Object.prototype.hasOwnProperty.call(structuredObserved, 'scriptSrcJsonLdObserved') ? structuredObserved.scriptSrcJsonLdObserved : false,
        structuredDataScriptSrcCandidateCount: typeof structuredObserved.scriptSrcCandidateCount === 'number' ? structuredObserved.scriptSrcCandidateCount : 0,
        structuredDataScriptSrcFetchedCount: typeof structuredObserved.scriptSrcFetchedCount === 'number' ? structuredObserved.scriptSrcFetchedCount : 0,
        structuredDataScriptSrcJsonLdCandidateCount: typeof structuredObserved.scriptSrcJsonLdCandidateCount === 'number' ? structuredObserved.scriptSrcJsonLdCandidateCount : 0,
        structuredDataScriptSrcJsonLdTypes: Array.isArray(structuredObserved.scriptSrcJsonLdTypes) ? structuredObserved.scriptSrcJsonLdTypes.slice(0, 50) : [],
        structuredDataExcludedFromSeoTypes: Array.isArray(structuredObserved.excludedFromSeoTypes) ? structuredObserved.excludedFromSeoTypes.slice(0, 50) : [],
        structuredDataTypeClassificationSource: structuredObserved.typeClassificationSource || '',
        organizationSummary: structuredObserved.organizationSummary || null,
        sameAsSummary: structuredObserved.sameAsSummary || null,
        sameAsObserved: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.observed : null,
        sameAsCount: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.count : null,
        sameAsExternalCount: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.externalCount : null,
        sameAsCountByType: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.sameAsCountByType : null,
        hasOrganizationSameAs: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.hasOrganizationSameAs : null,
        hasWebSiteSameAs: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.hasWebSiteSameAs : null,
        hasPersonSameAs: structuredObserved.sameAsSummary ? structuredObserved.sameAsSummary.hasPersonSameAs : null,
        sameAsValuesSample: structuredObserved.sameAsSummary && Array.isArray(structuredObserved.sameAsSummary.valuesSample)
          ? structuredObserved.sameAsSummary.valuesSample.slice(0, 8)
          : [],
        structuredDataScriptSrcAppIndexDetected: Object.prototype.hasOwnProperty.call(structuredObserved, 'scriptSrcAppIndexDetected') ? structuredObserved.scriptSrcAppIndexDetected : false,
        structuredDataHtmlScanSkipped: Object.prototype.hasOwnProperty.call(structuredObserved, 'htmlScanSkipped') ? structuredObserved.htmlScanSkipped : true,
        structuredDataJsScanSkipped: Object.prototype.hasOwnProperty.call(structuredObserved, 'jsScanSkipped') ? structuredObserved.jsScanSkipped : true,
        structuredDataChunkScanSkipped: Object.prototype.hasOwnProperty.call(structuredObserved, 'chunkScanSkipped') ? structuredObserved.chunkScanSkipped : true,
        hasOgImage: Object.prototype.hasOwnProperty.call(multimodalObserved, 'hasOgImage') ? multimodalObserved.hasOgImage : null,
        hasTwitterImage: Object.prototype.hasOwnProperty.call(multimodalObserved, 'hasTwitterImage') ? multimodalObserved.hasTwitterImage : null,
        hasFavicon: Object.prototype.hasOwnProperty.call(multimodalObserved, 'hasFavicon') ? multimodalObserved.hasFavicon : null,
        hasAppleTouchIcon: Object.prototype.hasOwnProperty.call(multimodalObserved, 'hasAppleTouchIcon') ? multimodalObserved.hasAppleTouchIcon : null,
        hasStructuredLogo: Object.prototype.hasOwnProperty.call(multimodalObserved, 'hasStructuredLogo') ? multimodalObserved.hasStructuredLogo : null,
        imageObjectCount: Object.prototype.hasOwnProperty.call(multimodalObserved, 'imageObjectCount') ? multimodalObserved.imageObjectCount : null,
        structuredImageCount: Object.prototype.hasOwnProperty.call(multimodalObserved, 'structuredImageCount') ? multimodalObserved.structuredImageCount : null,
        imgCount: Object.prototype.hasOwnProperty.call(multimodalObserved, 'imgCount') ? multimodalObserved.imgCount : null,
        hasContactLink: Object.prototype.hasOwnProperty.call(trustObserved, 'hasContactLink') ? trustObserved.hasContactLink : null,
        contactPathFound: Object.prototype.hasOwnProperty.call(trustObserved, 'contactPathFound') ? trustObserved.contactPathFound : null,
        contactObservedFromDom: Object.prototype.hasOwnProperty.call(trustObserved, 'contactObservedFromDom') ? trustObserved.contactObservedFromDom : null,
        contactObservedFromScriptHint: Object.prototype.hasOwnProperty.call(trustObserved, 'contactObservedFromScriptHint') ? trustObserved.contactObservedFromScriptHint : null,
        contactPathHintOnly: Object.prototype.hasOwnProperty.call(trustObserved, 'contactPathHintOnly') ? trustObserved.contactPathHintOnly : null,
        contactLinkSource: trustObserved.contactLinkSource || linksObserved.contactLinkSource || null,
        companyLinkSource: trustObserved.companyLinkSource || linksObserved.companyLinkSource || null,
        serviceLinkSource: trustObserved.serviceLinkSource || linksObserved.serviceLinkSource || null,
        privacyLinkSource: trustObserved.privacyLinkSource || linksObserved.privacyLinkSource || null,
        hasSitemapXml: sitemapDiscoveryLight.exists,
        sitemapXmlUrl: sitemapDiscoveryLight.url,
        sitemapDiscoveryMethod: sitemapDiscoveryLight.discoveryMethod,
        sitemapCheckedUrls: Array.isArray(sitemapDiscoveryLight.checkedUrls) ? sitemapDiscoveryLight.checkedUrls.slice(0, 10) : [],
        sitemapHttpStatus: sitemapDiscoveryLight.httpStatus,
        sitemapRobotsHttpStatus: sitemapDiscoveryLight.robotsHttpStatus,
        hasPrivacyPolicyLink: Object.prototype.hasOwnProperty.call(trustObserved, 'hasPrivacyPolicyLink') ? trustObserved.hasPrivacyPolicyLink : null,
        hasLegalLink: Object.prototype.hasOwnProperty.call(trustObserved, 'hasLegalLink') ? trustObserved.hasLegalLink : null,
        hasTermsLink: Object.prototype.hasOwnProperty.call(trustObserved, 'hasTermsLink') ? trustObserved.hasTermsLink : null,
        legalLinkSource: trustObserved.legalLinkSource || linksObserved.legalLinkSource || null,
        termsLinkSource: trustObserved.termsLinkSource || linksObserved.termsLinkSource || null,
        contactConfidence: trustObserved.contactConfidence || null
      };
      if (geoSignalsV1 && geoSignalsV1.subpageSignals) {
        lightweightSummary.subpageSignals = buildLightweightSubpageSignalsSummary_(geoSignalsV1.subpageSignals);
      }
      const diagnostics = {
        evaluateCount: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.evaluateCount === 'number'
          ? geoSignalsV1.diagnostics.evaluateCount
          : null,
        htmlSkipped: true,
        scoringSkipped: true,
        auditSigSkipped: true,
        jsScanSkipped: true,
        chunkScanSkipped: true,
        balancedMode: signalsFirstBalanced,
        boundedHydrationWaitMs,
        hydrationWaitMs: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.hydrationWaitMs === 'number' ? geoSignalsV1.diagnostics.hydrationWaitMs : null,
        bodyTextBeforeWait: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.bodyTextBeforeWait === 'number' ? geoSignalsV1.diagnostics.bodyTextBeforeWait : null,
        bodyTextAfterWait: geoSignalsV1 && geoSignalsV1.diagnostics && typeof geoSignalsV1.diagnostics.bodyTextAfterWait === 'number' ? geoSignalsV1.diagnostics.bodyTextAfterWait : null,
        hydrationImprovedBodyText: !!(geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.hydrationImprovedBodyText),
        hydrationImprovedLinks: !!(geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.hydrationImprovedLinks),
        shadowHeadingScan: !!(signalsFirstBalanced && !balancedShortFastResponse),
        a11yHeadingScan: !balancedShortFastResponse,
        appRootHeadingScan: !!signalsFirstBalanced,
        heroHeadingScan: !!signalsFirstBalanced,
        iframeHeadingScan: !!(signalsFirstBalanced && !balancedShortFastResponse),
        primaryHeadingScan: !!signalsFirstBalanced,
        shadowPrimaryHeadingScan: !!(signalsFirstBalanced && !balancedShortFastResponse),
        mainCandidateScan: !!signalsFirstBalanced,
        htmlContentLdJsonScan: !!signalsFirstBalanced,
        responseMode: balancedShortFastResponse ? 'shortFast' : (balancedShortResponse ? 'short' : undefined),
        shortFastMode: !!balancedShortFastResponse,
        skippedScans: balancedShortFastResponse
          ? ['deep_shadow_heading_scan', 'a11y_heading_scan', 'a11y_main_scan', 'iframe_heading_scan', 'large_samples']
          : [],
        phaseTimings: geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.phaseTimings || null,
        sitemapDiscoveryMethod: sitemapDiscoveryLight.discoveryMethod,
        sitemapCheckedUrls: Array.isArray(sitemapDiscoveryLight.checkedUrls) ? sitemapDiscoveryLight.checkedUrls.slice(0, 10) : [],
        sitemapResolvedUrl: sitemapDiscoveryLight.url,
        sitemapHttpStatus: sitemapDiscoveryLight.httpStatus,
        timeoutGuardMs: balancedShortFastResponse ? 60000 : null
      };
      const memoryHints = {
        avoidedHeavyBlocks: [
          'html',
          'scoring.html',
          'auditSig',
          'resource_js_tap',
          'chunk_tap',
          ...(signalsFirstBalanced ? [] : ['multimodalSignals']),
          'productSpecComparisonSignals',
          'responsePayloadHugeMerge'
        ],
        estimatedSavedBytes: null
      };
      try {
        const htmlEstimate = await page.evaluate(() => {
          try { return String((document.documentElement && document.documentElement.outerHTML) || '').length; } catch (_) { return 0; }
        }).catch(() => 0);
        memoryHints.estimatedSavedBytes = Math.max(0, Number(htmlEstimate || 0) * 2);
      } catch (_) {}
      mergeTopPageStaticSignalsIntoPayload_(geoSignalsV1, lightweightSummary, topPageStaticFetchResult);
      attachMediaArticleLinkFreshnessSignals_(geoSignalsV1, lightweightSummary, { siteMode, url: finalUrl || urlToFetch });
      if (geoSignalsV1 && geoSignalsV1.diagnostics) {
        geoSignalsV1.diagnostics.playwrightTimedOut = false;
        geoSignalsV1.diagnostics.playwrightFailed = false;
      }
      if (diagnostics) {
        diagnostics.topPageStaticFetch = geoSignalsV1 && geoSignalsV1.diagnostics && geoSignalsV1.diagnostics.topPageStaticFetch || {
          used: !!topPageStaticFetchResult,
          success: !!(topPageStaticFetchResult && topPageStaticFetchResult.success),
          elapsedMs: Number(topPageStaticFetchResult && topPageStaticFetchResult.elapsedMs || 0),
          usedAsFallback: false,
          error: topPageStaticFetchResult && topPageStaticFetchResult.error || ''
        };
        diagnostics.playwrightTimedOut = false;
        diagnostics.playwrightFailed = false;
      }
      logSf(signalsFirstBalanced ? 'SIGNALS_FIRST_BALANCED_SEND' : 'SIGNALS_FIRST_LIGHT_SEND', {
        h1Count: lightweightSummary.h1Count,
        hasMainLandmark: lightweightSummary.hasMainLandmarkFinal,
        h1Source: lightweightSummary.h1Source,
        headingObservationLimited: lightweightSummary.headingObservationLimited,
        primaryHeadingCandidate: lightweightSummary.primaryHeadingCandidate,
        primaryHeadingCandidateSource: lightweightSummary.primaryHeadingCandidateSource,
        h1EquivalentCandidateFound: lightweightSummary.h1EquivalentCandidateFound,
        sectionHeadingCandidate: lightweightSummary.sectionHeadingCandidate,
        sectionHeadingCandidateSource: lightweightSummary.sectionHeadingCandidateSource,
        mainLandmarkCandidateFound: lightweightSummary.mainLandmarkCandidateFound,
        jsonldCount: lightweightSummary.jsonldCount,
        navLinkCount: lightweightSummary.navLinkCount,
        bodyTextLength: lightweightSummary.bodyTextLength
      });
      logSfMemory(signalsFirstBalanced ? 'signals_first_balanced_send' : 'signals_first_light_send');
      const signalsResponsePayload = {
        ok: true,
        mode: signalsFirstBalanced ? 'signalsFirstBalanced' : 'signalsFirstLight',
        url: urlToFetch,
        finalUrl,
        status: resp && typeof resp.status === 'function' ? resp.status() : null,
        hasSitemapXml: sitemapDiscoveryLight.exists,
        sitemapXmlUrl: sitemapDiscoveryLight.url,
        sitemapDiscoveryMethod: sitemapDiscoveryLight.discoveryMethod,
        sitemapHttpStatus: sitemapDiscoveryLight.httpStatus,
        sitemapCheckedUrls: Array.isArray(sitemapDiscoveryLight.checkedUrls) ? sitemapDiscoveryLight.checkedUrls.slice(0, 10) : [],
        externalProfileLinksSample: Array.isArray(lightweightSummary.externalProfileLinksSample) ? lightweightSummary.externalProfileLinksSample.slice(0, 10) : [],
        socialLinksSample: Array.isArray(lightweightSummary.socialLinksSample) ? lightweightSummary.socialLinksSample.slice(0, 10) : [],
        footerExternalLinksSample: Array.isArray(lightweightSummary.footerExternalLinksSample) ? lightweightSummary.footerExternalLinksSample.slice(0, 10) : [],
        externalLinksSample: Array.isArray(lightweightSummary.externalLinksSample) ? lightweightSummary.externalLinksSample.slice(0, 10) : [],
        geoSignalsV1,
        lightweightSummary,
        diagnostics,
        memoryHints
      };
      const logScrapeResponseReadyAudit = payload => {
        try {
          const coverageSignals = payload && payload.geoSignalsV1 && payload.geoSignalsV1.coverageSignals;
          const stringifyProbe = value => {
            try {
              const json = JSON.stringify(value);
              return {
                ok: true,
                bytes: Buffer.byteLength(json || '', 'utf8'),
                error: null
              };
            } catch (e) {
              return {
                ok: false,
                bytes: null,
                error: String(e && (e.message || e) || 'stringify_failed').slice(0, 240)
              };
            }
          };
          const payloadProbe = stringifyProbe(payload);
          const geoSignalsProbe = stringifyProbe(payload && payload.geoSignalsV1);
          const coverageSignalsProbe = stringifyProbe(coverageSignals);
          console.log('[DEBUG][SCRAPE_RESPONSE_READY_AUDIT]', JSON.stringify({
            route: '/scrape',
            mode: payload && (payload.responseMode || payload.mode) || (signalsMode || responseMode || null),
            url: payload && payload.url || urlToFetch,
            finalUrl: payload && payload.finalUrl || finalUrl,
            hasGeoSignalsV1: Boolean(payload && payload.geoSignalsV1),
            hasCoverageSignals: Boolean(coverageSignals),
            coverageAttached: Boolean(coverageSignals && coverageSignals.checked),
            observedSubpageCount: coverageSignals ? coverageSignals.observedSubpageCount : null,
            payloadStringifyOk: payloadProbe.ok,
            payloadBytes: payloadProbe.bytes,
            payloadStringifyError: payloadProbe.error,
            geoSignalsBytes: geoSignalsProbe.bytes,
            geoSignalsStringifyOk: geoSignalsProbe.ok,
            geoSignalsStringifyError: geoSignalsProbe.error,
            coverageSignalsBytes: coverageSignalsProbe.bytes,
            coverageSignalsStringifyOk: coverageSignalsProbe.ok,
            coverageSignalsStringifyError: coverageSignalsProbe.error,
            responseKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : []
          }));
          logHeavySiteInvestigationAudit('response_ready', {
            mode: payload && (payload.responseMode || payload.mode) || (signalsMode || responseMode || null),
            hasGeoSignalsV1: Boolean(payload && payload.geoSignalsV1),
            hasCoverageSignals: Boolean(coverageSignals),
            observedSubpageCount: coverageSignals ? coverageSignals.observedSubpageCount : null,
            payloadStringifyOk: payloadProbe.ok,
            payloadBytes: payloadProbe.bytes,
            payloadStringifyError: payloadProbe.error,
            geoSignalsBytes: geoSignalsProbe.bytes,
            geoSignalsStringifyOk: geoSignalsProbe.ok,
            geoSignalsStringifyError: geoSignalsProbe.error,
            coverageSignalsBytes: coverageSignalsProbe.bytes,
            coverageSignalsStringifyOk: coverageSignalsProbe.ok,
            coverageSignalsStringifyError: coverageSignalsProbe.error
          });
        } catch (_) {}
      };
      const logScrapeResponseSentAudit = payload => {
        try {
          const coverageSignals = payload && payload.geoSignalsV1 && payload.geoSignalsV1.coverageSignals;
          let payloadBytes = null;
          try {
            payloadBytes = Buffer.byteLength(JSON.stringify(payload) || '', 'utf8');
          } catch (_) {}
          console.log('[DEBUG][SCRAPE_RESPONSE_SENT_AUDIT]', JSON.stringify({
            route: '/scrape',
            mode: payload && (payload.responseMode || payload.mode) || (signalsMode || responseMode || null),
            url: payload && payload.url || urlToFetch,
            finalUrl: payload && payload.finalUrl || finalUrl,
            hasGeoSignalsV1: Boolean(payload && payload.geoSignalsV1),
            hasCoverageSignals: Boolean(coverageSignals),
            observedSubpageCount: coverageSignals ? coverageSignals.observedSubpageCount : null,
            payloadBytes
          }));
          logHeavySiteInvestigationAudit('response_sent', {
            used: 'res.json',
            mode: payload && (payload.responseMode || payload.mode) || (signalsMode || responseMode || null),
            hasGeoSignalsV1: Boolean(payload && payload.geoSignalsV1),
            hasCoverageSignals: Boolean(coverageSignals),
            observedSubpageCount: coverageSignals ? coverageSignals.observedSubpageCount : null,
            payloadBytes
          });
        } catch (_) {}
      };
      if (balancedShortResponse) {
        const shortPayload = buildBalancedShortResponsePayload(signalsResponsePayload);
        if (balancedShortFastResponse) {
          shortPayload.responseMode = 'shortFast';
          shortPayload.shortFastMode = true;
          if (shortPayload.diagnostics) {
            shortPayload.diagnostics.responseMode = 'shortFast';
            shortPayload.diagnostics.shortFastMode = true;
            shortPayload.diagnostics.timeoutGuardMs = 60000;
            shortPayload.diagnostics.skippedScans = Array.from(new Set([]
              .concat(shortPayload.diagnostics.skippedScans || [])
              .concat(['deep_shadow_heading_scan', 'a11y_heading_scan', 'a11y_main_scan', 'iframe_heading_scan', 'large_samples'])
            ));
          }
          if (shortPayload.memoryHints) {
            shortPayload.memoryHints.shortFastMode = true;
            shortPayload.memoryHints.skippedScans = shortPayload.diagnostics && shortPayload.diagnostics.skippedScans || [];
          }
        }
        logSf('SIGNALS_FIRST_BALANCED_SHORT_SEND', {
          responseMode: balancedShortFastResponse ? 'shortFast' : 'short',
          trimmedFieldsCount: shortPayload && shortPayload.diagnostics && Array.isArray(shortPayload.diagnostics.trimmedFields)
            ? shortPayload.diagnostics.trimmedFields.length
            : 0,
          estimatedOriginalBytes: shortPayload && shortPayload.diagnostics && shortPayload.diagnostics.estimatedOriginalBytes,
          responseBytesApprox: shortPayload && shortPayload.diagnostics && shortPayload.diagnostics.responseBytesApprox,
          navLinkCount: shortPayload && shortPayload.lightweightSummary && shortPayload.lightweightSummary.navLinkCount,
          jsonldCount: shortPayload && shortPayload.lightweightSummary && shortPayload.lightweightSummary.jsonldCount
        });
        logScrapeResponseReadyAudit(shortPayload);
        res.status(200).json(shortPayload);
        logScrapeResponseSentAudit(shortPayload);
        return;
      }
      logScrapeResponseReadyAudit(signalsResponsePayload);
      res.status(200).json(signalsResponsePayload);
      logScrapeResponseSentAudit(signalsResponsePayload);
      return;
    }
    if (signalsOnly) {
      const finalUrl = page && typeof page.url === 'function' ? page.url() : urlToFetch;
      logSf('SIGNALS_ONLY_EARLY_ENTER', {
        url: String(urlToFetch || '').slice(0, 180),
        finalUrl: String(finalUrl || '').slice(0, 180),
        probe: probeMode || null
      });
      logSfMemory('signals_only_early_enter');
      logSf('SIGNALS_ONLY_EARLY_BEFORE_GEO_SIGNALS');
      logSfMemory('signals_only_early_before_geo_signals');
      const geoSignalsV1 = await buildGeoSignalsV1(page, finalUrl || urlToFetch);
      logSf('SIGNALS_ONLY_EARLY_AFTER_GEO_SIGNALS', {
        hasGeoSignals: !!geoSignalsV1,
        error: geoSignalsV1 && geoSignalsV1.error ? true : false
      });
      logSfMemory('signals_only_early_after_geo_signals');
      if (probeMode) {
        const debug = {
          skippedHeavyPayload: true,
          reason: 'signalsOnly=1',
          htmlLength: null,
          renderedTextLength: null,
          bodyTextLength: null,
          auditSigSummary: null,
          dataSummary: null,
          evaluateCount: geoSignalsV1 && geoSignalsV1.diagnostics
            ? geoSignalsV1.diagnostics.evaluateCount
            : null
        };
        logSf('PROBE_ENTER', { probe: probeMode });
        logSfMemory('probe_enter');
        if (probeMode === 'content') {
          logSf('PROBE_BEFORE_CONTENT');
          logSfMemory('probe_before_content');
          const probeHtml = await page.content().catch(() => '');
          debug.htmlLength = String(probeHtml || '').length;
          logSf('PROBE_AFTER_CONTENT', { htmlLength: debug.htmlLength });
          logSfMemory('probe_after_content');
        } else if (probeMode === 'text') {
          logSf('PROBE_BEFORE_TEXT');
          logSfMemory('probe_before_text');
          const probeText = await page.evaluate(() => {
            try {
              const body = document.body;
              return String((body && (body.innerText || body.textContent)) || '');
            } catch (_) {
              return '';
            }
          }).catch(() => '');
          debug.renderedTextLength = String(probeText || '').length;
          debug.bodyTextLength = debug.renderedTextLength;
          logSf('PROBE_AFTER_TEXT', { renderedTextLength: debug.renderedTextLength });
          logSfMemory('probe_after_text');
        } else if (probeMode === 'audit') {
          logSf('PROBE_BEFORE_AUDIT');
          logSfMemory('probe_before_audit');
          const probeAuditSig = await buildAuditSigFromPage(page).catch(() => null);
          debug.auditSigSummary = {
            exists: !!probeAuditSig,
            keysCount: probeAuditSig && typeof probeAuditSig === 'object' ? Object.keys(probeAuditSig).length : 0,
            jsonldCount: probeAuditSig && typeof probeAuditSig.jsonldCount === 'number' ? probeAuditSig.jsonldCount : null,
            jsonldTypesCount: probeAuditSig && Array.isArray(probeAuditSig.jsonldTypes) ? probeAuditSig.jsonldTypes.length : null,
            h1Count: probeAuditSig && typeof probeAuditSig.h1Count === 'number' ? probeAuditSig.h1Count : null
          };
          logSf('PROBE_AFTER_AUDIT', debug.auditSigSummary);
          logSfMemory('probe_after_audit');
        } else if (probeMode === 'data') {
          logSf('PROBE_BEFORE_DATA');
          logSfMemory('probe_before_data');
          const probeBodySample = geoSignalsV1 && geoSignalsV1.observed && geoSignalsV1.observed.body
            ? String(geoSignalsV1.observed.body.sample || '')
            : '';
          const probeData = buildScoresFromScrape({
            url: finalUrl || urlToFetch,
            html: '',
            bodyText: probeBodySample,
            jsonld: [],
            structured: {},
            jsonldSynth: []
          });
          debug.dataSummary = {
            exists: !!probeData,
            keysCount: probeData && typeof probeData === 'object' ? Object.keys(probeData).length : 0,
            hasBefore: !!(probeData && probeData.before),
            hasAfter: !!(probeData && probeData.after)
          };
          logSf('PROBE_AFTER_DATA', debug.dataSummary);
          logSfMemory('probe_after_data');
        } else if (probeMode === 'resourcejson') {
          logSf('PROBE_BEFORE_RESOURCE_JSON');
          logSfMemory('probe_before_resource_json');
          const resourceJsonSummary = {
            stage: 'start',
            candidateCount: 0,
            attemptedCount: 0,
            okCount: 0,
            errorCount: 0,
            totalBytes: 0,
            sampleUrls: [],
            sampleKeys: [],
            maxBodyLength: 0
          };
          try {
            resourceJsonSummary.stage = 'collect_resource_entries';
            const probeResourceUrls = await page.evaluate(() => {
              try {
                return performance.getEntriesByType('resource')
                  .map(e => e && e.name)
                  .filter(Boolean);
              } catch (_) {
                return [];
              }
            }).catch(() => []);
            const probeJsonUrls = uniq((Array.isArray(probeResourceUrls) ? probeResourceUrls : []).filter(u =>
              /(\.json(\?|$))|googleapis|sheets|gviz|cms|data/i.test(String(u || ''))
            )).slice(0, 40);
            resourceJsonSummary.candidateCount = probeJsonUrls.length;
            resourceJsonSummary.sampleUrls = probeJsonUrls.slice(0, 10);
            resourceJsonSummary.stage = 'fetch_json_candidates';
            for (const u of probeJsonUrls) {
              resourceJsonSummary.attemptedCount += 1;
              try {
                const r = await page.request.get(u, { timeout: 10000 });
                if (!r.ok()) continue;
                const body = await r.text();
                const len = String(body || '').length;
                resourceJsonSummary.okCount += 1;
                resourceJsonSummary.totalBytes += len;
                resourceJsonSummary.maxBodyLength = Math.max(resourceJsonSummary.maxBodyLength, len);
                if (resourceJsonSummary.sampleKeys.length < 20) {
                  try {
                    const parsed = JSON.parse(body);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                      Object.keys(parsed).slice(0, 8).forEach(k => resourceJsonSummary.sampleKeys.push(k));
                    } else if (Array.isArray(parsed)) {
                      resourceJsonSummary.sampleKeys.push('[array]');
                    }
                  } catch (_) {}
                }
              } catch (_) {
                resourceJsonSummary.errorCount += 1;
              }
            }
            resourceJsonSummary.stage = 'done';
          } catch (e) {
            resourceJsonSummary.stage = 'error';
            resourceJsonSummary.errorMessage = String(e && e.message || e).slice(0, 180);
          }
          resourceJsonSummary.sampleKeys = Array.from(new Set(resourceJsonSummary.sampleKeys)).slice(0, 20);
          debug.resourceJsonSummary = resourceJsonSummary;
          logSf('PROBE_AFTER_RESOURCE_JSON', {
            stage: resourceJsonSummary.stage,
            candidateCount: resourceJsonSummary.candidateCount,
            attemptedCount: resourceJsonSummary.attemptedCount,
            okCount: resourceJsonSummary.okCount,
            totalBytes: resourceJsonSummary.totalBytes,
            maxBodyLength: resourceJsonSummary.maxBodyLength
          });
          logSfMemory('probe_after_resource_json');
        } else if (probeMode === 'jstap') {
          logSf('PROBE_BEFORE_JS_TAP');
          logSfMemory('probe_before_js_tap');
          const jsTapSummary = {
            stage: 'start',
            scriptCount: 0,
            moduleScriptCount: 0,
            preloadScriptCount: 0,
            chunkLikeCount: 0,
            nextStaticCount: 0,
            sampleScriptUrls: [],
            sampleChunkUrls: [],
            totalUrlChars: 0,
            maxUrlLength: 0
          };
          try {
            jsTapSummary.stage = 'collect_script_urls';
            const probeJs = await page.evaluate(() => {
              try {
                const clean = (v) => String(v || '').trim();
                return {
                  scriptSrcs: Array.from(document.querySelectorAll('script[src]')).map(el => ({
                    src: clean(el.getAttribute('src')),
                    type: clean(el.getAttribute('type')),
                    async: !!el.async,
                    defer: !!el.defer
                  })).filter(x => x.src),
                  modulePreloads: Array.from(document.querySelectorAll('link[rel="modulepreload"][href],link[rel="preload"][as="script"][href]')).map(el => ({
                    href: clean(el.getAttribute('href')),
                    rel: clean(el.getAttribute('rel')),
                    as: clean(el.getAttribute('as'))
                  })).filter(x => x.href),
                  performanceScripts: performance.getEntriesByType('resource')
                    .map(e => clean(e && e.name))
                    .filter(u => u && /(\.m?js(\?|$))|\/_next\/static\/|webpack|chunk|app-index/i.test(u))
                };
              } catch (_) {
                return { scriptSrcs: [], modulePreloads: [], performanceScripts: [] };
              }
            }).catch(() => ({ scriptSrcs: [], modulePreloads: [], performanceScripts: [] }));
            const absProbeUrl = (u) => {
              try { return new URL(u, finalUrl || urlToFetch).toString(); } catch (_) { return String(u || ''); }
            };
            const scriptUrls = uniq((Array.isArray(probeJs.scriptSrcs) ? probeJs.scriptSrcs : []).map(x => absProbeUrl(x && x.src)).filter(Boolean));
            const preloadUrls = uniq((Array.isArray(probeJs.modulePreloads) ? probeJs.modulePreloads : []).map(x => absProbeUrl(x && x.href)).filter(Boolean));
            const perfUrls = uniq((Array.isArray(probeJs.performanceScripts) ? probeJs.performanceScripts : []).map(absProbeUrl).filter(Boolean));
            const allUrls = uniq([].concat(scriptUrls, preloadUrls, perfUrls));
            const chunkUrls = allUrls.filter(u => /chunk|webpack|\/_next\/static\/|app-index|\.m?js(\?|$)/i.test(String(u || '')));
            jsTapSummary.scriptCount = scriptUrls.length;
            jsTapSummary.moduleScriptCount = (Array.isArray(probeJs.scriptSrcs) ? probeJs.scriptSrcs : [])
              .filter(x => /module/i.test(String(x && x.type || ''))).length;
            jsTapSummary.preloadScriptCount = preloadUrls.length;
            jsTapSummary.chunkLikeCount = chunkUrls.length;
            jsTapSummary.nextStaticCount = allUrls.filter(u => /\/_next\/static\//i.test(String(u || ''))).length;
            jsTapSummary.sampleScriptUrls = allUrls.slice(0, 20);
            jsTapSummary.sampleChunkUrls = chunkUrls.slice(0, 20);
            jsTapSummary.totalUrlChars = allUrls.reduce((sum, u) => sum + String(u || '').length, 0);
            jsTapSummary.maxUrlLength = allUrls.reduce((max, u) => Math.max(max, String(u || '').length), 0);
            jsTapSummary.stage = 'done';
          } catch (e) {
            jsTapSummary.stage = 'error';
            jsTapSummary.errorMessage = String(e && e.message || e).slice(0, 180);
          }
          debug.jsTapSummary = jsTapSummary;
          logSf('PROBE_AFTER_JS_TAP', {
            stage: jsTapSummary.stage,
            scriptCount: jsTapSummary.scriptCount,
            preloadScriptCount: jsTapSummary.preloadScriptCount,
            chunkLikeCount: jsTapSummary.chunkLikeCount,
            totalUrlChars: jsTapSummary.totalUrlChars
          });
          logSfMemory('probe_after_js_tap');
        } else if (probeMode === 'jsfetch') {
          logSf('PROBE_BEFORE_JS_FETCH', { maxFetch: probeMaxFetch });
          logSfMemory('probe_before_js_fetch');
          const jsFetchSummary = {
            stage: 'start',
            scriptCount: 0,
            attemptedCount: 0,
            okCount: 0,
            errorCount: 0,
            totalBytes: 0,
            maxBodyLength: 0,
            totalElapsedMs: 0,
            maxFetch: probeMaxFetch,
            sampleResults: []
          };
          try {
            jsFetchSummary.stage = 'collect_js_urls';
            const probeJs = await page.evaluate(() => {
              try {
                const clean = (v) => String(v || '').trim();
                return {
                  scriptSrcs: Array.from(document.querySelectorAll('script[src]')).map(el => clean(el.getAttribute('src'))).filter(Boolean),
                  modulePreloads: Array.from(document.querySelectorAll('link[rel="modulepreload"][href],link[rel="preload"][as="script"][href]')).map(el => clean(el.getAttribute('href'))).filter(Boolean),
                  performanceScripts: performance.getEntriesByType('resource')
                    .map(e => clean(e && e.name))
                    .filter(u => u && /(\.m?js(\?|$))|\/_next\/static\/|webpack|chunk|app-index/i.test(u))
                };
              } catch (_) {
                return { scriptSrcs: [], modulePreloads: [], performanceScripts: [] };
              }
            }).catch(() => ({ scriptSrcs: [], modulePreloads: [], performanceScripts: [] }));
            const absProbeUrl = (u) => {
              try { return new URL(u, finalUrl || urlToFetch).toString(); } catch (_) { return String(u || ''); }
            };
            const jsUrls = uniq([]
              .concat(Array.isArray(probeJs.scriptSrcs) ? probeJs.scriptSrcs : [])
              .concat(Array.isArray(probeJs.modulePreloads) ? probeJs.modulePreloads : [])
              .concat(Array.isArray(probeJs.performanceScripts) ? probeJs.performanceScripts : [])
              .map(absProbeUrl)
              .filter(Boolean)
            );
            jsFetchSummary.scriptCount = jsUrls.length;
            jsFetchSummary.stage = 'fetch_js_start';
            for (const u of jsUrls.slice(0, probeMaxFetch)) {
              const eachStart = Date.now();
              const row = {
                url: String(u || '').slice(0, 180),
                status: null,
                contentType: '',
                bodyLength: 0,
                elapsedMs: 0,
                ok: false
              };
              jsFetchSummary.attemptedCount += 1;
              jsFetchSummary.stage = 'fetch_js_each';
              try {
                const r = await page.request.get(u, { timeout: 10000 });
                row.status = typeof r.status === 'function' ? r.status() : null;
                row.contentType = String((r.headers && r.headers()['content-type']) || '').slice(0, 120);
                row.ok = !!(r && typeof r.ok === 'function' && r.ok());
                const body = await r.text();
                row.bodyLength = String(body || '').length;
                if (row.ok) jsFetchSummary.okCount += 1;
                jsFetchSummary.totalBytes += row.bodyLength;
                jsFetchSummary.maxBodyLength = Math.max(jsFetchSummary.maxBodyLength, row.bodyLength);
              } catch (e) {
                jsFetchSummary.errorCount += 1;
                row.errorMessage = String(e && e.message || e).slice(0, 160);
              } finally {
                row.elapsedMs = Math.max(0, Date.now() - eachStart);
                jsFetchSummary.totalElapsedMs += row.elapsedMs;
                if (jsFetchSummary.sampleResults.length < 10) jsFetchSummary.sampleResults.push(row);
              }
            }
            jsFetchSummary.stage = 'done';
          } catch (e) {
            jsFetchSummary.stage = 'error';
            jsFetchSummary.errorMessage = String(e && e.message || e).slice(0, 180);
          }
          debug.jsFetchSummary = jsFetchSummary;
          logSf('PROBE_AFTER_JS_FETCH', {
            stage: jsFetchSummary.stage,
            scriptCount: jsFetchSummary.scriptCount,
            attemptedCount: jsFetchSummary.attemptedCount,
            okCount: jsFetchSummary.okCount,
            errorCount: jsFetchSummary.errorCount,
            totalBytes: jsFetchSummary.totalBytes,
            totalElapsedMs: jsFetchSummary.totalElapsedMs,
            maxBodyLength: jsFetchSummary.maxBodyLength
          });
          logSfMemory('probe_after_js_fetch');
        } else if (probeMode === 'jsscan') {
          logSf('PROBE_BEFORE_JS_SCAN', { maxFetch: probeMaxFetch });
          logSfMemory('probe_before_js_scan');
          const jsScanSummary = {
            stage: 'start',
            scriptCount: 0,
            attemptedCount: 0,
            okCount: 0,
            errorCount: 0,
            totalRawBytes: 0,
            totalDecodedBytes: 0,
            totalScanBytes: 0,
            maxRawLength: 0,
            maxDecodedLength: 0,
            maxScanLength: 0,
            totalElapsedMs: 0,
            maxFetch: probeMaxFetch,
            sampleResults: []
          };
          try {
            jsScanSummary.stage = 'collect_js_urls';
            const probeJs = await page.evaluate(() => {
              try {
                const clean = (v) => String(v || '').trim();
                return {
                  scriptSrcs: Array.from(document.querySelectorAll('script[src]')).map(el => clean(el.getAttribute('src'))).filter(Boolean),
                  modulePreloads: Array.from(document.querySelectorAll('link[rel="modulepreload"][href],link[rel="preload"][as="script"][href]')).map(el => clean(el.getAttribute('href'))).filter(Boolean),
                  performanceScripts: performance.getEntriesByType('resource')
                    .map(e => clean(e && e.name))
                    .filter(u => u && /(\.m?js(\?|$))|\/_next\/static\/|webpack|chunk|app-index/i.test(u))
                };
              } catch (_) {
                return { scriptSrcs: [], modulePreloads: [], performanceScripts: [] };
              }
            }).catch(() => ({ scriptSrcs: [], modulePreloads: [], performanceScripts: [] }));
            const absProbeUrl = (u) => {
              try { return new URL(u, finalUrl || urlToFetch).toString(); } catch (_) { return String(u || ''); }
            };
            const jsUrls = uniq([]
              .concat(Array.isArray(probeJs.scriptSrcs) ? probeJs.scriptSrcs : [])
              .concat(Array.isArray(probeJs.modulePreloads) ? probeJs.modulePreloads : [])
              .concat(Array.isArray(probeJs.performanceScripts) ? probeJs.performanceScripts : [])
              .map(absProbeUrl)
              .filter(Boolean)
            );
            const phoneRe = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
            const zipRe = /〒?\d{3}-?\d{4}/g;
            const socialHostRe = /https?:\/\/[^\s"'<>]+/g;
            jsScanSummary.scriptCount = jsUrls.length;
            jsScanSummary.stage = 'fetch_js_start';
            for (const u of jsUrls.slice(0, probeMaxFetch)) {
              const eachStart = Date.now();
              const row = {
                url: String(u || '').slice(0, 180),
                status: null,
                rawLength: 0,
                decodedLength: 0,
                scanLength: 0,
                elapsedMs: 0,
                ok: false
              };
              jsScanSummary.attemptedCount += 1;
              jsScanSummary.stage = 'fetch_js_each';
              try {
                const r = await page.request.get(u, { timeout: 10000 });
                row.status = typeof r.status === 'function' ? r.status() : null;
                row.ok = !!(r && typeof r.ok === 'function' && r.ok());
                const raw = await r.text();
                row.rawLength = String(raw || '').length;
                jsScanSummary.stage = 'decode_each';
                const decoded = decodeUnicodeEscapes(raw);
                row.decodedLength = String(decoded || '').length;
                jsScanSummary.stage = 'scan_each';
                const scan = String(raw || '') + '\n' + String(decoded || '');
                row.scanLength = scan.length;
                row.matchCounts = {
                  phone: (scan.match(phoneRe) || []).length,
                  zip: (scan.match(zipRe) || []).length,
                  url: (scan.match(socialHostRe) || []).length
                };
                if (row.ok) jsScanSummary.okCount += 1;
                jsScanSummary.totalRawBytes += row.rawLength;
                jsScanSummary.totalDecodedBytes += row.decodedLength;
                jsScanSummary.totalScanBytes += row.scanLength;
                jsScanSummary.maxRawLength = Math.max(jsScanSummary.maxRawLength, row.rawLength);
                jsScanSummary.maxDecodedLength = Math.max(jsScanSummary.maxDecodedLength, row.decodedLength);
                jsScanSummary.maxScanLength = Math.max(jsScanSummary.maxScanLength, row.scanLength);
              } catch (e) {
                jsScanSummary.errorCount += 1;
                row.errorMessage = String(e && e.message || e).slice(0, 160);
              } finally {
                row.elapsedMs = Math.max(0, Date.now() - eachStart);
                jsScanSummary.totalElapsedMs += row.elapsedMs;
                if (jsScanSummary.sampleResults.length < 10) jsScanSummary.sampleResults.push(row);
              }
            }
            jsScanSummary.stage = 'done';
          } catch (e) {
            jsScanSummary.stage = 'error';
            jsScanSummary.errorMessage = String(e && e.message || e).slice(0, 180);
          }
          debug.jsScanSummary = jsScanSummary;
          logSf('PROBE_AFTER_JS_SCAN', {
            stage: jsScanSummary.stage,
            scriptCount: jsScanSummary.scriptCount,
            attemptedCount: jsScanSummary.attemptedCount,
            okCount: jsScanSummary.okCount,
            errorCount: jsScanSummary.errorCount,
            totalRawBytes: jsScanSummary.totalRawBytes,
            totalDecodedBytes: jsScanSummary.totalDecodedBytes,
            totalScanBytes: jsScanSummary.totalScanBytes,
            maxScanLength: jsScanSummary.maxScanLength,
            totalElapsedMs: jsScanSummary.totalElapsedMs
          });
          logSfMemory('probe_after_js_scan');
        } else if (probeMode === 'jschunk') {
          logSf('PROBE_BEFORE_JS_CHUNK', { maxFetch: probeMaxFetch, maxChunkFetch: probeMaxChunkFetch });
          logSfMemory('probe_before_js_chunk');
          const jsChunkSummary = {
            stage: 'start',
            scriptCount: 0,
            attemptedScriptCount: 0,
            chunkCandidateCount: 0,
            attemptedChunkCount: 0,
            okChunkCount: 0,
            errorChunkCount: 0,
            totalScriptScanBytes: 0,
            totalChunkBytes: 0,
            maxChunkBodyLength: 0,
            totalElapsedMs: 0,
            maxFetch: probeMaxFetch,
            maxChunkFetch: probeMaxChunkFetch,
            sampleChunkUrls: [],
            sampleResults: []
          };
          try {
            jsChunkSummary.stage = 'collect_js_urls';
            const probeJs = await page.evaluate(() => {
              try {
                const clean = (v) => String(v || '').trim();
                return {
                  scriptSrcs: Array.from(document.querySelectorAll('script[src]')).map(el => clean(el.getAttribute('src'))).filter(Boolean),
                  modulePreloads: Array.from(document.querySelectorAll('link[rel="modulepreload"][href],link[rel="preload"][as="script"][href]')).map(el => clean(el.getAttribute('href'))).filter(Boolean),
                  performanceScripts: performance.getEntriesByType('resource')
                    .map(e => clean(e && e.name))
                    .filter(u => u && /(\.m?js(\?|$))|\/_next\/static\/|webpack|chunk|app-index/i.test(u))
                };
              } catch (_) {
                return { scriptSrcs: [], modulePreloads: [], performanceScripts: [] };
              }
            }).catch(() => ({ scriptSrcs: [], modulePreloads: [], performanceScripts: [] }));
            const absProbeUrl = (u) => {
              try { return new URL(u, finalUrl || urlToFetch).toString(); } catch (_) { return String(u || ''); }
            };
            const jsUrls = uniq([]
              .concat(Array.isArray(probeJs.scriptSrcs) ? probeJs.scriptSrcs : [])
              .concat(Array.isArray(probeJs.modulePreloads) ? probeJs.modulePreloads : [])
              .concat(Array.isArray(probeJs.performanceScripts) ? probeJs.performanceScripts : [])
              .map(absProbeUrl)
              .filter(Boolean)
            );
            const extraChunkUrls = new Set();
            const phoneRe = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
            const zipRe = /〒?\d{3}-?\d{4}/g;
            const urlRe = /https?:\/\/[^\s"'<>]+/g;
            jsChunkSummary.scriptCount = jsUrls.length;
            for (const u of jsUrls.slice(0, probeMaxFetch)) {
              jsChunkSummary.stage = 'fetch_js_each';
              const eachStart = Date.now();
              try {
                const r = await page.request.get(u, { timeout: 10000 });
                if (!r.ok()) continue;
                const raw = await r.text();
                const decoded = decodeUnicodeEscapes(raw);
                const scan = String(raw || '') + '\n' + String(decoded || '');
                jsChunkSummary.stage = 'scan_js_each';
                jsChunkSummary.attemptedScriptCount += 1;
                jsChunkSummary.totalScriptScanBytes += scan.length;
                const matches = scan.match(/["'`](\/chunk-[A-Za-z0-9-]+\.js)["'`]/g) || [];
                jsChunkSummary.stage = 'extract_chunk_urls';
                for (const rawMatch of matches) {
                  const rel = rawMatch.replace(/^["'`]|["'`]$/g, '');
                  try {
                    extraChunkUrls.add(new URL(rel, finalUrl || urlToFetch).toString());
                  } catch (_) {}
                }
              } catch (_) {
                jsChunkSummary.errorChunkCount += 0;
              } finally {
                jsChunkSummary.totalElapsedMs += Math.max(0, Date.now() - eachStart);
              }
            }
            const chunkUrls = Array.from(extraChunkUrls);
            jsChunkSummary.chunkCandidateCount = chunkUrls.length;
            jsChunkSummary.sampleChunkUrls = chunkUrls.slice(0, 20);
            for (const u of chunkUrls.slice(0, probeMaxChunkFetch)) {
              const eachStart = Date.now();
              const row = {
                url: String(u || '').slice(0, 180),
                status: null,
                contentType: '',
                bodyLength: 0,
                elapsedMs: 0,
                ok: false
              };
              jsChunkSummary.stage = 'fetch_chunk_each';
              jsChunkSummary.attemptedChunkCount += 1;
              try {
                const r = await page.request.get(u, { timeout: 15000 });
                row.status = typeof r.status === 'function' ? r.status() : null;
                row.contentType = String((r.headers && r.headers()['content-type']) || '').slice(0, 120);
                row.ok = !!(r && typeof r.ok === 'function' && r.ok());
                const body = await r.text();
                row.bodyLength = String(body || '').length;
                row.matchCounts = {
                  phone: ((body || '').match(phoneRe) || []).length,
                  zip: ((body || '').match(zipRe) || []).length,
                  url: ((body || '').match(urlRe) || []).length
                };
                if (row.ok) jsChunkSummary.okChunkCount += 1;
                jsChunkSummary.totalChunkBytes += row.bodyLength;
                jsChunkSummary.maxChunkBodyLength = Math.max(jsChunkSummary.maxChunkBodyLength, row.bodyLength);
              } catch (e) {
                jsChunkSummary.errorChunkCount += 1;
                row.errorMessage = String(e && e.message || e).slice(0, 160);
              } finally {
                row.elapsedMs = Math.max(0, Date.now() - eachStart);
                jsChunkSummary.totalElapsedMs += row.elapsedMs;
                if (jsChunkSummary.sampleResults.length < 10) jsChunkSummary.sampleResults.push(row);
              }
            }
            jsChunkSummary.stage = 'done';
          } catch (e) {
            jsChunkSummary.stage = 'error';
            jsChunkSummary.errorMessage = String(e && e.message || e).slice(0, 180);
          }
          debug.jsChunkSummary = jsChunkSummary;
          logSf('PROBE_AFTER_JS_CHUNK', {
            stage: jsChunkSummary.stage,
            scriptCount: jsChunkSummary.scriptCount,
            attemptedScriptCount: jsChunkSummary.attemptedScriptCount,
            chunkCandidateCount: jsChunkSummary.chunkCandidateCount,
            attemptedChunkCount: jsChunkSummary.attemptedChunkCount,
            okChunkCount: jsChunkSummary.okChunkCount,
            errorChunkCount: jsChunkSummary.errorChunkCount,
            totalScriptScanBytes: jsChunkSummary.totalScriptScanBytes,
            totalChunkBytes: jsChunkSummary.totalChunkBytes,
            maxChunkBodyLength: jsChunkSummary.maxChunkBodyLength,
            totalElapsedMs: jsChunkSummary.totalElapsedMs
          });
          logSfMemory('probe_after_js_chunk');
        } else if (probeMode === 'subpages') {
          logSf('PROBE_BEFORE_SUBPAGES', { maxSubpageFetch: probeMaxSubpageFetch });
          logSfMemory('probe_before_subpages');
          const subpagesSummary = {
            stage: 'start',
            internalLinkCount: 0,
            candidateCount: 0,
            attemptedCount: 0,
            okCount: 0,
            errorCount: 0,
            totalBytes: 0,
            maxBodyLength: 0,
            totalElapsedMs: 0,
            maxSubpageFetch: probeMaxSubpageFetch,
            sampleCandidates: [],
            sampleResults: []
          };
          try {
            subpagesSummary.stage = 'collect_internal_links';
            const targetOrigin = (() => {
              try { return new URL(finalUrl || urlToFetch).origin; } catch (_) { return ''; }
            })();
            const probeLinks = await page.evaluate((origin) => {
              try {
                const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
                return Array.from(document.querySelectorAll('a[href]')).map(a => {
                  let href = '';
                  try { href = new URL(a.getAttribute('href') || a.href || '', location.href).toString(); } catch (_) {}
                  let sameOrigin = false;
                  try { sameOrigin = !!href && new URL(href).origin === origin; } catch (_) {}
                  return {
                    text: norm(a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || ''),
                    href,
                    sameOrigin
                  };
                }).filter(x => x && x.href && x.sameOrigin);
              } catch (_) {
                return [];
              }
            }, targetOrigin).catch(() => []);
            const internalLinks = Array.isArray(probeLinks) ? probeLinks : [];
            subpagesSummary.internalLinkCount = internalLinks.length;
            subpagesSummary.stage = 'build_subpage_candidates';
            const candidateRe = /about|company|service|services|business|contact|inquiry|faq|privacy|policy|terms|support|plan|plans|product|products|会社|企業|サービス|事業|問い合わせ|お問い合わせ|よくある質問|プライバシー|個人情報|規約|サポート|料金|プラン|製品/i;
            const fixedCandidates = targetOrigin && typeof pickSubPageCandidatesVNext_ === 'function'
              ? pickSubPageCandidatesVNext_(targetOrigin)
              : [];
            const candidateSeen = new Set();
            const candidates = [];
            const addCandidate = (u) => {
              try {
                const parsed = new URL(String(u || ''), finalUrl || urlToFetch);
                if (!targetOrigin || parsed.origin !== targetOrigin) return;
                parsed.hash = '';
                const k = parsed.toString().replace(/\/+$/, '');
                if (!k || candidateSeen.has(k)) return;
                candidateSeen.add(k);
                candidates.push(k);
              } catch (_) {}
            };
            for (const link of internalLinks) {
              const hay = `${link && link.text || ''} ${link && link.href || ''}`;
              if (candidateRe.test(hay)) addCandidate(link && link.href);
            }
            for (const u of fixedCandidates) addCandidate(u);
            subpagesSummary.candidateCount = candidates.length;
            subpagesSummary.sampleCandidates = candidates.slice(0, 20);
            for (const u of candidates.slice(0, probeMaxSubpageFetch)) {
              const eachStart = Date.now();
              const row = {
                url: String(u || '').slice(0, 180),
                status: null,
                contentType: '',
                bodyLength: 0,
                elapsedMs: 0,
                ok: false
              };
              subpagesSummary.stage = 'fetch_subpage_each';
              subpagesSummary.attemptedCount += 1;
              try {
                const r = await page.request.get(u, { timeout: 15000 });
                row.status = typeof r.status === 'function' ? r.status() : null;
                row.contentType = String((r.headers && r.headers()['content-type']) || '').slice(0, 120);
                row.ok = !!(r && typeof r.ok === 'function' && r.ok());
                const body = await r.text();
                row.bodyLength = String(body || '').length;
                if (/text\/html|application\/xhtml/i.test(row.contentType)) {
                  const html = String(body || '');
                  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
                  if (titleMatch) {
                    row.title = String(titleMatch[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
                  }
                  row.h1Count = (html.match(/<h1\b/gi) || []).length;
                  row.h2Count = (html.match(/<h2\b/gi) || []).length;
                }
                if (row.ok) subpagesSummary.okCount += 1;
                subpagesSummary.totalBytes += row.bodyLength;
                subpagesSummary.maxBodyLength = Math.max(subpagesSummary.maxBodyLength, row.bodyLength);
              } catch (e) {
                subpagesSummary.errorCount += 1;
                row.errorMessage = String(e && e.message || e).slice(0, 160);
              } finally {
                row.elapsedMs = Math.max(0, Date.now() - eachStart);
                subpagesSummary.totalElapsedMs += row.elapsedMs;
                if (subpagesSummary.sampleResults.length < 10) subpagesSummary.sampleResults.push(row);
              }
            }
            subpagesSummary.stage = 'done';
          } catch (e) {
            subpagesSummary.stage = 'error';
            subpagesSummary.errorMessage = String(e && e.message || e).slice(0, 180);
          }
          debug.subpagesSummary = subpagesSummary;
          logSf('PROBE_AFTER_SUBPAGES', {
            stage: subpagesSummary.stage,
            internalLinkCount: subpagesSummary.internalLinkCount,
            candidateCount: subpagesSummary.candidateCount,
            attemptedCount: subpagesSummary.attemptedCount,
            okCount: subpagesSummary.okCount,
            errorCount: subpagesSummary.errorCount,
            totalBytes: subpagesSummary.totalBytes,
            maxBodyLength: subpagesSummary.maxBodyLength,
            totalElapsedMs: subpagesSummary.totalElapsedMs
          });
          logSfMemory('probe_after_subpages');
        } else if (probeMode === 'payloadassembly') {
          logSf('PROBE_BEFORE_PAYLOAD_ASSEMBLY');
          logSfMemory('probe_before_payload_assembly');
          const payloadAssemblyStartedAt = Date.now();
          const payloadAssemblySummary = {
            stage: 'start',
            mode: 'payloadAssemblyLight',
            url: urlToFetch,
            finalUrl,
            status: resp && typeof resp.status === 'function' ? resp.status() : null,
            htmlLengthEstimate: 0,
            renderedTextLengthEstimate: 0,
            bodyTextLengthEstimate: 0,
            geoSignalsBytesEstimate: 0,
            candidateHeavyBlocks: [],
            skippedHeavyBuilds: [
              'auditSig',
              'scoring',
              'responsePayload',
              'fullPayloadStringify'
            ],
            recommendation: [
              'doNotHoldHtmlInResponsePayload',
              'doNotPassHtmlIntoScoringWhenSignalsOnly',
              'buildFromGeoSignalsV1'
            ],
            elapsedMs: 0
          };
          try {
            payloadAssemblySummary.stage = 'estimate_sizes';
            logSf('PROBE_PAYLOAD_ASSEMBLY_BEFORE_ESTIMATE');
            logSfMemory('probe_payload_assembly_before_html');
            const lengthEstimates = await page.evaluate(() => {
              try {
                const htmlLength = String((document.documentElement && document.documentElement.outerHTML) || '').length;
                const body = document.body;
                const renderedTextLength = String((body && (body.innerText || body.textContent)) || '').length;
                return {
                  htmlLength,
                  renderedTextLength,
                  bodyTextLength: renderedTextLength
                };
              } catch (_) {
                return { htmlLength: 0, renderedTextLength: 0, bodyTextLength: 0 };
              }
            }).catch(() => ({ htmlLength: 0, renderedTextLength: 0, bodyTextLength: 0 }));
            payloadAssemblySummary.htmlLengthEstimate = Number(lengthEstimates.htmlLength || 0);
            payloadAssemblySummary.renderedTextLengthEstimate = Number(lengthEstimates.renderedTextLength || 0);
            payloadAssemblySummary.bodyTextLengthEstimate = Number(lengthEstimates.bodyTextLength || 0);
            try {
              payloadAssemblySummary.geoSignalsBytesEstimate = Buffer.byteLength(JSON.stringify(geoSignalsV1 || {}), 'utf8');
            } catch (_) {
              payloadAssemblySummary.geoSignalsBytesEstimate = 0;
            }
            const responsePayloadShellEstimate = 512 + payloadAssemblySummary.geoSignalsBytesEstimate;
            payloadAssemblySummary.candidateHeavyBlocks = [
              {
                key: 'html',
                estimatedBytes: payloadAssemblySummary.htmlLengthEstimate,
                present: payloadAssemblySummary.htmlLengthEstimate > 0,
                buildSkipped: true
              },
              {
                key: 'scoring.html',
                estimatedBytes: payloadAssemblySummary.htmlLengthEstimate,
                present: payloadAssemblySummary.htmlLengthEstimate > 0,
                buildSkipped: true
              },
              {
                key: 'auditSig',
                estimatedBytes: null,
                present: null,
                buildSkipped: true,
                reason: 'full_build_skipped_to_avoid_oom'
              },
              {
                key: 'responsePayloadShell',
                estimatedBytes: responsePayloadShellEstimate,
                present: true,
                buildSkipped: true
              },
              {
                key: 'data/scoring',
                estimatedBytes: null,
                present: null,
                buildSkipped: true,
                reason: 'buildScoresFromScrape_skipped_to_avoid_oom'
              }
            ];
            payloadAssemblySummary.stage = 'done';
          } catch (e) {
            payloadAssemblySummary.stage = 'error';
            payloadAssemblySummary.errorMessage = String(e && e.message || e).slice(0, 180);
          } finally {
            payloadAssemblySummary.elapsedMs = Math.max(0, Date.now() - payloadAssemblyStartedAt);
          }
          debug.payloadAssemblySummary = payloadAssemblySummary;
          logSf('PROBE_AFTER_PAYLOAD_ASSEMBLY', {
            stage: payloadAssemblySummary.stage,
            mode: payloadAssemblySummary.mode,
            htmlLengthEstimate: payloadAssemblySummary.htmlLengthEstimate,
            renderedTextLengthEstimate: payloadAssemblySummary.renderedTextLengthEstimate,
            geoSignalsBytesEstimate: payloadAssemblySummary.geoSignalsBytesEstimate,
            elapsedMs: payloadAssemblySummary.elapsedMs
          });
          logSfMemory('probe_after_payload_assembly');
        }
        logSf('PROBE_SEND', { probe: probeMode });
        logSfMemory('probe_send');
        return res.status(200).json({
          ok: true,
          mode: 'signalsOnlyProbe',
          probe: probeMode,
          url: urlToFetch,
          finalUrl,
          status: resp && typeof resp.status === 'function' ? resp.status() : null,
          geoSignalsV1,
          debug
        });
      }
      logSf('SIGNALS_ONLY_EARLY_SEND');
      logSfMemory('signals_only_early_send');
      return res.status(200).json({
        ok: true,
        mode: 'signalsOnlyEarly',
        url: urlToFetch,
        finalUrl,
        status: resp && typeof resp.status === 'function' ? resp.status() : null,
        geoSignalsV1,
        debug: {
          skippedHeavyPayload: true,
          reason: 'signalsOnly=1',
          evaluateCount: geoSignalsV1 && geoSignalsV1.diagnostics
            ? geoSignalsV1.diagnostics.evaluateCount
            : null
        }
      });
    }
    await Promise.race([
      page.waitForResponse(r => {
        const u = r.url();
        return u.endsWith('.js') || u.includes('firestore.googleapis.com');
      }, { timeout: 20_000 }).catch(()=>null),
      page.waitForTimeout(20_000)
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(()=>{});
    const appSelector = 'main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot], app-index';
    await page.waitForSelector(appSelector, { state: 'attached', timeout: 10_000 }).catch(()=>{});

    // === ここから追記（本文長しきい値で待機）===
    await page.waitForFunction(() => {
      const hasHeader = !!document.querySelector('header,[role="banner"]');
      const hasFooter = !!document.querySelector('footer,[role="contentinfo"]');
      const hasMain   = !!document.querySelector('main,[role="main"]');
      return hasHeader || hasFooter || hasMain;
    }, { timeout: 8000 }).catch(()=>{});

    // ---- dt/th に「設立|創業」が現れるまで最大 8 秒待つ（柔らかく）----
    await page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll('dl dt, table th'));
      return nodes.some(n => /設立|創業/.test((n.textContent || '').trim()));
    }, { timeout: 8000 }).catch(()=>{});
    addScrapeSpan('initial_goto_and_waits', __timingInitialWaitStart);

    const __timingEnrichedStart = Date.now();
    logSf('BEFORE_COLLECT_ENRICHED');
    logSfMemory('before_collect_enriched');
    const enrichedObservations = await collectEnrichedObservations(page, urlToFetch);
    addScrapeSpan('collectEnrichedObservations', __timingEnrichedStart);
    logSf('AFTER_COLLECT_ENRICHED', {
      keys: enrichedObservations && typeof enrichedObservations === 'object'
        ? Object.keys(enrichedObservations).length
        : 0
    });
    logSfMemory('after_collect_enriched');

    // === 観測拡張 v1（HTTPヘッダ / nav DOM / アンカーテキスト / 見出し） ===
    const obs = {};

    // --- HTTP headers (main document only) ---
    const __timingDomTextStart = Date.now();
    try{
      const h = (resp && typeof resp.allHeaders === 'function')
        ? await resp.allHeaders()
        : ((resp && typeof resp.headers === 'function') ? resp.headers() : {});

      const responseHeaders = {
        'strict-transport-security': h['strict-transport-security'] ?? null,
        'content-security-policy':   h['content-security-policy']   ?? null,
        'x-frame-options':           h['x-frame-options']           ?? null,
        'x-content-type-options':    h['x-content-type-options']    ?? null,
        'referrer-policy':           h['referrer-policy']           ?? null,
        'permissions-policy':        h['permissions-policy']        ?? null
      };

      obs.http = {
        ok: !!resp,
        status: resp ? resp.status() : null,
        url: resp ? resp.url() : null,
        // Playwrightは小文字キーのことが多い
        hsts: !!responseHeaders['strict-transport-security'],
        xfo:  !!responseHeaders['x-frame-options'],
        nosniff: !!responseHeaders['x-content-type-options'],
        csp:  !!responseHeaders['content-security-policy'],
        referrerPolicy: !!responseHeaders['referrer-policy'],
        permissionsPolicy: !!responseHeaders['permissions-policy'],
        responseHeaders,
        // 監査用に生ヘッダも残す（必要なら後で削る）
        headers: h
      };
    }catch(e){
      obs.http = { ok:false, reason:String(e && e.message || e) };
    }

    // --- DOM観測（nav / anchors / headings）---
    const domObs = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g,' ').trim();

      // Shadow DOM を含めて要素を列挙
      const allElementsDeep = () => {
        const out = [];
        const seen = new WeakSet();

        const walk = (root) => {
          if (!root) return;
          const nodes = (root instanceof Document)
            ? [root.documentElement]
            : [root];

          for (const n of nodes) {
            if (!n) continue;
            const stack = [n];
            while (stack.length) {
              const el = stack.pop();
              if (!el || seen.has(el)) continue;
              seen.add(el);

              if (el.nodeType === Node.ELEMENT_NODE) {
                out.push(el);
                // shadow root
                const sr = el.shadowRoot;
                if (sr) {
                  Array.from(sr.children || []).forEach(c => stack.push(c));
                  Array.from(sr.childNodes || []).forEach(c => {
                    if (c && c.nodeType === Node.ELEMENT_NODE) stack.push(c);
                  });
                }
                // normal children
                Array.from(el.children || []).forEach(c => stack.push(c));
              }
            }
          }
        };

        walk(document);
        return out;
      };

      const els = allElementsDeep();

      const isTag = (el, tag) => el && el.tagName && el.tagName.toLowerCase() === tag;
      const text = (el) => norm(el && (el.textContent || ''));
      const href = (a) => norm(a && a.getAttribute && a.getAttribute('href'));

      // nav（shadow含む）
      const navs = els.filter(el => isTag(el, 'nav'));
      const navAnchors = [];
      for (const n of navs) {
        // nav配下のaも shadow を掘る必要があるので、全要素から “nav内にいるa” を集める
        // （closest は shadow 境界で壊れることがあるので contains ベース）
        for (const el of els) {
          if (!isTag(el, 'a')) continue;
          try { if (n.contains(el)) navAnchors.push(el); } catch(_) {}
        }
      }

      // ul/li 構造（shadow含む）
      const navHasList = navs.some(n => {
        for (const el of els) {
          if (!el || !el.tagName) continue;
          const t = el.tagName.toLowerCase();
          if (t !== 'li') continue;
          try { if (n.contains(el)) return true; } catch(_) {}
        }
        return false;
      });

      // アンカーテキスト汎用語（shadow含む）
      const generic = new Set(['こちら','次へ','もっと見る','詳細を見る','詳しく見る','続きを読む','click','クリック','more','detail']);
      const allA = els.filter(el => isTag(el, 'a'));
      const genericHits = [];
      for (const a of allA){
        const t = text(a);
        if (!t) continue;
        if (generic.has(t)) genericHits.push({ t, href: href(a) });
      }

      // 見出し（shadow含む）
      const hs = els
        .filter(el => /^h[1-6]$/.test((el.tagName || '').toLowerCase()))
        .map(h => ({ tag: h.tagName.toLowerCase(), text: text(h) }))
        .filter(x => x.text);

      return {
        navCount: navs.length,
        navAnchorCount: navAnchors.length,
        navHasList,
        genericAnchorCount: genericHits.length,
        genericAnchorSamples: genericHits.slice(0, 10),
        headings: hs,
        hasH1: hs.some(x => x.tag === 'h1')
      };
    }).catch(()=>null);

    obs.dom = domObs || { ok:false };

    // === DOM観測リトライ（レンダ遅延対策）===
    if (obs.dom && typeof obs.dom.navCount === 'number' && obs.dom.navCount === 0) {
      await page.waitForTimeout(1200).catch(()=>{});
      const domObs2 = await page.evaluate(() => {
        const navs = Array.from(document.querySelectorAll('nav'));
        const navAnchors = navs.flatMap(n => Array.from(n.querySelectorAll('a')));
        const navHasList = navs.some(n => n.querySelector('ul li'));

        return {
          navCount: navs.length,
          navAnchorCount: navAnchors.length,
          navHasList
        };
      }).catch(()=>null);

      if (domObs2 && typeof domObs2.navCount === 'number' && domObs2.navCount > 0) {
        obs.dom = { ...obs.dom, ...domObs2 };
      }
    }

    // ここで obs を返却payloadに合流させる（下流が壊れない場所に）

    // ---- DOMテキスト（空でもOK）----
    const [innerText, docText] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
    const hydrated = ((innerText || '').replace(/\s+/g,'').length > 120);
    hydratedForTiming = hydrated;

  // === ここから追記（Shadow DOMも含めて深くテキストを収集）===
  const deepText = await page.evaluate(() => {
    const seen = new WeakSet();
    const getText = (root) => {
      let out = '';
      const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (node.nodeType === Node.TEXT_NODE) {
          out += (node.nodeValue || '') + '\n';
          return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const sr = node.shadowRoot;
          if (sr) Array.from(sr.childNodes).forEach(walk);   // Shadow root
          Array.from(node.childNodes).forEach(walk);         // 通常DOM
        }
      };
      walk(root);
      return out.replace(/\s+\n/g, '\n').trim();
    };
    return getText(document.documentElement);
  }).catch(() => '');

  // === ここからさらに追記（meta description を head から直接取る）===
  const metaDescription = await page.evaluate(() => {
    const el = document.head?.querySelector(
      'meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]'
    );
    return el?.getAttribute('content')?.replace(/\s+/g, ' ').trim() || '';
  });

  // “描画本文”として優先利用
  const renderedText = (deepText && deepText.replace(/\s+/g,'').length > 120)
    ? deepText
    : (innerText || docText || '');
  addScrapeSpan('dom_shadow_text_extract', __timingDomTextStart);

  // --- トップと /about の JSON-LD を比較 ---
  const __timingTopAboutSameStart = Date.now();
  const targetUrl = normalizeUrl(urlToFetch);
  const u = new URL(targetUrl);
  const topUrl   = u.origin + '/';
  const aboutUrl = u.origin + '/about';

  // HTML を取得（ナビゲーションはしない・request 経由）
  let topHtml = '';
  let aboutHtml = '';
  try {
    const r1 = await page.request.get(topUrl, { timeout: 20000 });
    if (r1.ok()) topHtml = await r1.text();
  } catch(_) {}
  try {
    const r2 = await page.request.get(aboutUrl, { timeout: 20000 });
    if (r2.ok()) aboutHtml = await r2.text();
  } catch(_) {}

  const jsonldTopAll   = extractJsonLdFromHtml(topHtml);
  const jsonldAboutAll = extractJsonLdFromHtml(aboutHtml);
  const jsonldPref     = preferAboutJsonLd(jsonldTopAll, jsonldAboutAll);
  const jsonldTopAboutAll = []
    .concat(Array.isArray(jsonldTopAll) ? jsonldTopAll : [])
    .concat(Array.isArray(jsonldAboutAll) ? jsonldAboutAll : []);

  const gtmTop   = hasGtmOrExternal(topHtml);
  const gtmAbout = hasGtmOrExternal(aboutHtml);

  // 既存の jsonld（動的レンダリングで拾った分）があればそのまま維持しつつ、比較結果は debug に載せる

    // ---- HTMLソース（タグあり）----
    // === ここから追加 ===
    logSf('BEFORE_CONTENT');
    logSfMemory('before_content');
    const htmlSource = await page.content().catch(() => '');
    logSf('AFTER_CONTENT', { htmlLength: typeof htmlSource === 'string' ? htmlSource.length : 0 });
    logSfMemory('after_content');

    const shadowNavHtml = await page.evaluate(() => {
      const out = [];
      const seenHtml = new Set();

      const pushIfMatch = (el) => {
        if (!el || !el.tagName) return;
        const tag = el.tagName.toLowerCase();
        if (tag !== 'header' && tag !== 'nav') return;

        const html = String(el.outerHTML || '').trim();
        if (!html) return;
        if (seenHtml.has(html)) return;

        seenHtml.add(html);
        out.push(html);
      };

      const walk = (root) => {
        if (!root || !root.querySelectorAll) return;

        const nodes = Array.from(root.querySelectorAll('*'));
        for (const el of nodes) {
          pushIfMatch(el);
          if (el.shadowRoot) {
            walk(el.shadowRoot);
          }
        }
      };

      walk(document);
      return out.join('\n');
    }).catch(() => '');

    const payloadHtml = shadowNavHtml
      ? htmlSource + '\n<!-- shadow-nav-fragments -->\n' + shadowNavHtml
      : htmlSource;
    // === ここまで追加 ===

    // ---- 設立（STRICT: DOM/HTML 構造のみ）----
    let foundFoundingDate = '';
    let foundFoundingDateSource = null;

    if (FOUNDED_MODE !== 'off') {
      const domIso = await getFoundingFromDOM(page);
      if (domIso) { foundFoundingDate = domIso; foundFoundingDateSource = 'dom'; }
      if (!foundFoundingDate) {
        const htmlIso = getFoundingFromHTML(htmlSource);
        if (htmlIso) { foundFoundingDate = htmlIso; foundFoundingDateSource = 'html'; }
      }
    }

    // ---- sameAs（ページ内 a[href] & HTML直書きURL）----
    const bundleSameAs = [];
    const SOCIAL_HOST_RE = /(twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|linkedin\.com|note\.com|wantedly\.com|tiktok\.com)/i;

    const anchorHrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href') || '').filter(Boolean)).catch(()=>[]);
    for (const href of anchorHrefs) {
      try {
        const u = new URL(href, urlToFetch);
        if (SOCIAL_HOST_RE.test(u.hostname)) bundleSameAs.push(u.toString());
      } catch(_) {}
    }
    try {
      const resp0 = await page.request.get(urlToFetch, { timeout: 20000 });
      if (resp0.ok()) {
        const html0 = await resp0.text();
        const urlMatches0 = html0.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches0) {
          try {
            const host = new URL(rawUrl).hostname;
            if (SOCIAL_HOST_RE.test(host)) bundleSameAs.push(String(rawUrl));
          } catch (_) {}
        }
      }
    } catch {}

    // ---- JSON-LD（参考）----
    const jsonld = await page.evaluate(() => {
      const arr = [];
      for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
        try { arr.push(JSON.parse(s.textContent.trim())); } catch(_) {}
      }
      return arr;
    }).catch(()=>[]);

    // === [JSONLD][ORG-WEBSITE-FLAGS v1] Org / WebSite 用フラグを算出 ===
    // flags 判定では Org-only の jsonldPref を使わず、
    // top + about の全 JSON-LD を優先し、無ければ DOM 由来へフォールバックする。
    const jsonldForFlags = (Array.isArray(jsonldTopAboutAll) && jsonldTopAboutAll.length)
      ? jsonldTopAboutAll
      : (Array.isArray(jsonld) ? jsonld : []);

    const jsonldTypesAll = flatTypesFromJsonLd(jsonldForFlags);

    // const hasJsonLdFlag =
    //   Array.isArray(jsonldForFlags) && jsonldForFlags.length > 0;

    // const hasOrgJsonLdFlag = jsonldTypesAll.some(t =>
    //   /^(Organization|Corporation|LocalBusiness)$/i.test(String(t))
    // );

    // const hasWebsiteJsonLdFlag = jsonldTypesAll.some(t =>
    //   /^(WebSite|WebPage)$/i.test(String(t))
    // );

    // ---- script/src と modulepreload から JS 候補URLを収集 ----
    const { scriptSrcs, preloadHrefs } = await page.evaluate(() => {
      const s = Array.from(document.querySelectorAll('script[src]')).map(el => el.getAttribute('src')).filter(Boolean);
      const l = Array.from(document.querySelectorAll('link[rel="modulepreload"][href]')).map(el => el.getAttribute('href')).filter(Boolean);
      return { scriptSrcs: s, preloadHrefs: l };
    });
    const abs = (u) => { try { return new URL(u, urlToFetch).toString(); } catch { return null; } };
    const jsUrls = uniq([...(scriptSrcs||[]), ...(preloadHrefs||[])]).map(abs).filter(Boolean);

    // --- ページで読み込まれたリソース一覧から JSON 系も拾う（電話/住所/同社SNSのみに使用）---
    const resourceUrls = await page.evaluate(() => {
      try {
        return performance.getEntriesByType('resource')
          .map(e => e.name)
          .filter(Boolean);
      } catch { return []; }
    });
    const extraJsonUrls = uniq(resourceUrls.filter(u =>
      /(\.json(\?|$))|googleapis|sheets|gviz|cms|data/i.test(u)
    ));
    const jsonToTap = extraJsonUrls.filter(u => !jsUrls.includes(u));
    addScrapeSpan('top_about_same_fetch', __timingTopAboutSameStart);

    // ---- 正規表現（電話/郵便のみ）----
    const PHONE_RE = /(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g;
    const ZIP_RE   = /〒?\d{3}-?\d{4}/g;

    const bundlePhones = [];
    const bundleZips   = [];
    const bundleAddrs  = [];
    const fetchedMeta  = [];
    const tappedUrls   = [];
    const tappedAppIndexBodies = [];
    const labelHitPhones = [];
    const LABEL_RE = /(代表電話|代表|電話|お問い合わせ|TEL|Tel|Phone)/i;

    // tel:リンク
    const telLinks = await page.$$eval('a[href^="tel:"]',
      as => as.map(a => (a.getAttribute('href') || '')
        .replace(/^tel:/i,'')
        .replace(/^\+81[-\s()]?/,'0')
        .trim()
      )
    ).catch(()=>[]);

    // --- リソース由来の JSON（電話/住所/同社SNSのみに使用）---
    const __timingJsonTapStart = Date.now();
    logSf('BEFORE_RESOURCE_TAP', { type: 'json', count: Array.isArray(jsonToTap) ? jsonToTap.length : 0 });
    logSfMemory('before_resource_json_tap');
    for (const u of jsonToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 10000 });
        if (!resp.ok()) continue;
        const body = await resp.text();
        if (!body) continue;

        const raw = body;
        const decoded = decodeUnicodeEscapes(raw);
        const scan = raw + '\n' + decoded;

        // 電話
        (scan.match(PHONE_RE) || [])
          .map(normalizeJpPhone)
          .filter(Boolean)
          .forEach(v => bundlePhones.push(v));

        // 郵便番号
        (scan.match(ZIP_RE) || [])
          .filter(looksLikeZip7)
          .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

        // 住所っぽい行
        for (const line of scan.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
        }

        // sameAs（JSON内の直書きURL）
        const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches) {
          try {
            const p = new URL(rawUrl);
            if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
          } catch(_) {}
        }
      } catch {}
    }
    addScrapeSpan('resource_json_tap', __timingJsonTapStart);
    logSf('AFTER_RESOURCE_TAP', { type: 'json' });
    logSfMemory('after_resource_json_tap');

    // ページが教えてくれたJS候補 + 典型的なエントリ
    const jsToTap = uniq([
      ...jsUrls,
      `${new URL(urlToFetch).origin}/app-index.js`
    ]);

    // ---- JS/JSON 本文を取得して抽出（※設立は見ない）----
    const __timingJsTapStart = Date.now();
    logSf('BEFORE_RESOURCE_JS_TAP', { count: Array.isArray(jsToTap) ? jsToTap.length : 0 });
    logSfMemory('before_resource_js_tap');
    for (const u of jsToTap) {
      try {
        const resp = await page.request.get(u, { timeout: 20_000 });
        if (!resp.ok()) continue;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!(ct.includes('javascript') || ct.includes('json') || u.endsWith('.js') || u.endsWith('.json'))) continue;

        const text = await resp.text();
        if (/\/app-index\.js(\?|$)/.test(u)) {
          tappedAppIndexBodies.push(text || '');
        }
        if (!text) continue;

        const raw = text || '';
        const decoded = decodeUnicodeEscapes(raw);
        const scan = raw + '\n' + decoded;

        tappedUrls.push(u);
        fetchedMeta.push({ url: u, ct, textLen: raw.length });

        // ラベル近接での電話抽出
        try {
          for (const m of scan.matchAll(PHONE_RE)) {
            const rawNum = m[0];
            const idx = m.index ?? -1;
            let near = '';
            if (idx >= 0) {
              const start = Math.max(0, idx - 60);
              const end   = Math.min(scan.length, idx + rawNum.length + 60);
              near = scan.slice(start, end);
            }
            if (near && LABEL_RE.test(near)) {
              const n = normalizeJpPhone(rawNum);
              if (n) labelHitPhones.push(n);
            }
          }
        } catch {}

        // 電話
        (scan.match(PHONE_RE) || [])
          .map(normalizeJpPhone)
          .filter(Boolean)
          .forEach(v => bundlePhones.push(v));

        // 郵便番号
        (scan.match(ZIP_RE) || [])
          .filter(looksLikeZip7)
          .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

        // 住所っぽい行
        for (const line of scan.split(/\n+/)) {
          if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
            bundleAddrs.push(line.replace(/\s+/g,' ').trim());
          }
        }

        // sameAs らしき URL（スクリプト内の直書き）
        const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
        for (const rawUrl of urlMatches) {
          try {
            const p = new URL(rawUrl);
            if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
          } catch(_) {}
        }
      } catch(_) {}
    }
    addScrapeSpan('resource_js_tap', __timingJsTapStart);
    logSf('AFTER_RESOURCE_JS_TAP', { tappedCount: Array.isArray(tappedUrls) ? tappedUrls.length : 0 });
    logSfMemory('after_resource_js_tap');

    // -------- 2nd pass: app-index.js が参照する chunk-*.js を最大 8 本だけ追撃（※設立は見ない）--------
    const __timingChunkTapStart = Date.now();
    logSf('BEFORE_CHUNK_TAP');
    logSfMemory('before_chunk_tap');
    try {
      const extraChunkUrls = new Set();
      for (const t of tappedAppIndexBodies) {
        const m = (t || '').match(/["'`](\/chunk-[A-Za-z0-9-]+\.js)["'`]/g) || [];
        for (const raw of m) {
          const rel = raw.replace(/^["'`]|["'`]$/g, '');
          try {
            const absUrl = new URL(rel, urlToFetch).toString();
            if (!tappedUrls.includes(absUrl)) extraChunkUrls.add(absUrl);
          } catch {}
        }
      }

      let count = 0;
      for (const u of Array.from(extraChunkUrls)) {
        if (count++ >= 8) break;
        try {
          const resp = await page.request.get(u, { timeout: 15_000 });
          if (!resp.ok()) continue;
          const ct = (resp.headers()['content-type'] || '').toLowerCase();
          if (!(ct.includes('javascript') || u.endsWith('.js'))) continue;

          const text = await resp.text();
          if (!text) continue;

          const raw = text || '';
          const decoded = decodeUnicodeEscapes(raw);
          const scan = raw + '\n' + decoded;

          // 電話
          (scan.match(PHONE_RE) || [])
            .map(normalizeJpPhone)
            .filter(Boolean)
            .forEach(v => bundlePhones.push(v));

          // 郵便番号
          (scan.match(ZIP_RE) || [])
            .filter(looksLikeZip7)
            .forEach(v => bundleZips.push(v.replace(/^〒/, '')));

          // 住所っぽい行
          for (const line of scan.split(/\n+/)) {
            if (/[都道府県]|市|区|町|村|丁目/.test(line) && line.length < 200) {
              bundleAddrs.push(line.replace(/\s+/g,' ').trim());
            }
          }

          // sameAs
          const urlMatches = scan.match(/https?:\/\/[^\s"'<>]+/g) || [];
          for (const rawUrl of urlMatches) {
            try {
              const p = new URL(rawUrl);
              if (SOCIAL_HOST_RE.test(p.hostname)) bundleSameAs.push(p.toString());
            } catch(_) {}
          }
        } catch {}
      }
    } catch {}
    // -------- 2nd pass end --------
    addScrapeSpan('chunk_tap', __timingChunkTapStart);
    logSf('AFTER_CHUNK_TAP');
    logSfMemory('after_chunk_tap');

    // ---- 整理 & 採用値の決定 ----
    const phones = uniq(bundlePhones);
    const zips   = uniq(bundleZips);
    const addrs  = uniq(bundleAddrs);

    const pickedPhone = pickBestPhone({
      telLinks,
      phones,
      labelHits: labelHitPhones,
      corpusText: innerText || docText || ''
    });
    const pickedAddress = parseBestAddressFromLines(addrs);

    // bodyText フォールバック
    let bodyText = innerText && innerText.trim() ? innerText : '';
    if (!bodyText) {
      const lines = [];
      if (pickedPhone) lines.push('TEL: ' + pickedPhone);
      if (pickedAddress) {
        const p = pickedAddress;
        const addrLine = [p.postalCode, p.addressRegion, p.addressLocality, p.streetAddress]
          .filter(Boolean).join(' ');
        lines.push('ADDR: ' + addrLine);
      } else {
        if (zips.length)  lines.push('ZIP: ' + zips.slice(0,3).join(', '));
        if (addrs.length) lines.push('ADDR: ' + addrs.slice(0,2).join(' / '));
      }
      bodyText = lines.join('\n') || '（抽出対象のテキストが見つかりませんでした）';
    }

    // --- sameAs フィルタ＆重複排除（SNS系のみ残す） ---
    const ALLOW_HOST_SNS = /(facebook\.com|instagram\.com|note\.com|twitter\.com|x\.com|youtube\.com|linkedin\.com|tiktok\.com)/i;
    const sameAsClean = Array.from(new Set(
      (bundleSameAs || [])
        .map(u => String(u || '').trim())
        .filter(u => /^https?:\/\//i.test(u))
        .filter(u => ALLOW_HOST_SNS.test((() => { try { return new URL(u).hostname; } catch { return ''; } })()))
    ));

    // === ここから追記（“採点に使う素材”を決定：Rendered > 静的HTML）===
    const scoringHtml  = (aboutHtml || topHtml || payloadHtml || '');
    const scoringBodyA = renderedText || '';
    const scoringBodyB = stripTags(scoringHtml);
    const scoringBody  = (scoringBodyA.replace(/\s+/g,'').length >= 200) ? scoringBodyA : scoringBodyB;

    // === JSON-LD の実出現をピンポイント待機（最大 20 秒に延長） ===
    const __timingJsonLdProbeStart = Date.now();
    await page.waitForFunction(() => {
      return !!document.querySelector('script[type="application/ld+json" i]');
    }, { timeout: 20000 }).catch(()=>{}); // ← 12s→20s に延長

    // === 出現後スナップショット（短時間プローブ） ===
    const __probe = await probeJsonLdAndCopyright(page, { maxWaitMs: 600, pollMs: 100 });

    // === Fallback: app-index.js 内の JSON-LD リテラル検出（DOM挿入前でも実装あり扱い） ===
    try {
      if (!__probe.jsonld_detected_once) {
        const jsBodies = Array.isArray(tappedAppIndexBodies) ? tappedAppIndexBodies : [];
        const hit = jsBodies.find(txt =>
          /"@context"\s*:\s*"https?:\/\/schema\.org"/i.test(txt) ||
          /type\s*[:=]\s*["']application\/ld\+json["']/i.test(txt)
        );
        if (hit) {
          const start = hit.indexOf('{');
          const head = start >= 0 ? hit.slice(start, start + 80) : hit.slice(0, 80);

          // 1) JSON-LD が「ありそう」というフラグ類
          __probe.jsonld_detected_once = true;
          __probe.jsonld_detect_count  = Math.max(1, __probe.jsonld_detect_count || 0);
          __probe.jsonld_timed_out     = false;
          __probe.jsonld_sample_head   = head;

          // 2) "@type" をざっくり抜き出して jsonld_types に積む
          try {
            const types = [];
            const re = /"@type"\s*:\s*"([^"]+)"/g;
            let m;
            while ((m = re.exec(hit)) !== null) {
              const typ = (m[1] || '').trim();
              if (typ) types.push(typ);
            }
            if (types.length) {
              const uniqTypes = Array.from(new Set(types));
              if (!Array.isArray(__probe.jsonld_types)) {
                __probe.jsonld_types = uniqTypes;
              } else {
                __probe.jsonld_types = Array.from(
                  new Set(__probe.jsonld_types.concat(uniqTypes))
                );
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    addScrapeSpan('jsonld_wait_probe', __timingJsonLdProbeStart);

    // === Fallback（コピーライト）：CSR前でも静的/レンダ済みから検知 ===
    try {
      if (!__probe.copyright_hit) {
        const hayA = (typeof scoringHtml === 'string' ? scoringHtml : '') + '\n' + (renderedText || '');
        const hayB = htmlSource || '';
        const re = /©|&copy;|&#169;|copyright|コピーライト|著作権/i;

        const hitA = re.test(hayA);
        const hitB = re.test(hayB);

        if (hitA || hitB) {
          const src = hitA ? hayA : hayB;
          const i = src.search(re);
          const excerpt = i >= 0 ? src.slice(Math.max(0, i - 10), i + 90) : src.slice(0, 100);

          __probe.copyright_hit = true;
          __probe.copyright_hit_token = '©';
          __probe.copyright_excerpt = excerpt;
        }
      }
    } catch (_) {}

    // === Fallback: app-index.js 内の JSON-LD リテラル検出（DOM挿入前でも実装ありとみなす） ===
    try {
      if (!__probe.jsonld_detected_once) {
        // すでに上流で収集済み（/app-index.js の本文）
        const jsBodies = Array.isArray(tappedAppIndexBodies) ? tappedAppIndexBodies : [];
        const hit = jsBodies.find(txt =>
          /"@context"\s*:\s*"https?:\/\/schema\.org"/i.test(txt) ||
          /type\s*[:=]\s*["']application\/ld\+json["']/i.test(txt)
        );
        if (hit) {
          const start = hit.indexOf('{');
          const head = start >= 0 ? hit.slice(start, start + 80) : hit.slice(0, 80);
          __probe.jsonld_detected_once = true;
          __probe.jsonld_detect_count = Math.max(1, __probe.jsonld_detect_count || 0);
          __probe.jsonld_timed_out = false;
          __probe.jsonld_sample_head = head;
        }
      }
    } catch (_) {}

    // ---- 返却ペイロードを組み立て ----
    const structured = {
      telephone: pickedPhone || null,
      address: pickedAddress || null,
      foundingDate: foundFoundingDate || null,
      sameAs: sameAsClean
    };

    const responseOrigin = (() => { try { return new URL(urlToFetch).origin; } catch (_) { return ''; } })();
    let subPagesVNext = [];
    let publisherInfo = null;
    const __timingSubpagesStart = Date.now();
    logSf('BEFORE_SUBPAGES', { enabled: !!ENABLE_SUBPAGES_VNEXT });
    logSfMemory('before_subpages');
    if (ENABLE_SUBPAGES_VNEXT) {
      if (typeof buildSubPagesVNext_V1_ === 'function') {
        subPagesVNext = await buildSubPagesVNext_V1_(page, responseOrigin, scrapeTiming.subpagesVNextDecision);
        publisherInfo = buildPublisherInfoFromSubPagesVNext_(subPagesVNext, structured, responseOrigin);
      } else {
        try {
          Object.assign(scrapeTiming.subpagesVNextDecision, {
            enabled: true,
            envValue: process.env.ENABLE_SUBPAGES_VNEXT ?? null,
            origin: responseOrigin,
            skipReason: 'build_function_missing',
            errorMessage: 'buildSubPagesVNext_V1_ is not defined',
            elapsedMs: Math.max(0, Date.now() - __timingSubpagesStart)
          });
        } catch (_) {}
      }
    } else {
      try {
        Object.assign(scrapeTiming.subpagesVNextDecision, {
          enabled: false,
          envValue: process.env.ENABLE_SUBPAGES_VNEXT ?? null,
          origin: responseOrigin,
          skipReason: 'disabled_by_env',
          elapsedMs: Math.max(0, Date.now() - __timingSubpagesStart)
        });
      } catch (_) {}
      console.log('[SUBPAGE_ENRICH][DISABLED]', JSON.stringify({
        url: urlToFetch,
        reason: 'ENABLE_SUBPAGES_VNEXT=0'
      }));
    }
    addScrapeSpan('subpages_vnext', __timingSubpagesStart);
    logSf('AFTER_SUBPAGES', { count: Array.isArray(subPagesVNext) ? subPagesVNext.length : 0 });
    logSfMemory('after_subpages');
    try {
      if (scrapeTiming.subpagesVNextDecision && !scrapeTiming.subpagesVNextDecision.elapsedMs) {
        scrapeTiming.subpagesVNextDecision.elapsedMs = Math.max(0, Date.now() - __timingSubpagesStart);
      }
    } catch (_) {}
    const securityHeaders = summarizeSecurityHeaders_((obs.http && obs.http.responseHeaders) ? obs.http.responseHeaders : {});

    if (enrichedObservations && typeof enrichedObservations === 'object') {
      enrichedObservations.subpages = subPagesVNext;
      enrichedObservations.subpageDetails = subPagesVNext;
      enrichedObservations.pageDetails = subPagesVNext;
      enrichedObservations.publisherInfo = publisherInfo;
      enrichedObservations.securityHeaders = securityHeaders;
    }

    console.log('[PUBLISHER_INFO][SUMMARY]', JSON.stringify({
      checked: !!publisherInfo,
      sourceUrl: publisherInfo && publisherInfo.sourceUrl,
      companyName: publisherInfo && publisherInfo.companyName,
      organizationName: publisherInfo && publisherInfo.organizationName,
      hasAddress: !!(publisherInfo && publisherInfo.address),
      hasTelephone: !!(publisherInfo && publisherInfo.telephone),
      hasContactEmail: !!(publisherInfo && publisherInfo.contactEmail),
      hasRepresentative: !!(publisherInfo && publisherInfo.representative),
      hasCorporateNumber: !!(publisherInfo && publisherInfo.corporateNumber)
    }));
    console.log('[SECURITY_HEADERS][SUMMARY]', JSON.stringify({
      checked: !!securityHeaders,
      strictTransportSecurity: !!(securityHeaders && securityHeaders.strictTransportSecurity),
      contentSecurityPolicy: !!(securityHeaders && securityHeaders.contentSecurityPolicy),
      xFrameOptions: !!(securityHeaders && securityHeaders.xFrameOptions),
      xContentTypeOptions: !!(securityHeaders && securityHeaders.xContentTypeOptions),
      referrerPolicy: !!(securityHeaders && securityHeaders.referrerPolicy),
      permissionsPolicy: !!(securityHeaders && securityHeaders.permissionsPolicy)
    }));

    logSf('BEFORE_STRUCTURED_JSONLD');
    logSfMemory('before_structured_jsonld');
    structured.jsonld = await page.evaluate(() => {
      var nodes = [];

      function qa(root, sel) {
        try { return root ? Array.from(root.querySelectorAll(sel)) : []; } catch (_) { return []; }
      }

      function pushNode(n){
        if (!n || typeof n !== 'object') return;
        nodes.push(n);
      }

      function walk(input){
        if (!input) return;

        if (Array.isArray(input)) {
          input.forEach(walk);
          return;
        }

        if (typeof input !== 'object') return;

        pushNode(input);

        if (Array.isArray(input['@graph'])) {
          input['@graph'].forEach(function(n){
            if (n && typeof n === 'object') nodes.push(n);
          });
        }
      }

      var hosts = Array.from(document.querySelectorAll('*'));
      var openRoots = [];
      for (var i = 0; i < hosts.length; i++) {
        var el = hosts[i];
        if (el && el.shadowRoot) openRoots.push(el.shadowRoot);
        if (openRoots.length >= 8) break;
      }

      var allScriptsLight = qa(document, 'script');
      var allScriptsShadow = openRoots.flatMap(function(root){ return qa(root, 'script'); });
      var allScripts = allScriptsLight.concat(allScriptsShadow);

      var scripts = allScripts.filter(function(el){
        var t = String(el && el.getAttribute && el.getAttribute('type') || '').toLowerCase().trim();
        return t.includes('ld+json');
      });

      if (scripts.length === 0) {
        scripts = allScripts.filter(function(el){
          var t = String(el && el.getAttribute && el.getAttribute('type') || '').toLowerCase().trim();
          if (t && t !== 'application/json' && t !== 'text/plain' && t !== 'text/template') return false;
          var txt = String(el && el.textContent || '').trim();
          return txt.includes('"@context"') && txt.includes('"@type"');
        });
      }

      scripts.forEach(function(el){
        var raw = String(el && el.textContent || '').trim();
        if (!raw) return;

        try {
          var parsed = JSON.parse(raw);
          walk(parsed);
        } catch (_) {}
      });

      return nodes;
    }).catch(() => []);
    logSf('AFTER_STRUCTURED_JSONLD', { count: Array.isArray(structured.jsonld) ? structured.jsonld.length : 0 });
    logSfMemory('after_structured_jsonld');

    const jsonldSynth = [{
      "@context": "https://schema.org",
      "@type": "Organization",
      "url": normalizeUrl(urlToFetch),
      "name": "企業情報",
      ...(pickedPhone ? { "telephone": pickedPhone } : {}),
      ...(pickedAddress ? { "address": { "@type": "PostalAddress", ...pickedAddress } } : {}),
      ...(sameAsClean && sameAsClean.length ? { "sameAs": sameAsClean } : {}),
      ...(foundFoundingDate ? { "foundingDate": foundFoundingDate } : {})
    }];

    const elapsedMs = Date.now() - t0;

    // === JSON-LD 種別フラグ（Org / WebSite）を算出 ===
    let hasJsonLdFlag = false;
    let hasOrgJsonLdFlag = false;
    let hasWebsiteJsonLdFlag = false;

    try {
      // flags 判定では Org-only の jsonldPref を使わず、top + about 全体を優先する
      const baseJsonLd = Array.isArray(jsonldTopAboutAll) && jsonldTopAboutAll.length
        ? jsonldTopAboutAll
        : jsonld;

      const flatTypes = flatTypesFromJsonLd(baseJsonLd || []);

      hasJsonLdFlag = !!(baseJsonLd && baseJsonLd.length > 0);
      hasOrgJsonLdFlag = flatTypes.some(t =>
        /^(Organization|LocalBusiness|Corporation)$/i.test(String(t))
      );
      hasWebsiteJsonLdFlag = flatTypes.some(t =>
        /^(WebSite|WebPage)$/i.test(String(t))
      );

      // （必要ならデバッグ用ログ）
      // console.log('[JSONLD-FLAGS][probe]', {
      //   hasJsonLdFlag, hasOrgJsonLdFlag, hasWebsiteJsonLdFlag, flatTypes
      // });
    } catch (_) {
      // フラグ計算に失敗しても全体は止めない
    }

    // ★ 追加: head/meta + JSON-LD + コピーライトをまとめた auditSig を構築
    let auditSig = null;
    const __timingAuditSigProbeStart = Date.now();
    try {
      logSf('BEFORE_AUDITSIG');
      logSfMemory('before_auditsig');
      auditSig = await buildAuditSigFromPage(page);
      logSf('AFTER_AUDITSIG', {
        keys: auditSig && typeof auditSig === 'object' ? Object.keys(auditSig).length : 0
      });
      logSfMemory('after_auditsig');
    } catch (_) {
      auditSig = null;  // 失敗しても全体は止めない
      logSf('AFTER_AUDITSIG', { error: true });
      logSfMemory('after_auditsig_error');
    }
    addScrapeSpan('jsonld_wait_probe', __timingAuditSigProbeStart);

    let productSpecComparisonSignals = null;
    try {
      console.log('[PW][PRODUCT_SPEC_SENTINEL]', JSON.stringify({
        phase: 'before_collect',
        hasAuditSig: !!auditSig,
        auditSigKeys: Object.keys(auditSig || {}).slice(0, 20)
      }));
      logSf('BEFORE_PRODUCT_SPEC');
      logSfMemory('before_product_spec');
      productSpecComparisonSignals = await collectProductSpecComparisonSignals(page, jsonldForFlags);
      logSf('AFTER_PRODUCT_SPEC', { ok: !!productSpecComparisonSignals });
      logSfMemory('after_product_spec');
      if (auditSig && typeof auditSig === 'object' && productSpecComparisonSignals) {
        auditSig.productSpecComparisonSignals = productSpecComparisonSignals;
      }
      console.log('[PW][PRODUCT_SPEC_COMPARISON_SIGNALS]', JSON.stringify({
        attached: !!productSpecComparisonSignals,
        comparisonReadinessLevel: productSpecComparisonSignals && productSpecComparisonSignals.comparisonReadinessLevel,
        structuredSpecScore: productSpecComparisonSignals && productSpecComparisonSignals.structuredSpecScore,
        hasStructuredProductInfo: productSpecComparisonSignals && productSpecComparisonSignals.hasStructuredProductInfo,
        hasComparisonReadyShape: productSpecComparisonSignals && productSpecComparisonSignals.hasComparisonReadyShape,
        evidenceSources: productSpecComparisonSignals && productSpecComparisonSignals.evidenceSources
      }));
    } catch (e) {
      productSpecComparisonSignals = null;
      logSf('AFTER_PRODUCT_SPEC', { error: true, message: String(e && e.message || e).slice(0, 180) });
      logSfMemory('after_product_spec_error');
      console.log('[PW][PRODUCT_SPEC_COMPARISON_SIGNALS][ERR]', String(e && (e.stack || e.message || e)));
    }

    let multimodalSignals = null;
    const __timingMultimodalSignalStart = Date.now();
    try {
      logSf('BEFORE_MULTIMODAL');
      logSfMemory('before_multimodal');
      multimodalSignals = await collectMultimodalSignals(page, jsonldForFlags);
      logSf('AFTER_MULTIMODAL', { checked: !!(multimodalSignals && multimodalSignals.checked) });
      logSfMemory('after_multimodal');
      if (auditSig && typeof auditSig === 'object') {
        auditSig.multimodalSignals = multimodalSignals;
      }
      if (enrichedObservations && typeof enrichedObservations === 'object') {
        enrichedObservations.multimodalSignals = multimodalSignals;
      }
    } catch (e) {
      logSf('AFTER_MULTIMODAL', { error: true, message: String(e && e.message || e).slice(0, 180) });
      logSfMemory('after_multimodal_error');
      multimodalSignals = {
        checked: false,
        source: 'top_dom_head_meta_jsonld',
        errorMessage: String(e && (e.stack || e.message || e) || '').slice(0, 500)
      };
      if (auditSig && typeof auditSig === 'object') {
        auditSig.multimodalSignals = multimodalSignals;
      }
      if (enrichedObservations && typeof enrichedObservations === 'object') {
        enrichedObservations.multimodalSignals = multimodalSignals;
      }
    }
    addScrapeSpan('multimodal_signal_collect', __timingMultimodalSignalStart);

    // ★ 追記: auditSig.jsonldTypes で Org / WebSite フラグを補強
    try {
      if (auditSig && Array.isArray(auditSig.jsonldTypes)) {
        const typesFromAudit = auditSig.jsonldTypes.map(t => String(t || ''));

        // 何か 1 つでも type があれば「JSON-LD あり」とみなす
        if (!hasJsonLdFlag && typesFromAudit.length > 0) {
          hasJsonLdFlag = true;
        }

        // Organization / Corporation / LocalBusiness が 1 つでもあれば Org フラグ ON
        if (!hasOrgJsonLdFlag &&
            typesFromAudit.some(t => /(Organization|Corporation|LocalBusiness)/i.test(t))) {
          hasOrgJsonLdFlag = true;
        }

        // WebSite / WebPage があれば WebSite フラグ ON（あれば）
        if (!hasWebsiteJsonLdFlag &&
            typesFromAudit.some(t => /(WebSite|WebPage)/i.test(t))) {
          hasWebsiteJsonLdFlag = true;
        }
      }
    } catch (_) {
      // 補強に失敗しても全体は止めない
    }

  // ★ coverage ナビフラグ：/about やトップのHTMLを優先しつつ検出
  logSf('BEFORE_COVERAGE_NAV');
  logSfMemory('before_coverage_nav');
  const coverageNav = detectCoverageNavFromHtmlNode(
    topHtml || htmlSource || scoringHtml || bodyText
  );
  logSf('AFTER_COVERAGE_NAV', {
    keys: coverageNav && typeof coverageNav === 'object' ? Object.keys(coverageNav).length : 0
  });
  logSfMemory('after_coverage_nav');

  // ★ 追加：auditSig にも載せる（GAS 側で auditSig.coverageNav を参照できるように）
  if (auditSig && typeof auditSig === 'object') auditSig.coverageNav = coverageNav;

  // === XML サイトマップ有無チェック（/sitemap.xml 簡易判定） ===
  let hasSitemapXml = false;
  let sitemapDiscovery = {
    checked: false,
    exists: null,
    url: null,
    httpStatus: null,
    discoveryMethod: 'not_checked',
    checkedUrls: []
  };
  try {
    logSf('BEFORE_SITEMAP_CHECK');
    logSfMemory('before_sitemap_check');
    let origin = null;
    try {
      origin = new URL(urlToFetch).origin;
    } catch (_) {
      origin = null;
    }

    if (origin) {
      const fetchTextWithPageRequest = async (targetUrl, timeoutMs = 1500) => {
        try {
          const response = await page.request.get(targetUrl, {
            timeout: timeoutMs,
            headers: { 'Accept': 'application/xml,text/xml,text/plain,*/*;q=0.8' }
          });
          const status = response && typeof response.status === 'function' ? response.status() : null;
          const headers = response && typeof response.headers === 'function' ? response.headers() : {};
          const contentType = String((headers && (headers['content-type'] || headers['Content-Type'])) || '');
          if (!response || !response.ok()) return { ok: false, status, text: '', contentType };
          const text = String(await response.text() || '').slice(0, 120000);
          return { ok: true, status, text, contentType };
        } catch (e) {
          return { ok: false, status: null, text: '', contentType: '', errorMessage: String(e && (e.message || e) || '').slice(0, 160) };
        }
      };
      sitemapDiscovery = await discoverSitemapFromOrigin_(origin, fetchTextWithPageRequest, { timeoutMs: 2500 });
      hasSitemapXml = sitemapDiscovery.exists === true;
    }
    attachSitemapDiscoveryToGeoSignals_(geoSignalsV1, sitemapDiscovery);

    // auditSig があれば、ついでにそこにも載せておく（GAS 側互換用）
    if (auditSig && typeof auditSig === 'object') {
      auditSig.hasSitemapXml = hasSitemapXml;
      auditSig.sitemapChecked = sitemapDiscovery.checked === true;
      auditSig.sitemapExists = sitemapDiscovery.exists;
      auditSig.sitemapXmlUrl = sitemapDiscovery.url;
      auditSig.sitemapDiscoveryMethod = sitemapDiscovery.discoveryMethod;
      auditSig.sitemapCheckedUrls = Array.isArray(sitemapDiscovery.checkedUrls) ? sitemapDiscovery.checkedUrls.slice(0, 10) : [];
      auditSig.sitemapHttpStatus = sitemapDiscovery.httpStatus;
      auditSig.sitemapRobotsTxtUrl = sitemapDiscovery.robotsTxtUrl || null;
      auditSig.sitemapRobotsHttpStatus = sitemapDiscovery.robotsHttpStatus;
    }
    logSf('AFTER_SITEMAP_CHECK', {
      hasSitemapXml,
      sitemapDiscoveryMethod: sitemapDiscovery.discoveryMethod,
      sitemapResolvedUrl: sitemapDiscovery.url,
      sitemapHttpStatus: sitemapDiscovery.httpStatus,
      sitemapCheckedUrls: sitemapDiscovery.checkedUrls
    });
    logSfMemory('after_sitemap_check');
  } catch (_) {
    // 失敗しても診断全体は止めない（hasSitemapXml は false のまま）
    logSf('AFTER_SITEMAP_CHECK', { error: true });
    logSfMemory('after_sitemap_check_error');
  }

  const __timingResponsePayloadStart = Date.now();
  const __timingHeadingExtractStart = Date.now();
  logSf('BEFORE_HEADING_EXTRACT');
  logSfMemory('before_heading_extract');
  const headingTexts = await page.evaluate(() => {
    function collect(root) {
      const out = [];

      // 通常DOM
      out.push(...Array.from(root.querySelectorAll('h1,h2,h3')));

      // shadow DOM 再帰
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          out.push(...collect(el.shadowRoot));
        }
      }
      return out;
    }

    const nodes = collect(document);

    return nodes
      .map(n => (n.innerText || '').trim())
      .filter(t => t.length > 0);
  }).catch(() => []);
  addResponsePayloadSpan('heading_extract', __timingHeadingExtractStart);
  logSf('AFTER_HEADING_EXTRACT', { count: Array.isArray(headingTexts) ? headingTexts.length : 0 });
  logSfMemory('after_heading_extract');

  console.log('[PW][HEADINGS_RAW]', {
    count: headingTexts ? headingTexts.length : null,
    sample: Array.isArray(headingTexts) ? headingTexts.slice(0, 5) : null
  });

  const __timingPrimaryHeadingExtractStart = Date.now();
  logSf('BEFORE_PRIMARY_HEADING');
  logSfMemory('before_primary_heading');
  const primaryHeadingText = await page.evaluate(() => {
    function textOf(el) {
      return String((el && (el.innerText || el.textContent)) || '').trim();
    }

    function collectHeadings(root) {
      const out = [];
      if (!root || !root.querySelectorAll) return out;

      out.push(...Array.from(root.querySelectorAll('h1,h2,h3')));

      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          out.push(...collectHeadings(el.shadowRoot));
        }
      }
      return out;
    }

    function pickHeading(root) {
      const nodes = collectHeadings(root)
        .map(el => ({
          tag: String((el.tagName || '')).toLowerCase(),
          text: textOf(el)
        }))
        .filter(x => x.text);

      const h1 = nodes.find(x => x.tag === 'h1');
      if (h1) return h1.text;

      const h2 = nodes.find(x => x.tag === 'h2');
      if (h2) return h2.text;

      const h3 = nodes.find(x => x.tag === 'h3');
      if (h3) return h3.text;

      return '';
    }

    const scopedRoots = [
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('article'),
      document.querySelector('#content'),
      document.querySelector('.content'),
      document.querySelector('.main'),
      document.querySelector('.page')
    ].filter(Boolean);

    for (const root of scopedRoots) {
      const t = pickHeading(root);
      if (t) return t;
    }

    return pickHeading(document);
  }).catch(() => '');
  addResponsePayloadSpan('primary_heading_extract', __timingPrimaryHeadingExtractStart);
  logSf('AFTER_PRIMARY_HEADING', { length: primaryHeadingText ? primaryHeadingText.length : 0 });
  logSfMemory('after_primary_heading');

  console.log('[PW][PRIMARY_HEADING]', {
    text: primaryHeadingText || '',
    length: primaryHeadingText ? primaryHeadingText.length : 0
  });

  async function getBodyTextCandidates(page) {
    await page.waitForFunction(() => {
      const roots = [
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('article'),
        document.querySelector('#content'),
        document.querySelector('.content'),
        document.querySelector('.main'),
        document.body
      ].filter(Boolean);

      function hasMeaningfulText(root) {
        if (!root || !root.querySelectorAll) return false;
        const nodes = root.querySelectorAll('p, h2, h3');
        for (const n of nodes) {
          const t = (n.innerText || '').trim();
          if (t && t.length >= 20) return true;
        }
        return false;
      }

      return roots.some(hasMeaningfulText);
    }, { timeout: 3000 }).catch(() => {});

    return await page.evaluate(() => {
      function textOf(el) {
        return String((el && (el.innerText || el.textContent)) || '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isValidText(t) {
        const s = String(t || '').trim();
        if (!s) return false;
        if (s.length < 20) return false;
        if (/^(お問い合わせ|アクセス|プライバシー|利用規約)$/i.test(s)) return false;
        return true;
      }

      function collectCandidates(root, out) {
        if (!root || !root.querySelectorAll) return;

        const nodes = root.querySelectorAll('p, h2, h3');
        for (const n of nodes) {
          const t = textOf(n);
          if (isValidText(t)) out.push(t);
        }

        const all = root.querySelectorAll('*');
        for (const el of all) {
          if (el.shadowRoot) {
            collectCandidates(el.shadowRoot, out);
          }
        }
      }

      const roots = [
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('article'),
        document.querySelector('#content'),
        document.querySelector('.content'),
        document.querySelector('.main'),
        document.body
      ].filter(Boolean);

      const out = [];
      for (const root of roots) {
        collectCandidates(root, out);
        if (out.length >= 5) break;
      }

      const uniq = [];
      const seen = Object.create(null);
      for (const t of out) {
        if (!seen[t]) {
          seen[t] = true;
          uniq.push(t);
        }
        if (uniq.length >= 5) break;
      }

      return uniq;
    });
  }

  async function getPrimaryMessageText(page) {
    await page.waitForFunction(() => {
      const roots = [
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('article'),
        document.querySelector('#content'),
        document.querySelector('.content'),
        document.querySelector('.main'),
        document.body
      ].filter(Boolean);

      function hasMeaningfulText(root) {
        if (!root || !root.querySelectorAll) return false;
        const nodes = root.querySelectorAll('p, h2, h3');
        for (const n of nodes) {
          const t = (n.innerText || '').trim();
          if (t && t.length >= 20) return true;
        }
        return false;
      }

      return roots.some(hasMeaningfulText);
    }, { timeout: 3000 }).catch(() => {});

    return await page.evaluate(() => {
      function textOf(el) {
        return String((el && (el.innerText || el.textContent)) || '')
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isValidText(t) {
        const s = String(t || '').trim();
        if (!s) return false;
        if (s.length < 20) return false;
        if (/^(お問い合わせ|アクセス|プライバシー|利用規約)$/i.test(s)) return false;
        return true;
      }

      function collectCandidates(root, out) {
        if (!root || !root.querySelectorAll) return;

        const nodes = root.querySelectorAll('p, h2, h3');
        for (const n of nodes) {
          const t = textOf(n);
          if (isValidText(t)) out.push(t);
        }

        const all = root.querySelectorAll('*');
        for (const el of all) {
          if (el.shadowRoot) {
            collectCandidates(el.shadowRoot, out);
          }
        }
      }

      const roots = [
        document.querySelector('main'),
        document.querySelector('[role="main"]'),
        document.querySelector('article'),
        document.querySelector('#content'),
        document.querySelector('.content'),
        document.querySelector('.main'),
        document.body
      ].filter(Boolean);

      for (const root of roots) {
        const out = [];
        collectCandidates(root, out);
        if (out.length) return out[0];
      }

      return null;
    });
  }

  const __timingBodyTextCandidatesExtractStart = Date.now();
  logSf('BEFORE_BODY_CANDIDATES');
  logSfMemory('before_body_candidates');
  const bodyTextCandidates = await getBodyTextCandidates(page).catch(() => []);
  addResponsePayloadSpan('body_text_candidates_extract', __timingBodyTextCandidatesExtractStart);
  logSf('AFTER_BODY_CANDIDATES', { count: Array.isArray(bodyTextCandidates) ? bodyTextCandidates.length : 0 });
  logSfMemory('after_body_candidates');
  const __timingPrimaryMessageExtractStart = Date.now();
  logSf('BEFORE_PRIMARY_MESSAGE');
  logSfMemory('before_primary_message');
  const primaryMessageText = await getPrimaryMessageText(page).catch(() => null);
  addResponsePayloadSpan('primary_message_extract', __timingPrimaryMessageExtractStart);
  logSf('AFTER_PRIMARY_MESSAGE', { length: primaryMessageText ? primaryMessageText.length : 0 });
  logSfMemory('after_primary_message');

  console.log('[PW][BODY_TEXT_CANDIDATES]', JSON.stringify({
    count: Array.isArray(bodyTextCandidates) ? bodyTextCandidates.length : 0,
    sample: Array.isArray(bodyTextCandidates) ? bodyTextCandidates.slice(0, 5) : []
  }));

  console.log('[PW][PRIMARY_MESSAGE]', {
    text: primaryMessageText || '',
    length: primaryMessageText ? primaryMessageText.length : 0
  });

  const existingAuditSig = (auditSig && typeof auditSig === 'object') ? auditSig : null;

  console.log('[PW][HEADINGS_TO_AUDITSIG]', {
    count: headingTexts ? headingTexts.length : null
  });

  console.log('[PW][PRIMARY_HEADING_TO_AUDITSIG]', {
    text: primaryHeadingText || '',
    length: primaryHeadingText ? primaryHeadingText.length : 0
  });

  console.log('[PW][PRIMARY_MESSAGE_TO_AUDITSIG]', {
    text: primaryMessageText || '',
    length: primaryMessageText ? primaryMessageText.length : 0
  });

  console.log('[PW][BODY_TEXT_CANDIDATES_TO_AUDITSIG]', JSON.stringify({
    count: Array.isArray(bodyTextCandidates) ? bodyTextCandidates.length : 0,
    sample: Array.isArray(bodyTextCandidates) ? bodyTextCandidates.slice(0, 5) : []
  }));

  logSf('BEFORE_GEO_SIGNALS');
  logSfMemory('before_geo_signals');
  const geoSignalsV1 = await buildGeoSignalsV1(page, urlToFetch, { siteMode });
  logSf('AFTER_GEO_SIGNALS', {
    hasGeoSignals: !!geoSignalsV1,
    error: geoSignalsV1 && geoSignalsV1.error ? true : false
  });
  logSfMemory('after_geo_signals');

  logSf('BEFORE_RESPONSE_PAYLOAD');
  logSfMemory('before_response_payload');
  const __timingResponseObjectAssemblyStart = Date.now();
  const responsePayload = {
    url: urlToFetch,
    geoSignalsV1,
    enrichedObservations,
    responseHeaders: (obs.http && obs.http.responseHeaders) ? obs.http.responseHeaders : {
      'strict-transport-security': null,
      'content-security-policy': null,
      'x-frame-options': null,
      'x-content-type-options': null,
      'referrer-policy': null,
      'permissions-policy': null
    },
    bodyText,
    html: payloadHtml,

    confirmed: {
      has_hsts: !!(obs.http && obs.http.ok && obs.http.hsts),
      has_xfo: !!(obs.http && obs.http.ok && obs.http.xfo),
      has_nosniff: !!(obs.http && obs.http.ok && obs.http.nosniff),
      has_csp: !!(obs.http && obs.http.ok && obs.http.csp),
      has_generic_anchor_text: !!(obs.dom && typeof obs.dom.genericAnchorCount === 'number' && obs.dom.genericAnchorCount > 0),
      generic_anchor_count: (obs.dom && typeof obs.dom.genericAnchorCount === 'number') ? obs.dom.genericAnchorCount : null,
      has_nav_element: !!(obs.dom && typeof obs.dom.navCount === 'number' && obs.dom.navCount > 0),
      nav_count: (obs.dom && typeof obs.dom.navCount === 'number') ? obs.dom.navCount : null,
      nav_has_list: (obs.dom && typeof obs.dom.navHasList === 'boolean') ? obs.dom.navHasList : null
    },

    // ★ 追加：レンダリング後のテキスト（deepText 優先）
    //   - GAS 側のナビ検出・嘘カードフィルタは、今後はこれを見る前提にする
    renderedText,
    headingTexts,
    bodyTextCandidates,

    jsonld,
    structured,
    jsonldSynth,
    scoring: { html: scoringHtml, bodyText: scoringBody, headingTexts },
    metaDescription,

    // ★ ADD: HTTPS 判定（GAS facts 用）
    isHttps: urlToFetch.startsWith('https://'),

    // ★ ADD: XML サイトマップ有無（GAS facts 用）
    hasSitemapXml,
    sitemapChecked: sitemapDiscovery.checked === true,
    sitemapExists: sitemapDiscovery.exists,
    sitemapXmlUrl: sitemapDiscovery.url,
    sitemapDiscoveryMethod: sitemapDiscovery.discoveryMethod,
    sitemapCheckedUrls: Array.isArray(sitemapDiscovery.checkedUrls) ? sitemapDiscovery.checkedUrls.slice(0, 10) : [],
    sitemapHttpStatus: sitemapDiscovery.httpStatus,

    // ★ Org / WebSite JSON-LD フラグ（GAS v2 facts 用）
    hasJsonLd: hasJsonLdFlag,
    hasOrgJsonLd: hasOrgJsonLdFlag,
    hasWebsiteJsonLd: hasWebsiteJsonLdFlag,
    ...(productSpecComparisonSignals ? { productSpecComparisonSignals } : {}),
    ...(multimodalSignals ? { multimodalSignals } : {}),

    // === HEAD / META 情報を GAS に直接渡すフラグ（v2 facts 用） ===
    // Playwright 側の auditSig をそのまま噛ませる
    hasTitle:           auditSig ? !!auditSig.hasTitle           : false,
    hasMetaDescription: auditSig ? !!auditSig.hasMetaDescription : (
      typeof metaDescription === 'string' && metaDescription.trim().length > 0
    ),
    metaDescriptionLen: auditSig && typeof auditSig.metaDescriptionLen === 'number'
      ? auditSig.metaDescriptionLen
      : (typeof metaDescription === 'string' ? metaDescription.length : 0),

    // ★ NEW: JSON-LD 種別フラグ（Organization / WebSite）を計算して auditSig ＋トップレベルに載せる
    ...(function () {
      const __timingJsonLdFlagsPatchStart = Date.now();
      try {
        if (!auditSig || typeof auditSig !== 'object') return {};

        // JSON-LD ノード集合（flags 用と同じく top+about 全体を優先）
        var nodes = [];
        if (Array.isArray(jsonldTopAboutAll) && jsonldTopAboutAll.length) {
          nodes = jsonldTopAboutAll.slice();
        } else {
          if (Array.isArray(jsonld)) nodes = nodes.concat(jsonld);
        }

        var hasOrg  = false;
        var hasSite = false;

        nodes.forEach(function (node) {
          if (!node || typeof node !== 'object') return;
          var t = node['@type'];
          var types = Array.isArray(t) ? t : (t ? [t] : []);

          types.forEach(function (tt) {
            if (typeof tt !== 'string') return;
            if (/Organization|Corporation|LocalBusiness/i.test(tt)) {
              hasOrg = true;
            }
            if (/WebSite/i.test(tt)) {
              hasSite = true;
            }
          });
        });

        // auditSig 自体にもフラグを書き込む（GAS 側では auditSig.hasOrgJsonLd で参照）
        auditSig.hasOrgJsonLd     = hasOrg;
        auditSig.hasWebsiteJsonLd = hasSite;

        // Node 環境なので console.log を使う
        try {
          console.log('[PW][JSONLD-FLAGS]', {
            hasOrgJsonLd: hasOrg,
            hasWebsiteJsonLd: hasSite,
            nodeCount: nodes.length
          });
        } catch (e) {}

        // トップレベル facts にもコピーして返す
        return {
          hasOrgJsonLd: hasOrg,
          hasWebsiteJsonLd: hasSite
        };
      } catch (e) {
        try {
          console.log('[PW][JSONLD-FLAGS][ERR]', String(e && e.stack || e));
        } catch (_) {}
        return {};
      } finally {
        addResponsePayloadSpan('jsonld_flags_patch', __timingJsonLdFlagsPatchStart);
      }
    })(),

    // ★ NEW: GAS 側に渡す auditSig オブジェクト（従来通り＋新フラグ付き）
    auditSig: {
      ...(existingAuditSig || {}),
      headingTexts,
      primaryHeadingText: primaryHeadingText,
      primaryMessageText: primaryMessageText,
      bodyTextCandidates: bodyTextCandidates,
      hasSitemapXml,
      sitemapChecked: sitemapDiscovery.checked === true,
      sitemapExists: sitemapDiscovery.exists,
      sitemapXmlUrl: sitemapDiscovery.url,
      sitemapDiscoveryMethod: sitemapDiscovery.discoveryMethod,
      sitemapCheckedUrls: Array.isArray(sitemapDiscovery.checkedUrls) ? sitemapDiscovery.checkedUrls.slice(0, 10) : [],
      sitemapHttpStatus: sitemapDiscovery.httpStatus,
      ...(productSpecComparisonSignals ? { productSpecComparisonSignals } : {}),
      ...(multimodalSignals ? { multimodalSignals } : {})
    },

    subPages_vNext: subPagesVNext,
    subpages: subPagesVNext,
    subpageDetails: subPagesVNext,
    pageDetails: subPagesVNext,
    publisherInfo,
    securityHeaders,

    // === ADD: Playwright→GAS I/F（トップレベルで返す・互換用） ===
    jsonld_detected_once: auditSig ? auditSig.jsonldDetected       : __probe.jsonld_detected_once,
    jsonld_detect_count:  auditSig ? auditSig.jsonldCount          : __probe.jsonld_detect_count,
    jsonld_wait_ms:       __probe.jsonld_wait_ms,
    jsonld_timed_out:     auditSig ? auditSig.jsonldTimedOut       : __probe.jsonld_timed_out,
    jsonld_sample_head:   auditSig ? auditSig.jsonldSampleHead     : __probe.jsonld_sample_head,

    // ★ 追加：同意クリックの試行結果（compareの原因切り分け用）
    consent_click_tried:     !!(__probe && __probe.consent_click_tried),
    consent_click_succeeded: !!(__probe && __probe.consent_click_succeeded),

    copyright_footer_present: auditSig ? auditSig.copyrightFooterPresent : __probe.copyright_footer_present,
    copyright_hit:           auditSig ? auditSig.copyrightHit           : __probe.copyright_hit,
    copyright_hit_token:     auditSig ? auditSig.copyrightHitToken      : __probe.copyright_hit_token,
    copyright_excerpt:       auditSig ? auditSig.copyrightExcerpt       : __probe.copyright_excerpt,

    debug: {
      build: BUILD_TAG,
      hydrated,
      innerTextLen: innerText.length,
      docTextLen: docText.length,
      jsUrls: jsUrls.slice(0, 10),
      tappedUrls: tappedUrls.slice(0, 40),
      tappedBodiesMeta: fetchedMeta.slice(0, 10),
      bundlePhones: phones.slice(0, 10),
      bundleZips: zips.slice(0, 10),
      bundleAddrs: addrs.slice(0, 10),
      pickedPhone: pickedPhone || null,
      pickedAddressPreview: pickedAddress
        ? [pickedAddress.postalCode, pickedAddress.addressRegion, pickedAddress.addressLocality, pickedAddress.streetAddress]
            .filter(Boolean).join(' ')
        : null,
      jsonldTopCount: Array.isArray(jsonldTopAll) ? jsonldTopAll.length : 0,
      jsonldAboutCount: Array.isArray(jsonldAboutAll) ? jsonldAboutAll.length : 0,
      jsonldPreferredCount: Array.isArray(jsonldPref) ? jsonldPref.length : 0,
      jsonldPreferredHint: (Array.isArray(jsonldPref) && jsonldPref.length) ? 'about>top' : 'top_only_or_none',
      hasGtmTop: !!gtmTop,
      hasGtmAbout: !!gtmAbout,
      normalizedUrl: normalizeUrl(urlToFetch),
      labelHitPhones: Array.from(new Set(labelHitPhones)).slice(0,10),
      foundingDatePicked: foundFoundingDate || null,
      foundingDateSource: foundFoundingDate ? (foundFoundingDateSource || 'dom/html') : null,
      sameAsCount: new Set(sameAsClean).size,
      elapsedMs,

      // === ADD: デバッグ用にプローブ結果も残す（任意）
      jsonldProbe: __probe,

      obs: { http: obs.http ? { ok:obs.http.ok, status:obs.http.status, hsts:obs.http.hsts, xfo:obs.http.xfo, nosniff:obs.http.nosniff, csp:obs.http.csp } : null, dom: obs.dom || null },
    }
  }; // ← ここで必ず閉じる！
  addResponsePayloadSpan('response_object_assembly', __timingResponseObjectAssemblyStart);
  try {
    scrapeTiming.payload_size_summary = {
      htmlLength: safeLength(responsePayload.html),
      bodyTextLength: safeLength(responsePayload.bodyText),
      renderedTextLength: safeLength(responsePayload.renderedText),
      scoringHtmlLength: safeLength(responsePayload.scoring && responsePayload.scoring.html),
      scoringBodyTextLength: safeLength(responsePayload.scoring && responsePayload.scoring.bodyText),
      enrichedObservationsCount: responsePayload.enrichedObservations && typeof responsePayload.enrichedObservations === 'object'
        ? Object.keys(responsePayload.enrichedObservations).length
        : 0,
      subpagesCount: safeArrayLength(responsePayload.subpages),
      subpageDetailsCount: safeArrayLength(responsePayload.subpageDetails),
      pageDetailsCount: safeArrayLength(responsePayload.pageDetails),
      jsonldCount: safeArrayLength(responsePayload.jsonld),
      headingTextsCount: safeArrayLength(responsePayload.headingTexts),
      bodyTextCandidatesCount: safeArrayLength(responsePayload.bodyTextCandidates)
    };
  } catch (_) {}

  console.log('[PW][PRODUCT_SPEC_SENTINEL]', JSON.stringify({
    phase: 'after_responsePayload',
    hasTopLevel: Object.prototype.hasOwnProperty.call(responsePayload, 'productSpecComparisonSignals'),
    hasAuditSigSignal: !!(responsePayload.auditSig && responsePayload.auditSig.productSpecComparisonSignals),
    topLevelType: typeof responsePayload.productSpecComparisonSignals,
    auditSigSignalType: typeof (responsePayload.auditSig && responsePayload.auditSig.productSpecComparisonSignals)
  }));

  // --- 追加: /scrape で採点も実施して返す ---
  const __timingBuildScoresStart = Date.now();
  logSf('BEFORE_DATA_BUILD');
  logSfMemory('before_data_build');
  const scoreBundle = buildScoresFromScrape(responsePayload); // 採点
  addResponsePayloadSpan('build_scores_from_scrape', __timingBuildScoresStart);
  logSf('AFTER_DATA_BUILD', { hasScoreBundle: !!scoreBundle });
  logSfMemory('after_data_build');
  const __timingOutputObjectAssemblyStart = Date.now();
  const out = { ...responsePayload, data: scoreBundle };      // data に採点結果を格納
  addResponsePayloadSpan('output_object_assembly', __timingOutputObjectAssemblyStart);
  addScrapeSpan('response_payload_build', __timingResponsePayloadStart);

  // --- CACHE SET（成功時のみ保存）
  try { if (!noCache) cacheSet(urlToFetch, out); } catch(_) {}

  out.debug = out.debug || {};
  if (noCache) out.debug.cache = { hit: false, nocache: true };

  // ★ COVNAV 最終スナップショット（必ず1回出る・検索しやすい）
  try{
    const covTop  = out && (out.coverageNav || out.coverageNavRaw);
    const covSig  = out && out.auditSig && out.auditSig.coverageNav;
    const covFact = out && out.facts && out.facts.auditSig && out.facts.auditSig.coverageNav;

    console.log('[COVNAV][SCRAPE][OUT v1]', {
      url: urlToFetch,
      has_cov_top:  !!covTop,
      has_cov_sig:  !!covSig,
      has_cov_fact: !!covFact,
      cov_top:  covTop || null,
      cov_sig:  covSig || null,
      cov_fact: covFact || null,
      auditSig_keys: out && out.auditSig ? Object.keys(out.auditSig).slice(0,40) : []
    });
  }catch(e){
    console.log('[COVNAV][SCRAPE][OUT v1][ERR]', String(e && (e.stack||e)));
  }

  console.log('[TEST][RESPONSE_PATH_HIT] bodyText debug marker');
  console.log('[TEST][RESPONSE_PAYLOAD_KEYS]', JSON.stringify({
    hasPayload: !!out,
    keys: out && typeof out === 'object' ? Object.keys(out).slice(0, 50) : []
  }));

  // 正常終了
  logSf('BEFORE_RESPONSE_SEND', {
    keysCount: out && typeof out === 'object' ? Object.keys(out).length : 0
  });
  logSfMemory('before_response_send');
  if (signalsOnly) {
    logSf('SIGNALS_ONLY_RESPONSE', {
      keysCount: out && typeof out === 'object' ? Object.keys(out).length : 0
    });
    logSfMemory('signals_only_response');
    return res.status(200).json({
      ok: true,
      mode: 'signalsOnly',
      url: urlToFetch,
      finalUrl: page && typeof page.url === 'function' ? page.url() : urlToFetch,
      status: resp && typeof resp.status === 'function' ? resp.status() : null,
      geoSignalsV1,
      debug: {
        keysCount: out && typeof out === 'object' ? Object.keys(out).length : 0,
        hasHtml: Boolean(out && out.html),
        htmlLength: String((out && out.html) || '').length,
        hasBodyText: Boolean(out && out.bodyText),
        bodyTextLength: String((out && out.bodyText) || '').length,
        hasRenderedText: Boolean(out && out.renderedText),
        renderedTextLength: String((out && out.renderedText) || '').length,
        hasAuditSig: Boolean(out && out.auditSig),
        hasData: Boolean(out && out.data)
      }
    });
  }
  return res.status(200).json(out);

  } catch (err) {
    logSf('SCRAPE_CATCH', {
      name: err && err.name ? String(err.name).slice(0, 80) : '',
      message: err && err.message ? String(err.message).slice(0, 240) : String(err).slice(0, 240)
    });
    logSfMemory('scrape_catch');
    const elapsedMs = Date.now() - t0;
    if ((signalsFirstLight || signalsFirstBalanced) && topPageStaticFetchResult && topPageStaticFetchResult.success && !res.headersSent) {
      const fallback = buildStaticFallbackGeoSignalsPayload_(urlToFetch, topPageStaticFetchResult, {
        playwrightTimedOut: /timeout/i.test(String(err && (err.message || err) || '')),
        playwrightFailed: true
      });
      fallback.geoSignalsV1.diagnostics.playwrightTimedOut = /timeout/i.test(String(err && (err.message || err) || ''));
      fallback.geoSignalsV1.diagnostics.playwrightFailed = true;
      const diagnostics = {
        responseMode: signalsFirstBalanced ? (balancedShortFastResponse ? 'shortFast' : (balancedShortResponse ? 'short' : 'signalsBalanced')) : 'signalsFirstLight',
        staticFallbackOnly: true,
        topPageStaticFetch: fallback.geoSignalsV1.diagnostics.topPageStaticFetch,
        playwrightTimedOut: fallback.geoSignalsV1.diagnostics.playwrightTimedOut,
        playwrightFailed: true,
        errorMessage: err && err.message ? String(err.message).slice(0, 240) : String(err).slice(0, 240),
        elapsedMs
      };
      fallback.geoSignalsV1.diagnostics.topPageStaticFetch.usedAsFallback = true;
      diagnostics.topPageStaticFetch.usedAsFallback = true;
      return res.status(200).json({
        ok: true,
        mode: signalsFirstBalanced ? 'signalsFirstBalancedStaticFallback' : 'signalsFirstLightStaticFallback',
        url: urlToFetch,
        finalUrl: topPageStaticFetchResult.finalUrl || urlToFetch,
        status: topPageStaticFetchResult.status,
        geoSignalsV1: fallback.geoSignalsV1,
        lightweightSummary: fallback.lightweightSummary,
        diagnostics,
        memoryHints: { staticFallbackOnly: true, avoidedHeavyBlocks: ['playwright_response_payload_after_failure'] }
      });
    }
    return res.status(500).json({
      error: 'scrape failed',
      details: err?.message || String(err),
      build: BUILD_TAG,
      elapsedMs
    });
  } finally {
    logSf('SCRAPE_FINALLY');
    logSfMemory('scrape_finally');
    try {
      console.log('[PW][SCRAPE_TIMING]', JSON.stringify({
        url: safeTimingUrl(),
        hydrated: hydratedForTiming,
        nocache: noCache,
        totalMs: Math.max(0, Date.now() - t0),
        spans: scrapeTiming.spans,
        responsePayloadSubspans: scrapeTiming.responsePayloadSubspans,
        payload_size_summary: scrapeTiming.payload_size_summary,
        subpagesVNextDecision: scrapeTiming.subpagesVNextDecision
      }));
    } catch (_) {}
    // 終了順：page → context → browser（全て握りつぶし）
    try { if (page)    await page.close(); } catch(_) {}
    try { if (context) await context.close(); } catch(_) {}
    try { if (browser) await browser.close(); } catch(_) {}
  }
}

// === /api/score route (ADD) ===
app.get('/api/score', async (req, res) => {
  const url = req.query.url;
  const force = req.query.force; // 'real' | 'dummy'
  if (!url) return res.status(400).json({ error: 'missing url' });

  const t0 = Date.now();
  let s = null;
  try {
    s = await scrapeForScoring(url); // ← ブロックBの関数
  } catch (e) {
    console.error('[scrapeForScoring] failed:', e);
    s = { fromScrape:false, hydrated:false, innerTextLen:0, fullHtmlLen:0, jsonld:[], waitStrategy:'(failed)', blockedResources:[], facts:{}, fallbackJsonld:{} };
  }

  // ダミー（5軸）
  const dummy = {
    overall: 65,
    axes5: {
      dataStructure: 68,
      expressionClarity: 62,
      coverage: 64,
      documentStructure: 60,
      trust: 66
    },
    weights5: WEIGHTS5,
    source: 'DUMMY_FIXTURE'
  };

  // 実スコア
  let real = null;
  if ((USE_REAL_SCORE || force === 'real') && force !== 'dummy') {
    try {
      real = await scoreWithGemini5axes({ url, scrape: s });
    } catch (e) {
      console.error('[scoreWithGemini5axes] failed:', e);
    }
  }

  const payload = {
    meta: {
      targetUrl: url,
      generatedAt: new Date().toISOString(),
      'j-from-scrape': !!s?.fromScrape,
      hydrated: !!s?.hydrated,
      innerTextLen: s?.innerTextLen || 0,
      fullHtmlLen: s?.fullHtmlLen || 0,
      jsonldCount: Array.isArray(s?.jsonld) ? s.jsonld.length : 0,
      elapsedMs: Date.now() - t0
    },
    scores: { real, dummy },
    before: { source: 'SCRAPE', facts: s?.facts || {} },
    after: { source: 'FALLBACK_BUILD', jsonld: s?.fallbackJsonld || {} },
    afterObj: { source: 'FALLBACK_BUILD', jsonld: s?.fallbackJsonld || {} },
    debug: { wait: s?.waitStrategy, blockedResources: s?.blockedResources, scorerModel: real ? 'gemini-1.5-pro' : 'dummy' }
  };

  if (!payload.auditSig) payload.auditSig = {};

  // === [AUDITSIG-MERGE v1] facts.auditSig を payload.auditSig に合流（coverageNav 以外も運ぶ） ===
  try{
    const srcAuditSig =
      s?.facts?.auditSig ||
      s?.facts?.auditSigV2 ||
      s?.auditSig ||
      null;

    if (srcAuditSig && typeof srcAuditSig === 'object'){
      // 既存payload.auditSigを優先しつつ、足りないキーだけ補完
      payload.auditSig = payload.auditSig || {};
      Object.keys(srcAuditSig).forEach(k=>{
        if (payload.auditSig[k] === undefined) payload.auditSig[k] = srcAuditSig[k];
      });
    }
  }catch(e){

    // srcAuditSig が取れなかった（または空）なら、フラット形式を auditSig に昇格
    try{
      const as = payload.auditSig || (payload.auditSig = {});
      const hasAny = Object.keys(as).length > 0;

      if (!hasAny){
        const keys = [
          // jsonld系
          'jsonldDetected','jsonldCount','jsonldTimedOut','jsonldWaitMs',
          'jsonldScanStarted','jsonldScanFinished','jsonldParseFailed','consentWallSuspected',
          'jsonldTypes','hasJsonLd','hasOrgJsonLd','hasWebsiteJsonLd','hasBreadcrumbJsonLd',
          // doc系
          'htmlLang','hasHtmlLang','hasTitle','hasMetaDescription','metaDescriptionLen','titleText',
          'h1Count','headerPresent','footerPresent','navCount','hasMainLandmark',
          // coverage/trust系
          'hasSitemapXml','coverageNav',
          'hasPrivacyPolicyLink','hasLegalLink','hasFooterNavForTrust',
          // 連絡先系（あるなら）
          'telephone','address','sameAsCount'
        ];

        keys.forEach(k=>{
          if (payload[k] !== undefined && as[k] === undefined) as[k] = payload[k];
        });
      }
    }catch(_){}

    console.log('[AUDITSIG-MERGE][ERR]', String(e && (e.stack || e)));
  }
  // === [AUDITSIG-MERGE v1] ここまで ===

  if (payload.auditSig.coverageNav == null) { // null/undefined のときだけ補完
    payload.auditSig.coverageNav =
      s?.auditSig?.coverageNav ||
      s?.facts?.auditSig?.coverageNav ||
      s?.facts?.coverageNav ||
      null;
  }

  try {
    const covNav =
      payload?.auditSig?.coverageNav ||
      payload?.before?.facts?.auditSig?.coverageNav ||
      payload?.before?.facts?.coverageNav ||
      s?.auditSig?.coverageNav ||
      s?.facts?.auditSig?.coverageNav ||
      null;

    console.log('[TRACE_COVNAV][NODE][payload-ready]', {
      url,
      hasAuditSig: !!(payload?.auditSig || payload?.before?.facts?.auditSig || s?.auditSig || s?.facts?.auditSig),
      hasCoverageNav: !!covNav,
      coverageNav: covNav
    });
  } catch (e) {
    console.log('[TRACE_COVNAV][NODE][payload-ready][ERR]', String(e && (e.stack || e)));
  }

  if (force === 'dummy') payload.scores.real = null;

  try{
    const srcAuditSig =
      s?.facts?.auditSig ||
      s?.facts?.auditSigV2 ||
      s?.auditSig ||
      null;

    const probe = {
      hasS: !!s,
      sKeys: s ? Object.keys(s).slice(0,30) : [],
      hasFacts: !!(s && s.facts),
      factsKeys: (s && s.facts) ? Object.keys(s.facts).slice(0,30) : [],
      hasSrcAuditSig: !!srcAuditSig,
      srcAuditSigKeys: srcAuditSig ? Object.keys(srcAuditSig).slice(0,60) : [],

      // 核心：siteFactsLite がどこに居るか
      hasSiteFactsLiteInSrc: !!(srcAuditSig && srcAuditSig.siteFactsLite),
      hasSiteFactsLiteInFacts: !!(s && s.facts && s.facts.auditSig && s.facts.auditSig.siteFactsLite),
      hasSiteFactsLiteInS: !!(s && s.auditSig && s.auditSig.siteFactsLite),

      // ついでに：payload側に入っているか（マージ後なら true になるはず）
      hasSiteFactsLiteInPayload: !!(payload && payload.auditSig && payload.auditSig.siteFactsLite),
      payloadAuditSigKeys: (payload && payload.auditSig) ? Object.keys(payload.auditSig).slice(0,60) : []
    };

    // ① Nodeログ（従来通り）
    console.log('[AUDITSIG-MERGE][PROBE]', probe);

    // ② レスポンスにも埋め込む（診断結果で見れるようにする）
    payload.debug = payload.debug || {};
    payload.debug.auditSigProbe = probe;

  }catch(e){
    console.log('[AUDITSIG-MERGE][PROBE][ERR]', String(e && (e.stack || e)));
    try{
      payload.debug = payload.debug || {};
      payload.debug.auditSigProbeErr = String(e && (e.stack || e));
    }catch(_){}
  }

  // ===== ADD: compare用に coverageNav / navCount をレスポンスへ載せる（siteFactsLite優先・既存キーは壊さない）=====
  try{
    const sfl =
      (srcAuditSig && srcAuditSig.siteFactsLite && typeof srcAuditSig.siteFactsLite === 'object') ? srcAuditSig.siteFactsLite :
      (payload && payload.auditSig && payload.auditSig.siteFactsLite && typeof payload.auditSig.siteFactsLite === 'object') ? payload.auditSig.siteFactsLite :
      null;

    // coverageNav は siteFactsLite から作る（payload側に無いのが今回の原因）
    if (payload.coverageNav == null && sfl && sfl.coverageNav && typeof sfl.coverageNav === 'object'){
      const c = sfl.coverageNav;
      payload.coverageNav = {
        hasCompanyNav: (typeof c.hasCompanyNav === 'boolean') ? c.hasCompanyNav : null,
        hasServiceNav: (typeof c.hasServiceNav === 'boolean') ? c.hasServiceNav : null,
        hasContactNav: (typeof c.hasContactNav === 'boolean') ? c.hasContactNav : null,
        hasFaqNav:     (typeof c.hasFaqNav     === 'boolean') ? c.hasFaqNav     : null,
        hasPricingNav: (typeof c.hasPricingNav === 'boolean') ? c.hasPricingNav : null,
        hasCasesNav:   (typeof c.hasCasesNav   === 'boolean') ? c.hasCasesNav   : null
      };
    }

    // navCount も siteFactsLite から（無ければ触らない）
    if (payload.navCount == null && sfl){
      const n =
        (typeof sfl.navCount === 'number' && Number.isFinite(sfl.navCount)) ? sfl.navCount :
        (typeof sfl.nav_count === 'number' && Number.isFinite(sfl.nav_count)) ? sfl.nav_count :
        null;

      if (n != null) payload.navCount = n;
    }

    console.log('[AUDITSIG][COVNAV][FINAL v2] navCount=%s cov=%s hasSFL=%s',
      String(payload.navCount),
      payload.coverageNav ? JSON.stringify(payload.coverageNav) : 'null',
      String(!!sfl)
    );
  }catch(e){
    console.log('[AUDITSIG][COVNAV][FINAL v2][ERR]', String(e && (e.stack || e)));
  }
  // ===== /ADD =====

  console.log('[TEST][BODYTEXT][RESPONSE_PAYLOAD]', JSON.stringify({
    hasBodyTextCandidates: Array.isArray(payload && payload.bodyTextCandidates),
    count: Array.isArray(payload && payload.bodyTextCandidates) ? payload.bodyTextCandidates.length : 0,
    sample: Array.isArray(payload && payload.bodyTextCandidates) ? payload.bodyTextCandidates.slice(0, 5) : [],
    responseKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 50) : []
  }));

  res.json(payload);
});

app.listen(PORT, () => {
  console.log('[BOOT][LISTENING]', JSON.stringify({
    build: BUILD_TAG,
    port: PORT,
    pid: process.pid,
    rss: process.memoryUsage().rss,
    ts: new Date().toISOString()
  }));
  console.log(`[${BUILD_TAG}] running on ${PORT}`);
});
