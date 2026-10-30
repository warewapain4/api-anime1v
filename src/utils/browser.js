const puppeteer = require('puppeteer-core');

async function getBrowser() {
  // 🔥 Usamos la ruta del Chromium instalado en el Dockerfile
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  // 🔥 CONFIGURACIÓN DEL PROXY: Usamos la URL completa (con http://)
  const proxyUrl = process.env.PROXY_URL;
  const proxyArgs = proxyUrl ? [`--proxy-server=${proxyUrl}`] : [];

  return await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...proxyArgs
    ],
    defaultViewport: { width: 1280, height: 720 },
    executablePath: executablePath,
    headless: true,
  });
}

module.exports = { getBrowser };