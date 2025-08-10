import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

// 5. グローバル例外捕捉 (uncaughtException, unhandledRejection)
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

app.get("/scrape", async (req, res) => {
  console.log("=== /scrape accessed ===");
  console.log("Incoming /scrape request, query:", req.query);

  const url = req.query.url;
  if (!url) {
    console.error("URL parameter missing");
    return res.status(400).json({ error: "URL parameter is required" });
  }

  try {
    // 4. 主要処理の前後にログを入れて状況を把握
    console.log("Launching browser for URL:", url);
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    console.log("Browser launched");

    const page = await browser.newPage();
    console.log("New page created");

    console.log("Navigating to URL:", url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    console.log("Page navigation completed");

    const title = await page.title();
    console.log("Page title retrieved:", title);

    const h1Texts = await page.$$eval("h1", els => els.map(e => e.innerText.trim()));
    console.log("H1 tags extracted:", h1Texts);

    await browser.close();
    console.log("Browser closed");

    res.json({
      url,
      title,
      h1: h1Texts
    });
  } catch (error) {
    console.error("Error during scraping:", error.message);
    console.error(error.stack);
    res.status(500).json({ error: error.message });
  }
});

// 3. サーバ起動処理を即時実行関数に包み、起動時例外も拾う
(async () => {
  try {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Fatal error on startup:", err);
    process.exit(1);
  }
})();
