const express = require('express');
const { chromium } = require('playwright-chromium');

const app = express();
const PORT = process.env.PORT || 8080; // Renderが提供するポートを使用

// JSON形式のリクエストボディを解析するためのミドルウェア
app.use(express.json());

app.get('/scrape', async (req, res) => {
  const urlToFetch = req.query.url;

  if (!urlToFetch) {
    return res.status(400).json({ error: 'URL parameter "url" is required.' });
  }

  console.log(`Scraping request received for: ${urlToFetch}`);
  let browser = null;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      // 一般的なブラウザのユーザーエージェントを設定
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    const page = await context.newPage();

    // ページ遷移のタイムアウトを90秒に延長
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90000 });

    // 1. ページのタイトルを取得
    const title = await page.title();

    // 2. JavaScript描画後のHTML全文を取得
    const fullHtml = await page.content();
    
    // 3. JavaScript描画後の表示テキスト全文を取得
    const bodyText = await page.evaluate(() => document.body.innerText);

    // 4. 取得した情報をまとめてJSONとして返却
    const responseData = {
      url: urlToFetch,
      title: title,
      fullHtml: fullHtml,
      bodyText: bodyText
    };

    console.log(`Successfully scraped: ${urlToFetch}`);
    res.status(200).json(responseData);

  } catch (error) {
    console.error(`Error scraping ${urlToFetch}:`, error);
    res.status(500).json({ error: 'An error occurred during scraping.', details: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Playwright API server is running on port ${PORT}`);
});

