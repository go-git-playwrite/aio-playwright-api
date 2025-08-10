import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Playwright API is running!");
});

app.get("/scrape", async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  try {
    const browser = await chromium.launch({
      headless: true, // GUIなし
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // ページタイトルを取得
    const title = await page.title();

    // 例：h1タグのテキストをすべて取得
    const h1Texts = await page.$$eval("h1", els => els.map(e => e.innerText.trim()));

    await browser.close();

    res.json({
      url,
      title,
      h1: h1Texts
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});