const puppeteer = require('puppeteer-core');

async function getBrowser() {
  // 🔥 Usamos la ruta del Chromium instalado en el Dockerfile
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

  // 🔥 CONFIGURACIÓN DEL PROXY
  let proxyArgs = [];
  const proxyUrl = process.env.PROXY_URL;
  
  if (proxyUrl) {
    const parsedProxy = new URL(proxyUrl);
    // Chromium SOLO acepta el host y puerto en el argumento, NO las credenciales
    proxyArgs = [`--proxy-server=${parsedProxy.hostname}:${parsedProxy.port}`];
  }

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