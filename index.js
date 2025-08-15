// index.js
const express = require('express');
const { chromium } = require('playwright'); // Docker: mcr.microsoft.com/playwright:* に同梱

const app = express();
const PORT = process.env.PORT || 8080;

// CORS（GAS 等から叩く場合に便利）
app.use((_, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ヘルスチェック
app.get('/', (_, res) => res.status(200).json({ ok: true }));

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) {
    return res.status(400).json({ error: 'URL parameter "url" is required.' });
  }

  let browser = null;
  const t0 = Date.now();

  try {
    // Playwright 起動
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      // SW をブロック → 必要に応じて 'allow' へ
      serviceWorkers: 'block',
      viewport: { width: 1366, height: 900 },
      javaScriptEnabled: true,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    });

    // ★以前の「画像/フォント/スタイルを abort」は外しています（CSS未読込で innerText が 0 になるのを防ぐ）

    const page = await context.newPage();

    // ネットワーク/コンソール/ページエラーを収集
    const netLog = { requestsFailed: [], responses: [], console: [], pageErrors: [] };

    page.on('requestfailed', req => {
      netLog.requestsFailed.push({
        url: req.url(),
        method: req.method(),
        failure: req.failure() ? req.failure().errorText : 'unknown'
      });
    });

    page.on('console', msg => {
      netLog.console.push({ type: msg.type(), text: msg.text() });
    });

    page.on('pageerror', err => {
      netLog.pageErrors.push({
        message: err.message,
        name: err.name,
        stack: (err.stack || '').slice(0, 5000)
      });
    });

    page.on('response', async (r) => {
      try {
        const url = r.url();
        const status = r.status();
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        let jsonSnippet = null;
        if (ct.includes('application/json')) {
          const txt = await r.text();
          if (txt && txt.length < 200_000) jsonSnippet = txt.slice(0, 5000);
        }
        netLog.responses.push({
          url, status, contentType: ct,
          jsonSnippetLen: jsonSnippet ? jsonSnippet.length : 0,
          jsonSnippet: jsonSnippet || null
        });
      } catch (_) {}
    });

    // ページ遷移（しっかり待つ）
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500); // ちょい追い

    // === 待機の統合版（ここだけでOK） ===
    // 1) body が非表示でない
    await page.waitForFunction(() => {
      const b = document.body;
      if (!b) return false;
      const s = window.getComputedStyle(b);
      const hidden = (s.visibility === 'hidden') || (s.display === 'none') || (parseFloat(s.opacity || '1') === 0);
      return !hidden;
    }, { timeout: 5000 }).catch(() => {});

    // 2) 可視テキストが一定量 or 代表要素が出る
    await page.waitForFunction(() => {
      const t = (document.body && document.body.innerText || '').replace(/\s+/g, '');
      const key = document.querySelector('main, #app, [id*="root"], [data-reactroot], [data-v-app], footer, address, a[href^="tel:"]');
      return (t.length > 200) || !!key;
    }, { timeout: 8000 }).catch(() => {});

    // JSON-LD（Organization/Corporation）抽出
    const jsonld = await page.evaluate(() => {
      const out = [];
      const nodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const s of nodes) {
        try {
          const j = JSON.parse(s.textContent.trim());
          const items = Array.isArray(j['@graph']) ? j['@graph'] : [j];
          for (const it of items) {
            const typ = it['@type'];
            const isOrg =
              typ === 'Organization' ||
              typ === 'Corporation' ||
              (Array.isArray(typ) && typ.some(t => t === 'Organization' || t === 'Corporation'));
            if (isOrg) {
              out.push({
                name: it.name ?? null,
                telephone: it.telephone ?? null,
                address: it.address ?? null,
                foundingDate: it.foundingDate ?? null,
                founder: it.founder ?? null,
                sameAs: it.sameAs ?? null,
                raw: it
              });
            }
          }
        } catch (_) {}
      }
      return out;
    });

    // Shadow DOM テキストの再帰抽出
    const shadowText = await page.evaluate(() => {
      function collectShadow(root, acc) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (el && el.shadowRoot) {
            const t = el.shadowRoot.innerText;
            if (t && t.trim()) acc.push(t.trim());
            collectShadow(el.shadowRoot, acc);
          }
        }
      }
      const out = [];
      collectShadow(document, out);
      return out.join('\n');
    });

    // iframe（同一オリジンのみアクセス）
    const framesInfo = await page.evaluate(() => {
      const arr = [];
      for (const f of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const doc = f.contentDocument;
          if (!doc) continue;
          const url = f.src || '';
          const txt = (doc.body?.innerText || '').trim();
          arr.push({
            url,
            textLen: txt.length,
            telLinksCount: doc.querySelectorAll('a[href^="tel:"]').length || 0
          });
        } catch (_) {
          // クロスオリジンはアクセス不可
        }
      }
      return arr;
    });

    // 本文テキスト（可視/非可視の両系統）
    const [title, fullHtml] = await Promise.all([page.title(), page.content()]);

    // 可視テキスト
    const innerText = await page.evaluate(() => document.body?.innerText || '');
    const docText   = await page.evaluate(() => document.documentElement?.innerText || '');
    // 非可視も含むテキスト
    const bodyAll   = await page.evaluate(() => document.body?.textContent || '');
    const docAll    = await page.evaluate(() => document.documentElement?.textContent || '');

    const combinedVisible = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();
    const combinedAll     = [bodyAll, docAll, shadowText].filter(Boolean).join('\n').trim();
    const combinedText    = combinedVisible.replace(/\s+/g, '').length >= 40 ? combinedVisible : combinedAll;

