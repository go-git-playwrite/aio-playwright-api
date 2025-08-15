const express = require('express');
const { chromium } = require('playwright'); // ★ Docker ではこちらを使う

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;
  if (!urlToFetch) return res.status(400).json({ error: 'URL parameter "url" is required.' });

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      extraHTTPHeaders: { 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' }
    });

    // 軽ステルス
    await context.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
    });

    const page = await context.newPage();

    // 読み込み・待機強化
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);

    // 代表的な要素/テキスト量が出るまで粘る
    const candidateSelectors = [
      'main','#app','#__nuxt','#root','[data-v-app]','article','section','address','footer','a[href^="tel:"]'
    ];
    let hydrated = false;
    for (const sel of candidateSelectors) {
      try { await page.waitForSelector(sel, { state: 'attached', timeout: 2000 }); hydrated = true; break; } catch {}
    }
    async function visibleTextLen(){ return page.evaluate(() => (document.body?.innerText || '').trim().length); }
    for (let i=0;i<4;i++){
      const len = await visibleTextLen();
      if (len > 80) { hydrated = true; break; }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);
    }

    // 取得（複数経路）
    const [title, fullHtml] = await Promise.all([page.title(), page.content()]);
    let innerText = await page.evaluate(() => document.body?.innerText || '');
    let docText   = await page.evaluate(() => document.documentElement?.innerText || '');
    const shadowText = await page.evaluate(() => {
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
    });

    // innerText/docText が乏しい場合は主要コンテナを総なめ
    if ((innerText.trim().length + docText.trim().length) < 40) {
      const bigAreas = await page.evaluate(() => {
        const qs = ['main','article','section','footer','header','address','#app','#__nuxt','#root','[data-v-app]'];
        const pick = [];
        qs.forEach(sel => document.querySelectorAll(sel).forEach(el => {
          const t = el.innerText || '';
          if (t && t.trim().length >= 20) pick.push(t.trim());
        }));
        return pick.slice(0, 20).join('\n');
      });
      docText = (docText || '') + '\n' + bigAreas;
    }

    // デバッグ：telリンクと素朴抽出
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
      bodyText: combinedText,
      debug: {
        hydrated,
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