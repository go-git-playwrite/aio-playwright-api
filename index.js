const express = require('express');
const { chromium } = require('playwright-chromium');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  let browser = null;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // 1) 読み込みをしっかり待つ（SPA対策）
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1500); // ちょい追い待ち

    // 2) 代表的なコンテナの出現 or 可視テキスト量で更に待つ（最大8秒）
    await page.waitForFunction(() => {
      const visText = (document.body.innerText || '').trim().length;
      const hasKeyEl = !!document.querySelector('main, #app, [id*="root"], address, [href^="tel:"], footer');
      return visText > 80 || hasKeyEl;
    }, { timeout: 8000 }).catch(() => {});

    // 3) テキスト取得を複数パスで（innerText / documentElement / Shadow DOM）
    const [title, fullHtml] = await Promise.all([
      page.title(),
      page.content()
    ]);

    const innerText = await page.evaluate(() => document.body?.innerText || '');
    const docText   = await page.evaluate(() => document.documentElement?.innerText || '');

    // Shadow DOM のテキストも拾う（ある場合のみ）
    const shadowText = await page.evaluate(() => {
      const out = [];
      const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        if (el.shadowRoot) {
          const t = el.shadowRoot.innerText;
          if (t && t.trim()) out.push(t.trim());
        }
      }
      return out.join('\n');
    });

    // telリンクと素朴な電話抽出（デバッグ用）
    const telLinks = await page.$$eval('a[href^="tel:"]', as => as.map(a => a.getAttribute('href')));
    const rawPhones = await page.evaluate(() => {
      const text = (document.body?.innerText || '');
      const m = text.match(/(?:\+81[-\s()]?)?0\d{1,4}[-\s()]?\d{1,4}[-\s()]?\d{3,4}/g);
      return m ? Array.from(new Set(m)) : [];
    });

    const combinedText = [innerText, docText, shadowText].filter(Boolean).join('\n').trim();

    res.status(200).json({
      url: urlToFetch,
      title,
      fullHtml,
      bodyText: combinedText,     // ← ここを見る
      debug: {
        innerTextLen: innerText.length,
        docTextLen: docText.length,
        shadowTextLen: shadowText.length,
        fullHtmlLen: fullHtml.length,
        telLinks,
        rawPhones
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred during scraping.', details: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});

// optional: ヘルスチェック
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});
