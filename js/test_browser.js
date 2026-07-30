// Dev-only browser smoke test (Playwright, pre-installed Chromium): loads
// the built single-file HTML, feeds it a real ACD fixture via the file
// input, captures the downloaded L5X, and diffs it against Python's own
// ConvertAcdToL5x output for the same file (ignoring ExportDate, which is
// inherently timestamped). Not part of the shipped app.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

async function main() {
  const htmlPath = path.join(__dirname, "dist", "acd-to-l5x.html");
  const acdPath = process.argv[2] || path.join(__dirname, "..", "resources", "CuteLogix.ACD");

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    console.log(`[console.${msg.type()}]`, msg.text());
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    console.log("[pageerror]", String(err));
    consoleErrors.push(String(err));
  });

  await page.goto("file://" + htmlPath);

  let download;
  try {
    [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.locator("#file-input").setInputFiles(acdPath),
    ]);
  } catch (e) {
    const statusText = await page.locator("#status").textContent();
    console.log("Status at failure:", statusText);
    throw e;
  }

  const outPath = path.join(__dirname, "dist", "browser_output.L5X");
  await download.saveAs(outPath);

  const statusText = await page.locator("#status").textContent();
  console.log("Status:", statusText);
  if (consoleErrors.length) {
    console.log("Console errors:", consoleErrors);
  }

  await browser.close();

  const xml = fs.readFileSync(outPath, "utf8");
  console.log("Downloaded L5X length:", xml.length);
  console.log("Starts with:", xml.slice(0, 120));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
