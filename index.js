// index.js
const express = require('express');
const { chromium } = require('playwright'); // Docker: mcr.microsoft.com/playwright:* ベース
const app = express();
const PORT = process.env.PORT || 8080;

app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
app.get('/', (_, res) => res.status(200).json({ ok: true }));

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // 画像/フォント/メディアはブロック（CSSは通す）
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'media') return route.abort();
      route.continue();
    });

    const page = await context.newPage();
    const netLog = { requestsFailed: [], responses: [], console: [], pageErrors: [] };

    page.on('requestfailed', req => {
      netLog.requestsFailed.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText || 'unknown' });
    });
    page.on('console', msg => { netLog.console.push({ type: msg.type(), text: msg.text() }); });
    page.on('pageerror', err => { netLog.pageErrors.push({ message: err.message, name: err.name }); });
    page.on('response', async (r) => {
      try {
        const url = r.url();
        const status = r.status();
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        let jsonSnippet = null;
        if (ct.includes('application/json')) {
          const txt = await r.text();
          if (txt && txt.length < 200_000) jsonSnippet = txt.slice(0, 10_000); // 10KB まで
        }
        netLog.responses.push({
          url, status, contentType: ct,
          jsonSnippetLen: jsonSnippet ? jsonSnippet.length : 0,
          jsonSnippet: jsonSnippet || null
        });
      } catch (_) {}
    });

    // タイムアウト控えめ（502 回避）
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(8_000);

    // ナビゲーション + 軽待機
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(()=>{});
    await page.waitForLoadState('networkidle', { timeout: 7_000 }).catch(()=>{});
    await page.waitForTimeout(800).catch(()=>{});

    // noscript 非表示 / SPA コンテナ表示を短めに待つ
    let noscriptHidden = false, appVisible = false;
    try { await page.waitForSelector('noscript, p.warning', { state: 'hidden', timeout: 3000 }); noscriptHidden = true; } catch(_){}
    try {
      await page.waitForSelector('main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]', { state: 'visible', timeout: 5000 });
      appVisible = true;
    } catch(_) {
      appVisible = await page.evaluate(() => ((document.body?.innerText || '').replace(/\s+/g,'').length > 200)).catch(()=>false);
    }

    // 本文（可視/非可視）
    const [title, fullHtml = ''] = await Promise.all([page.title().catch(()=>''), page.content().catch(()=> '')]);
    const [innerText = '', docText = ''] = await Promise.all([
      page.evaluate(() => document.body?.innerText || '').catch(()=> ''),
      page.evaluate(() => document.documentElement?.innerText || '').catch(()=> '')
    ]);
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
      } catch(_) { return ''; }
    }).catch(()=>'');

    const bodyInnerHTML = await page.evaluate(() => document.body ? document.body.innerHTML : '').catch(()=> '');
    const combinedVisible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();

    // タグ除去フォールバック
    function stripTags(html) {
      if (!html) return '';
      return html.replace(/<script[\s\S]*?<\/script>/gi, '')
                 .replace(/<style[\s\S]*?<\/style>/gi, '')
                 .replace(/<[^>]+>/g, ' ')
                 .replace(/\s+/g, ' ')
                 .trim();
    }
    let finalText = (combinedVisible.replace(/\s+/g,'').length >= 40) ? combinedVisible : stripTags(bodyInnerHTML);

    // ===== Firestore / JSON レスポンスからの抽出（新規） =====
    const jsonBodies = [];
    for (const r of netLog.responses) {
      const u = (r.url || '').toLowerCase();
      const ct = (r.contentType || '').toLowerCase();
      const looksFirestore = u.includes('firestore') || u.includes('googleapis') || u.endsWith('.json');
      if (r.jsonSnippet && (ct.includes('application/json') || looksFirestore)) {
        jsonBodies.push(r.jsonSnippet);
      }
    }
    const firestoreDump = jsonBodies.join('\n\n');

    // ざっくり抽出（日本の電話・郵便・都道府県）
    function uniq(a){ return Array.from(new Set(a)); }
    const fsPhones = uniq((firestoreDump.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g) || []));
    const fsZips   = uniq((firestoreDump.match(/〒?\d{3}-?\d{4}/g) || []));
    const fsPrefs  = uniq((firestoreDump.match(/北海道|東京都|京都府|大阪府|..県/g) || []));

    // DOMテキストが薄い時は、Firestore 側テキストを bodyText の最後の保険に使う
    if (finalText.length < 60 && firestoreDump.length > 0) {
      finalText = [
        finalText,
        fsPhones.length ? ('TEL: ' + fsPhones.slice(0,3).join(', ')) : '',
        fsZips.length   ? ('ZIP: ' + fsZips.slice(0,3).join(', '))   : '',
        fsPrefs.length  ? ('PREF: ' + fsPrefs.slice(0,3).join(', ')) : ''
      ].filter(Boolean).join('\n');
    }

    const elapsedMs = Date.now() - t0;
    const hydrated = combinedVisible.replace(/\s+/g,'').length > 200;

    // 返却
    res.status(200).json({
      url: urlToFetch,
      title,
      fullHtml,
      bodyText: finalText, // ← DOMが空でも Firestore 由来で情報を出す
      jsonld: [],          // 必要になったら元の JSON-LD 抽出を復活
      debug: {
        hydrated,
        noscriptHidden,
        appVisible,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen: fullHtml.length,
        bodyAllLen: bodyInnerHTML.length,
        // Firestore / JSON の抽出状況
        firestoreTextLen: firestoreDump.length,
        firestorePhones: fsPhones.slice(0,5),
        firestoreZips: fsZips.slice(0,5),
        firestorePrefs: fsPrefs.slice(0,5),
        // ネットワーク要約（重くならないように先頭だけ）
        netLog: {
          failedCount: netLog.requestsFailed.length,
          responseCount: netLog.responses.length,
          sampleJsonUrls: netLog.responses
            .filter(r => r.jsonSnippetLen > 0)
            .slice(0, 3)
            .map(r => r.url)
        },
        elapsedMs
      }
    });

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({ error: 'An error occurred during scraping.', details: err?.message || String(err), elapsedMs });
  } finally {
    if (browser) { try { await browser.close(); } catch(_){} }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});
