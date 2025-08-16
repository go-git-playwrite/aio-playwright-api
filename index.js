// index.js
const express = require('express');
const { chromium } = require('playwright');

const app = express();
const BUILD_TAG = 'scrape-v7-wait-js-or-firestore';
const PORT = process.env.PORT || 8080;

app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.get('/',  (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// 小ユーティリティ
const stripTags = (html) => (html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ ok:false, error:'URL parameter "url" is required.' });

  let browser = null;
  const t0 = Date.now();
  const debug = {
    build: BUILD_TAG,
    url: urlToFetch,
    ua: null,
    headers: null,
    jsUrls: [],
    cssUrls: [],
    jsonUrls: [],
    scriptsCount: 0,
    textPoll: [],
    innerTextLen: 0,
    docTextLen: 0,
    shadowTextLen: 0,
    bodyHTMLLen: 0,
    fullHtmlLen: 0,
    noscriptGone: null,
    appVisible: null,
    retriedLoadMainJs: false,
    console: [],
    pageErrors: [],
    requestsFailed: [],
    jsonResponsesSeen: 0,
    screenshotLen: 0,
    // 追加: JS/Firestore 待機の実施状況
    jsOrFirestoreSeen: { js:false, firestore:false },
    waitJsOrFirestoreResolved: false
  };

  try {
    browser = await chromium.launch({
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'],
      headless: true
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/125.0.0.0 Safari/537.36',
      // SW は allow（PWA で必要な場合があるため）
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // 実ブラウザ寄りのヘッダ
    await context.setExtraHTTPHeaders({
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    });

    // 指紋ステルス
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
        Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP','ja','en-US','en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
      } catch(_) {}
    });

    const page = await context.newPage();

    // ネットワーク観測
    page.on('console', (msg) => debug.console.push({ type: msg.type(), text: msg.text() }));
    page.on('pageerror', (err) => debug.pageErrors.push({ message: err.message, stack: String(err.stack||'').slice(0,2000) }));
    page.on('requestfailed', (req) => debug.requestsFailed.push({ url: req.url(), error: req.failure()?.errorText || 'unknown' }));
    page.on('response', async (r) => {
      const url = r.url();
      const ct  = (r.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('application/javascript') || url.endsWith('.js')) {
        debug.jsUrls.push(url);
        debug.jsOrFirestoreSeen.js = true;
      }
      if (ct.includes('text/css') || url.endsWith('.css')) debug.cssUrls.push(url);
      if (ct.includes('application/json') || url.endsWith('.json')) {
        debug.jsonUrls.push(url);
        debug.jsonResponsesSeen++;
        if (url.includes('firestore.googleapis.com')) debug.jsOrFirestoreSeen.firestore = true;
      }
    });

    // Sec-Fetch* などを補う
    await context.route('**/*', (route) => {
      const req = route.request();
      const headers = {
        ...req.headers(),
        'referer': urlToFetch,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-user': '?1',
        'sec-fetch-dest': 'document'
      };
      route.continue({ headers });
    });

    page.setDefaultNavigationTimeout(45_000);
    page.setDefaultTimeout(12_000);

    // 1) DOMContentLoaded まで
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // 2) 「.js か Firestore レスポンス」が来るまで待機（最大 30s）
    try {
      await page.waitForResponse((response) => {
        const u = response.url();
        return u.endsWith('.js') || u.includes('firestore.googleapis.com');
      }, { timeout: 30_000 });
      debug.waitJsOrFirestoreResolved = true;
    } catch {
      debug.waitJsOrFirestoreResolved = false;
    }

    // 3) その後に networkidle も待つ（落ち着くまで）
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(()=>{});
    await page.waitForTimeout(1000).catch(()=>{}); // 追い 1 秒

    // noscript/p.warning が消えるか
    try { await page.waitForSelector('noscript, p.warning', { state: 'hidden', timeout: 10_000 }); debug.noscriptGone = true; }
    catch { debug.noscriptGone = false; }

    // SPAコンテナが出るか
    try { await page.waitForSelector('main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]', { state: 'visible', timeout: 12_000 }); debug.appVisible = true; }
    catch { debug.appVisible = false; }

    // 可視テキスト量を 20 秒ポーリング（増えたら打ち切り）
    for (let i=0;i<20;i++){
      const len = await page.evaluate(() => ((document.body?.innerText || '').replace(/\s+/g,'').length)).catch(()=>0);
      debug.textPoll.push(len);
      if (len > 400) break;
      await page.waitForTimeout(1000);
    }

    // JS/Firestore が見えていない & テキストが増えない → HTML から script を推定して手動ロード
    const likelyEmpty = debug.textPoll.every(v => v === 0);
    if (likelyEmpty && debug.jsUrls.length <= 2) {
      debug.retriedLoadMainJs = true;
      const hints = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('script[src]').forEach(s => out.push(s.getAttribute('src')));
        document.querySelectorAll('link[rel="modulepreload"][href$=".js"]').forEach(l => out.push(l.getAttribute('href')));
        return out;
      }).catch(()=>[]);
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
      for (const u of (hints || []).map(abs).filter(Boolean)) {
        try {
          await page.addScriptTag({ url: u, type: u.endsWith('.mjs') ? 'module' : undefined });
          await page.waitForTimeout(2000);
          const len = await page.evaluate(() => ((document.body?.innerText || '').replace(/\s+/g,'').length)).catch(()=>0);
          debug.textPoll.push(len);
          if (len > 400) break;
        } catch {}
      }
    }

    // スクリプト個数
    debug.scriptsCount = await page.evaluate(() => document.querySelectorAll('script').length).catch(()=>0);

    // Shadow DOM テキスト
    const shadowText = await page.evaluate(() => {
      try {
        const out = [];
        const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el && el.shadowRoot) {
            const t = el.shadowRoot.innerText;
            if (t && t.trim()) out.push(t.trim());
          }
        }
        return out.join('\n');
      } catch { return ''; }
    });

    // 本文・HTML
    const [title, fullHtml] = await Promise.all([page.title().catch(()=>''), page.content().catch(()=> '')]);
    debug.fullHtmlLen = (fullHtml || '').length;

    const [innerText, docText, bodyHTML] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.body ? document.body.innerHTML : '').catch(()=> '')
    ]);
    debug.innerTextLen = innerText.length;
    debug.docTextLen   = docText.length;
    debug.shadowTextLen= shadowText.length;
    debug.bodyHTMLLen  = bodyHTML.length;

    // スクショ
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: true });
      debug.screenshotLen = Buffer.byteLength(buf);
    } catch {}

    // 最終テキスト
    const visible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();
    let bodyText = (visible.replace(/\s+/g,'').length >= 80) ? visible : stripTags(bodyHTML);

    const hydrated = (visible.replace(/\s+/g,'').length > 300) || debug.appVisible === true;

    const elapsedMs = Date.now() - t0;
    return res.status(200).json({
      ok: true,
      build: BUILD_TAG,
      url: urlToFetch,
      title,
      bodyText,
      debug: { ...debug, hydrated, elapsedMs }
    });

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      ok: false,
      build: BUILD_TAG,
      error: err?.message || String(err),
      debug: { ...debug, elapsedMs }
    });
  } finally {
    if (browser) { try { await browser.close(); } catch(_){} }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT} (${BUILD_TAG})`);
});
