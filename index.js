import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;

// グローバル例外捕捉
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
    console.log("Launching browser for URL:", url);
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    console.log("Browser launched");

    const page = await browser.newPage();
    console.log("Navigating to URL");
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const title = await page.title();
    const h1Texts = await page.$$eval("h1", els => els.map(e => e.innerText.trim()));

    await browser.close();
    console.log("Browser closed");

    res.json({
      url,
      title,
      h1: h1Texts
    });
  } catch (error) {
    console.error("Error during scraping:", error);
    res.status(500).json({ error: error.message });
  }
});

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
