const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium-min');

async function getBrowser() {
  const isVercel = process.env.VERCEL || process.env.NOW_REGION;
  const CHROMIUM_PATH = "https://github.com/Sparticuz/chromium/releases/download/v131.0.0/chromium-v131.0.0-pack.x64.tar";

  return await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: isVercel ? await chromium.executablePath(CHROMIUM_PATH) : undefined,
    headless: chromium.headless,
  });
}

module.exports = { getBrowser };