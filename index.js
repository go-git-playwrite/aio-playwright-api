// index.js
const express = require('express');
const { chromium } = require('playwright');
const app = express();

const BUILD_TAG = 'scrape-v5-antiBot-poll';
const PORT = process.env.PORT || 8080;

app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.get('/', (_, res) => res.status(200).json({ ok: true }));
app.get('/__version', (_, res) => res.status(200).json({ ok: true, build: BUILD_TAG, now: new Date().toISOString() }));

// 文字列ユーティリティ
const stripTags = (html) => (html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ ok:false, error:'URL parameter "url" is required.' });

  const t0 = Date.now();
  let browser = null;
  const debug = {
    build: BUILD_TAG,
    url: urlToFetch,
    nav: {},
    ua: null,
    webdriver: null,
    lang: null,
    swState: 'unknown',
    readyState: null,
    noscriptGone: null,
    appVisible: null,
    textPoll: [],
    innerTextLen: 0,
    docTextLen: 0,
    shadowTextLen: 0,
    bodyHTMLLen: 0,
    fullHtmlLen: 0,
    scriptsCount: 0,
    console: [],
    pageErrors: [],
    requestsFailed: [],
    jsonResponsesSeen: 0
  };

  try {
    browser = await chromium.launch({
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled'],
      headless: true
    });
    const context = await browser.newContext({
      // “本物っぽい”環境
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      // ← 重要：PWA系で SW が必要なケースがあるので allow に
      serviceWorkers: 'allow',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // いくつかの fingerprint を “それっぽく”
    await context.addInitScript(() => {
      try {
        // webdriver 無効化
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // chrome オブジェクト
        window.chrome = window.chrome || { runtime: {} };
        // 言語
        Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP','ja','en-US','en'] });
        // プラグイン
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
      } catch(_) {}
    });

    const page = await context.newPage();

    // ログ収集
    page.on('console', (msg) => debug.console.push({ type: msg.type(), text: msg.text() }));
    page.on('pageerror', (err) => debug.pageErrors.push({ message: err.message, stack: String(err.stack||'').slice(0,3000) }));
    page.on('requestfailed', (req) => debug.requestsFailed.push({ url: req.url(), error: req.failure()?.errorText || 'unknown' }));
    page.on('response', async (r) => {
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) debug.jsonResponsesSeen++;
    });

    // ナビゲーション
    page.setDefaultNavigationTimeout(45_000);
    page.setDefaultTimeout(12_000);

    const navStart = Date.now();
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 45_000 });
    debug.nav.gotoMs = Date.now() - navStart;

    // クライアント側の環境値を取得
    const env = await page.evaluate(() => ({
      ua: navigator.userAgent,
      webdriver: navigator.webdriver === undefined ? null : navigator.webdriver,
      lang: navigator.language,
      sw: (('serviceWorker' in navigator) ? 'available' : 'unavailable'),
      ready: document.readyState
    }));
    debug.ua = env.ua; debug.webdriver = env.webdriver; debug.lang = env.lang;
    debug.swState = env.sw; debug.readyState = env.ready;

    // noscript（or .warning）消失待ち（最大10秒）
    try {
      await page.waitForSelector('noscript, p.warning', { state: 'hidden', timeout: 10_000 });
      debug.noscriptGone = true;
    } catch {
      debug.noscriptGone = false;
    }

    // SPAコンテナが“見える”か（最大12秒）
    try {
      await page.waitForSelector('main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]', { state: 'visible', timeout: 12_000 });
      debug.appVisible = true;
    } catch {
      debug.appVisible = false;
    }

    // 追加で “毎秒ポーリングでテキスト量” を 20秒 監視
    for (let i=0;i<20;i++){
      const len = await page.evaluate(() => ((document.body?.innerText || '').replace(/\s+/g,'').length));
      debug.textPoll.push(len);
      if (len > 400) break; // 十分テキストが出たら切り上げ
      await page.waitForTimeout(1000);
    }

    // 各種テキスト取得
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

    const [title, fullHtml] = await Promise.all([
      page.title().catch(()=> ''),
      page.content().catch(()=> '')
    ]);
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

    // scriptタグ個数（JSが読めてるかの目安）
    debug.scriptsCount = await page.evaluate(() => document.querySelectorAll('script').length).catch(()=>0);

    // 最終テキスト決定
    const visible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();
    let finalText = (visible.replace(/\s+/g,'').length >= 80)
      ? visible
      : stripTags(bodyHTML);

    // hydrated 判定（可視テキスト量 or appVisible）
    const hydrated = (visible.replace(/\s+/g,'').length > 300) || debug.appVisible === true;

    const elapsedMs = Date.now() - t0;
    return res.status(200).json({
      ok: true,
      build: BUILD_TAG,
      url: urlToFetch,
      title,
      bodyText: finalText,         // ← ここを見る
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
