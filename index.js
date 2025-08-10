const express = require('express');
const { chromium } = require('playwright-chromium');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send({ error: 'URL parameter is required.' });
  }

  let browser = null;
  try {
    console.log(`Fetching URL: ${url}`);
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();

    // ★★★ タイムアウトを90秒に延長し、読み込み完了の判断を、より速い基準に変更 ★★★
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    
    const html = await page.content();
    console.log(`Successfully fetched content from ${url}`);
    res.status(200).send(html);

  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    // ★★★ エラー時に、より詳細な情報を返すように修正 ★★★
    res.status(500).send({ error: 'An error occurred while fetching the page.', details: error.message });
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed.');
    }
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
