const express = require('express');
const { chromium } = require('playwright-chromium');

const app = express();
const PORT = process.env.PORT || 8080;

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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto(urlToFetch, { waitUntil: 'networkidle', timeout: 90000 });

    const title = await page.title();
    const fullHtml = await page.content();
    const bodyText = await page.evaluate(() => document.body.innerText);

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
