const express = require('express');
const { chromium } = require('playwright-chromium');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send('URL parameter is required.');
  }

  let browser = null;
  try {
    // Cloud Run環境でPlaywrightを動かすための必須オプション
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // タイムアウトを60秒に延長
    const html = await page.content();
    
    res.status(200).send(html);

  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching the page.');
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));