// ★ADD: body.innerHTML を拾って、必要ならテキスト化フォールバック
const bodyAll = await page.evaluate(() => document.body ? document.body.innerHTML : '');
function stripTags(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 「描画後テキスト」が空っぽなら、HTML→テキスト化で補う
const finalText = (combinedText && combinedText.trim().length > 0)
  ? combinedText
  : stripTags(bodyAll);

    // hydrated の判定（可視テキストが一定量あれば true）
    const hydrated = combinedVisible.replace(/\s+/g, '').length > 200;

    // 電話・住所・telリンク抽出
    const telLinks = await page.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href')));
    const extractedPhones = await page.evaluate(() => {
      const text = (document.body?.innerText || '');
      const m = text.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g);
      return m ? Array.from(new Set(m)) : [];
    });
    const extractedAddrs = await page.evaluate(() => {
      const text = (document.body?.innerText || '');
      const zips = text.match(/〒?\d{3}-?\d{4}/g) || [];
      const pref = /(北海道|東京都|京都府|大阪府|..県)/.exec(text)?.[1] || '';
      return { zips: Array.from(new Set(zips)), hasPref: !!pref };
    });

    const elapsedMs = Date.now() - t0;

    // 返却（res.json は Express の JSON レスポンスです）
    return res.status(200).json({
      url: urlToFetch,
      title,
      fullHtml,
// 変更
bodyText: finalText,

// 追加（debugオブジェクトの中に足す）
bodyAllLen: bodyAll.length,
      jsonld,
      debug: {
        hydrated,
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        bodyAllLen: bodyAll.length,   // 追加
        docAllLen: docAll.length,     // 追加
        fullHtmlLen: fullHtml.length,
        frames: framesInfo,
        telLinks,
        extractedPhones,
        extractedAddrs,
        jsonldCount: Array.isArray(jsonld) ? jsonld.length : 0,
        elapsedMs,
        netLog
      }
    });

  } catch (err) {
    const elapsedMs = Date.now() - t0;
    return res.status(500).json({
      error: 'An error occurred during scraping.',
      details: err?.message || String(err),
      elapsedMs
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});
