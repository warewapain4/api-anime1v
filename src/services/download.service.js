const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const axios = require("axios");
const cheerio = require("cheerio");
const { HttpsProxyAgent } = require("https-proxy-agent"); 
const { ApiError } = require("../utils/api-error");
const animeService = require("./anime.service");
const { extractVoe } = require("../utils/resolvers/voe.resolver");
const { extractStreamwish } = require("../utils/resolvers/streamwish.resolver");
const { extractStreamtape } = require("../utils/resolvers/streamtape.resolver");

// 🔥 CONFIGURACIÓN DEL PROXY RESIDENCIAL
const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

const downloadStore = new Map();
const batchStore = new Map();

const DEBUG_MODE = process.env.DEBUG_DOWNLOAD === "true";

function debugLog(server, message, data) {
  if (!DEBUG_MODE) return;
  const timestamp = new Date().toISOString();
  const header = `[${timestamp}] [${server}] ${message}`;
  if (data) {
    console.log(header, typeof data === "string" ? data.slice(0, 500) : data);
  } else {
    console.log(header);
  }
}

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
};

const HTML_HEADERS = {
  "User-Agent": DEFAULT_HEADERS["User-Agent"],
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

const SERVER_PRIORITY = ["yourupload", "pdrain", "1fichier", "mp4upload", "upnshare","hls", "mega"];

function getDownloadsDir() {
  const isVercel = process.env.VERCEL || process.env.NOW_REGION;
  const targetPath = isVercel ? "/tmp/downloads" : path.resolve(process.cwd(), process.env.DOWNLOADS_DIR || "downloads");
  if (!fs.existsSync(targetPath)) {
    try { fs.mkdirSync(targetPath, { recursive: true }); } catch (e) { console.error(e); }
  }
  return targetPath;
}

function safeFilePart(value) {
  return (value || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function extractEpisodeNumber(episodeUrl) {
  if (!episodeUrl) return null;
  const parts = episodeUrl.split("/").filter(Boolean);
  const lastPart = parts[parts.length - 1] || "";
  const numberMatch = lastPart.match(/(\d+)$/);
  return (numberMatch && numberMatch[1]) ? Number(numberMatch[1]) : null;
}

function extractAnimeSlug(episodeUrl) {
  const parts = episodeUrl.split("/").filter(Boolean);
  const mediaIndex = parts.findIndex((part) => part === "media");
  return (mediaIndex === -1 || !parts[mediaIndex + 1]) ? "anime" : (safeFilePart(parts[mediaIndex + 1]) || "anime");
}

function getExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname || "";
    const ext = path.extname(pathname).toLowerCase();
    if ([".mp4", ".mkv", ".avi", ".mov", ".webm"].includes(ext)) return ext;
  } catch (_error) {}
  return ".mp4";
}

function getRefererForUrl(url) {
  try { return `${new URL(url).origin}/`; } catch (_error) { return "https://animeav1.com/"; }
}

function buildCookieHeader(setCookieHeaders) {
  if (!setCookieHeaders) return "";
  const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function normalizeExtractedUrl(value) {
  if (!value || typeof value !== "string") return null;
  return value.replace(/\\u0026/g, "&").replace(/\\\//g, "/").replace(/&amp;/g, "&").replace(/%3A/gi, ":").replace(/%2F/gi, "/").replace(/%3F/gi, "?").replace(/%3D/gi, "=").trim();
}

function findFirstUrl(payload, patterns) {
  if (!payload || typeof payload !== "string") return null;
  for (const pattern of patterns) {
    try {
      const match = payload.match(pattern);
      if (match && match[1]) {
        const candidate = normalizeExtractedUrl(match[1]);
        if (candidate && isLikelyVideoUrl(candidate)) return candidate;
      }
    } catch (_e) {}
  }
  const urlMatch = payload.match(/(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i);
  if (urlMatch && urlMatch[1]) {
    const candidate = normalizeExtractedUrl(urlMatch[1]);
    if (isLikelyVideoUrl(candidate)) return candidate;
  }
  return null;
}

function isLikelyVideoUrl(url) {
  if (!url || typeof url !== "string") return false;
  const lower = url.toLowerCase();
  const excludePatterns = ["cloudflareinsights", "google-analytics", "googletagmanager", "facebook.net", "beacon.min.js", ".js?", "analytics", "pixel", "bigbuckbunny", "test-videos", "sample-video", "placeholder"];
  for (const pattern of excludePatterns) { if (lower.includes(pattern)) return false; }
  return /\.(?:mp4|m3u8)(?:\?|#|$)/i.test(url) || lower.includes("video") || lower.includes("stream");
}

async function fetchHtmlWithHeaders(url, referer) {
  const timeout = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
  const headers = { ...HTML_HEADERS };
  if (referer) headers.Referer = referer;

  const response = await axios.get(url, {
    timeout,
    headers,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
    httpsAgent: proxyAgent,
  });
  return { html: response.data, headers: response.headers };
}

// 🔥 RESOLUTORES SIN PUPPETEER (Solo Axios)

async function resolveStreamwishUrl(url, referer) {
  try {
    const resolved = await extractStreamwish(url);
    if (resolved) return resolved;
  } catch (err) {}
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/(https?:[^\s"']+\.m3u8[^\s"']*)/i, /file\s*:\s*["'](https?:[^\s"']+)["']/i, /"file"\s*:\s*"([^"]+)"/i]);
}

async function resolveStreamtapeUrl(url, referer) {
  try {
    const resolved = await extractStreamtape(url);
    if (resolved) return resolved;
  } catch (err) {}
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/(https?:\/\/[^\s"']*streamtape\.com\/get_video[^\s"']*)/i, /(https?:\/\/[^\s"']+\.mp4[^\s"']*)/i, /"file"\s*:\s*"([^"]+)"/i]);
}

async function resolveVoeUrl(url, referer) {
  try {
    const resolved = await extractVoe(url);
    if (resolved) return resolved;
  } catch (err) {}
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/sources?\s*:\s*\[\s*\{[^}]*src\s*:\s*["']([^"']+)["']/i, /"file"\s*:\s*"([^"]+)"/i]);
}

// Resolutores genéricos basados en HTML (Reemplazan a Puppeteer)
async function resolveMp4UploadUrl(url, referer) {
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i, /(https?:\/\/[^\s"']+\.mp4[^\s"']*)/i]);
}

async function resolveZillaUrl(url, referer) {
  // Zilla se resuelve directamente construyendo la URL m3u8
  const parsed = new URL(url);
  const videoId = parsed.pathname.split("/").pop();
  if (videoId) return `https://player.zilla-networks.com/m3u8/${videoId}`;
  return null;
}

async function resolveFembedUrl(url, referer) {
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/sources?\s*:\s*\[\s*\{[^}]*src\s*:\s*["']([^"']+)["']/i, /file["']?\s*:\s*["']([^"']+)["']/i]);
}

async function resolveYourUploadUrl(url, referer) {
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/file["']?\s*:\s*["']([^"']+\.mp4[^"']*)["']/i, /(https?:\/\/[^\s"']+\.mp4[^\s"']*)/i]);
}

async function resolveMixdropUrl(url, referer) {
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/sources?\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i, /file\s*:\s*"([^"]+\.mp4[^"]*)"/i]);
}

async function resolveDoodstreamUrl(url, referer) {
  const { html } = await fetchHtmlWithHeaders(url, referer);
  return findFirstUrl(html, [/"file"\s*:\s*"([^"]+\.mp4[^"]*)"/i, /"video"\s*:\s*"([^"]+)"/i]);
}

// Resolutor Principal
async function resolveEmbedUrl(url, record, candidate) {
  if (!url) return null;

  let parsed;
  try { parsed = new URL(url); } catch (_error) { return url; }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const pathname = parsed.pathname.toLowerCase();
  const referer = getRefererForUrl(candidate?.url || record?.url || url);

  debugLog("resolveEmbed", `Host: ${host}, Path: ${pathname}`, url);

  if (/streamwish|sfastwish|flaswish/i.test(host)) {
    const resolved = await resolveStreamwishUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/streamtape/i.test(host)) {
    const resolved = await resolveStreamtapeUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/voe\.sx/i.test(host) || /\/e\//.test(pathname)) {
    const resolved = await resolveVoeUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/mp4upload/i.test(host)) {
    const resolved = await resolveMp4UploadUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/zilla-networks/i.test(host)) {
    const resolved = await resolveZillaUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/embedsito|fembed|mycloud/i.test(host)) {
    const resolved = await resolveFembedUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/yourupload/i.test(host)) {
    const resolved = await resolveYourUploadUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/mixdrop/i.test(host)) {
    const resolved = await resolveMixdropUrl(url, referer);
    if (resolved) return resolved;
  }

  if (/dsvplay|doodstream/i.test(host)) {
    const resolved = await resolveDoodstreamUrl(url, referer);
    if (resolved) return resolved;
  }

  // Fallback genérico
  try {
    const { html } = await fetchHtmlWithHeaders(url, referer);
    const extracted = findFirstUrl(html, [/sources?\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i, /"file"\s*:\s*"([^"]+)"/i, /(https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8)[^\s"'<>]*)/i]);
    if (extracted) return extracted;
  } catch(e) {}

  throw new Error("No se pudo resolver el enlace directo en el servidor.");
}

// (El resto de tus funciones downloadFromUrl, runDownload, createDownload, etc. se mantienen exactamente igual)
async function downloadHlsVideo(finalUrl, filePath, record, candidate) {
  throw new Error("La descarga de HLS está deshabilitada en este entorno (Sin FFmpeg).");
}

async function removeFileIfExists(targetPath) {
  try { await fs.promises.unlink(targetPath); } catch (_error) {}
}

function ensureDirectLikeContent(contentType, url) {
  const lowered = (contentType || "").toLowerCase();
  if (/(text\/html|application\/json|application\/javascript|text\/plain)/i.test(lowered)) {
    throw new Error(`El servidor devolvio contenido no descargable (${lowered}) para ${url}`);
  }
}

async function downloadFromUrl(record, candidate) {
  let finalUrl = await resolveEmbedUrl(candidate.url, record, candidate);
  if (!finalUrl) throw new Error(`No se pudo resolver enlace directo en ${candidate.server}`);
  
  const downloadsDir = getDownloadsDir();
  const fileName = `${extractAnimeSlug(record.url)}-ep${extractEpisodeNumber(record.url) || 'x'}-${safeFilePart(candidate.server)}-${record.downloadId.split("-")[0]}${getExtensionFromUrl(finalUrl)}`;
  const filePath = path.join(downloadsDir, fileName);
  const referer = getRefererForUrl(candidate.url || record.url || finalUrl);
  const isHls = finalUrl.toLowerCase().includes(".m3u8") || /hls/i.test(candidate.server);

  if (isHls) {
    await downloadHlsVideo(finalUrl, filePath, record, candidate);
  } else {
    let response;
    try {
      response = await axios.get(finalUrl, {
        responseType: "stream",
        timeout: Number(process.env.DOWNLOAD_REQUEST_TIMEOUT_MS || 120000),
        maxRedirects: 5,
        headers: { ...DEFAULT_HEADERS, Referer: referer },
        validateStatus: (status) => status >= 200 && status < 400,
        httpsAgent: proxyAgent,
      });
    } catch (error) {
      throw new Error(`No se pudo abrir enlace ${candidate.server}: ${error.message}`);
    }

    ensureDirectLikeContent(response.headers["content-type"] || "", finalUrl);
    const writer = fs.createWriteStream(filePath, { flags: "w" });
    await pipeline(response.data, writer);
  }

  const stat = await fs.promises.stat(filePath);
  if (!stat.size || stat.size < 512 * 1024) {
    await removeFileIfExists(filePath);
    throw new Error(`Archivo invalido en ${candidate.server}: tamano demasiado pequeno`);
  }

  record.status = "completed";
  record.progress = 100;
  record.fileName = fileName;
  record.filePath = filePath;
  record.fileSize = String(stat.size);
  record.downloadUrl = `${record.baseUrl}/downloads/${fileName}`;
  record.completedAt = Date.now();
}

async function runDownload(record, payload) {
  record.status = "preparing";
  const variant = String(record.variant || "SUB").toUpperCase() === "DUB" ? "DUB" : "SUB";
  const includeMega = String(payload?.includeMega).toLowerCase() === "true";
  const excludeServers = payload?.excludeServers;
  const preferredServer = payload?.preferredServer;

  try {
    const episodeResponse = await animeService.getEpisodeLinks(record.url, includeMega, excludeServers);
    const downloadLinks = episodeResponse.data?.downloadLinks || { SUB: [], DUB: [] };
    const streamLinks = episodeResponse.data?.streamLinks || { SUB: [], DUB: [] };
    const candidates = [...(downloadLinks[variant] || []), ...(downloadLinks[variant === "SUB" ? "DUB" : "SUB"] || []), ...(streamLinks[variant] || []), ...(streamLinks[variant === "SUB" ? "DUB" : "SUB"] || [])];
    
    if (candidates.length === 0) throw new Error("No se encontraron enlaces");

    const errors = [];
    for (const candidate of candidates) {
      try {
        await downloadFromUrl(record, candidate);
        return;
      } catch (error) {
        errors.push(`${candidate.server}: ${error.message}`);
      }
    }
    throw new Error(`Todos los servidores fallaron. ${errors.join(" | ")}`);
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
  }
}

// (Mantén tus funciones createDownload, getDownload, createBatch, getBatch, y module.exports exactamente como estaban al final de tu archivo)