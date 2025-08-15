// index.js  (signature: v-aug15-fs2)
const express = require('express');
const { chromium } = require('playwright'); // Docker: mcr.microsoft.com/playwright:* ベース
const app = express();
const PORT = process.env.PORT || 8080;

app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ヘルスチェック / 実行中コードの確認
app.get('/', (_, res) => res.status(200).json({ ok: true, signature: 'v-aug15-fs2' }));

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  let browser = null;
  const t0 = Date.now();

  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // 何もブロックしない（CSS/フォント未読込で innerText が空になるのを防ぐ）
    // await context.route('**/*', ...) は使わない

    const page = await context.newPage();

    // ネットワーク・コンソール収集
    const netLog = { requestsFailed: [], responses: [], console: [], pageErrors: [] };
    page.on('requestfailed', req => netLog.requestsFailed.push({
      url: req.url(), method: req.method(), failure: req.failure()?.errorText || 'unknown'
    }));
    page.on('console', msg => netLog.console.push({ type: msg.type(), text: msg.text() }));
    page.on('pageerror', err => netLog.pageErrors.push({ message: err.message, name: err.name }));

    page.on('response', async (r) => {
      try {
        const url = r.url();
        const status = r.status();
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        let jsonSnippet = null;
        if (ct.includes('application/json')) {
          const txt = await r.text();
          if (txt && txt.length < 200_000) jsonSnippet = txt.slice(0, 10_000); // 10KB
        }
        netLog.responses.push({
          url, status, contentType: ct,
          jsonSnippetLen: jsonSnippet ? jsonSnippet.length : 0,
          jsonSnippet
        });
      } catch (_) {}
    });

    // ナビゲーション（少し軽め）
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(10_000);
    await page.goto(urlToFetch, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(()=>{});
    // 初期のリクエストが落ち着くまで
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
    // 遅延ロード用に少し待機（Firestore 取得を待つ）
    await page.waitForTimeout(2000);

    // noscript 非表示 or SPA 要素表示を短めに待つ
    let noscriptHidden = false, appVisible = false;
    try { await page.waitForSelector('noscript, p.warning', { state: 'hidden', timeout: 3000 }); noscriptHidden = true; } catch(_){}
    try {
      await page.waitForSelector('main, #app, #__next, #__nuxt, [data-v-app], [data-reactroot]', { state: 'visible', timeout: 5000 });
      appVisible = true;
    } catch(_) {
      appVisible = await page.evaluate(() => ((document.body?.innerText || '').replace(/\s+/g,'').length > 200)).catch(()=>false);
    }

    // 本文テキスト（可視）
    const [title, fullHtml = ''] = await Promise.all([
      page.title().catch(()=> ''), page.content().catch(()=> '')
    ]);
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
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    let finalText = (combinedVisible.replace(/\s+/g,'').length >= 40) ? combinedVisible : stripTags(bodyInnerHTML);

    // ===== Firestore / JSON レスポンスから抽出 =====
    const jsonBodies = [];
    for (const r of netLog.responses) {
      const u = (r.url || '').toLowerCase();
      const ct = (r.contentType || '').toLowerCase();
      const looksFirestore = u.includes('firestore') || u.includes('googleapis') || u.endsWith('.json');
      if (r.jsonSnippet && (ct.includes('application/json') || looksFirestore)) {
        jsonBodies.push(`URL: ${r.url}\n${r.jsonSnippet}`);
      }
    }
    const firestoreDump = jsonBodies.join('\n\n');

    // ざっくり抽出
    const uniq = a => Array.from(new Set(a));
    const fsPhones = uniq((firestoreDump.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g) || []));
    const fsZips   = uniq((firestoreDump.match(/〒?\d{3}-?\d{4}/g) || []));
    const fsPrefs  = uniq((firestoreDump.match(/北海道|東京都|京都府|大阪府|..県/g) || []));

    // DOM が薄い場合は JSON 由来の情報を bodyText に補う
    if (finalText.length < 60 && firestoreDump.length > 0) {
      finalText = [
        finalText,
        fsPhones.length ? ('TEL: ' + fsPhones.slice(0,3).join(', ')) : '',
        fsZips.length   ? ('ZIP: ' + fsZips.slice(0,3).join(', '))   : '',
        fsPrefs.length  ? ('PREF: ' + fsPrefs.slice(0,3).join(', ')) : ''
      ].filter(Boolean).join('\n');
    }

    const hydrated = combinedVisible.replace(/\s+/g,'').length > 200;
    const elapsedMs = Date.now() - t0;

    // 返却
    res.status(200).json({
      url: urlToFetch,
      signature: 'v-aug15-fs2',
      title,
      fullHtml,
      bodyText: finalText,
      jsonld: [], // 必要に応じて復活
      debug: {
        hydrated,
        noscriptHidden,
        appVisible,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen: fullHtml.length,
        bodyAllLen: bodyInnerHTML.length,
        firestoreTextLen: firestoreDump.length,
        firestorePhones: fsPhones.slice(0,5),
        firestoreZips: fsZips.slice(0,5),
        firestorePrefs: fsPrefs.slice(0,5),
        netLog: {
          failedCount: netLog.requestsFailed.length,
          responseCount: netLog.responses.length,
          sampleJsonUrls: netLog.responses.filter(r => r.jsonSnippetLen > 0).slice(0,3).map(r => r.url)
        },
        elapsedMs
      }
    });

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      error: 'An error occurred during scraping.',
      details: err?.message || String(err),
      elapsedMs,
      signature: 'v-aug15-fs2'
    });
  } finally {
    if (browser) { try { await browser.close(); } catch(_){} }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});
