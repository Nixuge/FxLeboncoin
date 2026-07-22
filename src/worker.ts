import { Hono } from 'hono';
import puppeteer from 'puppeteer-core';
import { Browser } from 'puppeteer-core';
import pkg from '../package.json';
import { log, logError, logWarn, logMiddleware } from './logger';


const VERSION = pkg.version;
const LEBONCOIN_ROOT = 'https://www.leboncoin.fr';
const BRAND_NAME = 'FxLeboncoin';
const BRAND_COLOR = '#ff6e14'; // Leboncoin orange
const MOSAIC_DOMAIN = process.env.MOSAIC_DOMAIN ?? '';
const CHROME_DEBUG_URL = 'http://127.0.0.1:9222';

const BOT_UA_REGEX =
  /bot|facebook|embed|got|firefox\/92|firefox\/38|curl|wget|go-http|yahoo|whatsapp|revoltchat|preview|link|proxy|vkshare|analyzer|crawl|spider|python|node|deno|mastodon|http\.rb|ruby|bun\/|iframely|cardyb|bluesky|matrix|feedly|rss|reader|atom|telegrambot|discordbot|twitterbot|slackbot|linkedinbot|applebot|signal/i;


interface AdImages {
  urls?: string[];
  urls_large?: string[];
  thumb_url?: string;
}

interface AdLocation {
  city?: string;
  city_label?: string;
  department_name?: string;
  zipcode?: string;
}

interface LeboncoinAd {
  list_id?: number;
  subject?: string;
  body?: string;
  price?: number[];
  images?: AdImages;
  location?: AdLocation;
  category_name?: string;
}

/* Helpers */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(price: number[] | undefined): string {
  if (!price?.length) return '';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(price[0]);
}

/* Browser Connection Management */

let globalBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (globalBrowser && globalBrowser.connected) {
    return globalBrowser;
  }

  log(`[fxlbc] Connecting to active Chrome instance on ${CHROME_DEBUG_URL}...`);
  try {
    globalBrowser = await puppeteer.connect({
      browserURL: CHROME_DEBUG_URL,
    });
  } catch (e) {
    logError(`[fxlbc] Failed to connect to Chrome. Make sure Chrome is running with --remote-debugging-port=9222!`);
    throw new Error('Chrome connection failed');
  }

  globalBrowser.on('disconnected', () => {
    log('[fxlbc] Chrome disconnected');
    globalBrowser = null;
  });

  return globalBrowser;
}

async function fetchAd(adId: string, category: string): Promise<LeboncoinAd | null> {
  const url = `${LEBONCOIN_ROOT}/ad/${category}/${adId}`;
  log(`[fxlbc] Connected-fetching ${url}`);

  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (e) {
    return null;
  }

  const page = await browser.newPage();
  
  try {
    // Navigate and wait only for initial DOM content load (extremely fast!)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    try {
      await page.waitForSelector('#__NEXT_DATA__', { timeout: 6000 });
    } catch {
      logWarn(`[fxlbc] Timeout waiting for #__NEXT_DATA__ selector on ad ${adId}`);
    }

    // Extract __NEXT_DATA__
    const nextDataText = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (!nextDataText) {
      const title = await page.title();
      logError(`[fxlbc] __NEXT_DATA__ not found. Page title: ${title}`);
      return null;
    }

    const data = JSON.parse(nextDataText);
    const pageProps = data?.props?.pageProps;

    if (pageProps && ('ad' in pageProps) && pageProps.ad === null) {
      log(`[fxlbc] Ad is explicitly null/inactive in pageProps`);
      return {
        subject: `Annonce Inactive`,
        body: `❌ Cette annonce n'est plus active (désactivée, vendue ou expirée).`,
        price: [],
        images: {},
        location: {},
      };
    }

    if (pageProps?.error) {
      log(`[fxlbc] Page returned error: ${JSON.stringify(pageProps.error)}`);
      return {
        subject: `Annonce Inactive`,
        body: `❌ Cette annonce n'est plus active (désactivée, vendue ou expirée).`,
        price: [],
        images: {},
        location: {},
      };
    }

    const ad = pageProps?.ad ?? null;
    log(`[fxlbc] Successfully fetched ad: ${ad?.subject ?? 'null'}`);
    return ad;

  } catch (e) {
    logError(`[fxlbc] Fetching failed for ad ${adId}:`, e);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/* ── Build the embed HTML page ──────────────────────────────── */

function buildEmbed(opts: {
  title: string;
  description: string;
  imageUrl: string | null;
  listingUrl: string;
}): string {
  const { title, description, imageUrl, listingUrl } = opts;

  const imageMetaTags = imageUrl
    ? `  <meta property="og:image" content="${esc(imageUrl)}"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:image" content="${esc(imageUrl)}"/>`
    : `  <meta name="twitter:card" content="summary"/>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>

  <meta property="og:type" content="website"/>
  <meta property="og:url" content="${esc(listingUrl)}"/>
  <meta property="og:site_name" content="${esc(BRAND_NAME)}"/>
  <meta property="og:title" content="${esc(title)}"/>
  <meta property="og:description" content="${esc(description)}"/>
${imageMetaTags}

  <meta name="twitter:title" content="${esc(title)}"/>
  <meta name="twitter:description" content="${esc(description)}"/>
  <meta name="theme-color" content="${BRAND_COLOR}"/>

  <link rel="alternate" type="application/json+oembed"
    href="/oembed?url=${encodeURIComponent(listingUrl)}&amp;title=${encodeURIComponent(title)}"
    title="${esc(title)}"/>

  <meta http-equiv="refresh" content="0; url=${esc(listingUrl)}"/>
  <title>${esc(title)}</title>
</head>
<body>
  <p>Redirecting to <a href="${esc(listingUrl)}">${esc(title)}</a>…</p>
</body>
</html>`;
}

/* ── Hono app ───────────────────────────────────────────────── */

const app = new Hono();

app.use('*', logMiddleware());

app.get('/', c => {
  const host = c.req.header('host') ?? 'localhost:3000';
  const proto = host.startsWith('localhost') ? 'http' : 'https';
  const baseUrl = `${proto}://${host}`;
  const exampleUrl = `${baseUrl}/ad/accessoires_bagagerie/3234689912`;

  return c.text(
    `${BRAND_NAME} v${VERSION} 🟠\n\n` +
    `Remplace "www.leboncoin.fr" par "${host}" dans n'importe quel lien d'annonce.\n\n` +
    `Exemple:\n  ${exampleUrl}\n\n` +
    `Config:\n` +
    `  MOSAIC_DOMAIN = ${MOSAIC_DOMAIN || '(non configuré — une seule image)'}\n`
  );
});

app.get('/oembed', c => {
  const p = new URL(c.req.url).searchParams;
  return c.json({
    type: 'rich',
    version: '1.0',
    title: p.get('title') ?? BRAND_NAME,
    provider_name: BRAND_NAME,
    provider_url: LEBONCOIN_ROOT,
    author_name: BRAND_NAME,
    author_url: p.get('url') ?? LEBONCOIN_ROOT,
  });
});

app.get('/debug/:category/:id', async c => {
  const { id, category } = c.req.param();
  const url = `${LEBONCOIN_ROOT}/ad/${category}/${id}`;
  let status = 0, hasNextData = false, error = '';
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      status = res ? res.status() : 0;
      try {
        await page.waitForSelector('#__NEXT_DATA__', { timeout: 6000 });
      } catch {}
      const html = await page.content();
      hasNextData = html.includes('__NEXT_DATA__');
    } finally {
      await page.close();
    }
  } catch (e: any) {
    error = e.message;
  }
  return c.json({ url, status, hasNextData, error });
});

/* Main handler */
async function handleAd(c: any): Promise<Response> {
  const { id, category } = c.req.param();
  const userAgent = c.req.header('User-Agent') ?? '';
  const listingUrl = `${LEBONCOIN_ROOT}/ad/${category}/${id}`;

  const isBot = BOT_UA_REGEX.test(userAgent);
  if (!isBot) {
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
    if (isIOS) {
      const appUrl = `leboncoin://ad/${category}/${id}`;
      return c.redirect(appUrl, 302);
    }
    return c.redirect(listingUrl, 302);
  }

  log(`[fxlbc] embed for ad ${id} | UA: ${userAgent.slice(0, 60)}`);

  const ad = await fetchAd(id, category);

  if (!ad) {
    return c.html(
      buildEmbed({
        title: BRAND_NAME,
        description: "Cette annonce n'a pas pu être chargée.",
        imageUrl: null,
        listingUrl,
      }),
      200
    );
  }

  const title = ad.subject ?? 'Annonce Leboncoin';

  const parts: string[] = [];
  const price = formatPrice(ad.price);
  if (price) parts.push(`💰 ${price}`);
  const loc = ad.location;
  const cityAndZip = loc?.city && loc?.zipcode ? `${loc.city} (${loc.zipcode})` : (loc?.city_label ?? loc?.city);
  const locationString = [cityAndZip, loc?.department_name].filter(Boolean).join(' - ');
  if (locationString) parts.push(`📍 ${locationString}`);
  if (ad.body) parts.push(ad.body.trim().slice(0, 250));
  const description = parts.join('\n');

  const imageUrls: string[] = ad.images?.urls_large ?? ad.images?.urls ?? [];

  let imageUrl: string | null = null;
  if (imageUrls.length >= 2 && MOSAIC_DOMAIN) {
    const encoded = imageUrls.slice(0, 4).map(u => encodeURIComponent(u)).join('/');
    imageUrl = `https://${MOSAIC_DOMAIN}/jpeg/${ad.list_id ?? id}/${encoded}`;
  } else if (imageUrls.length >= 1) {
    imageUrl = imageUrls[0];
    if (!imageUrl.includes('scale=')) {
      imageUrl += imageUrl.includes('?') ? '&scale=full' : '?scale=full';
    }
  }

  return c.html(
    buildEmbed({ title, description, imageUrl, listingUrl }),
    200,
    { 'Cache-Control': 'public, max-age=300' }
  );
}

app.get('/ad/:category/:id', handleAd);
app.get('/ad/:category/:id/:rest{.+}', handleAd);

app.all('*', c => c.redirect(LEBONCOIN_ROOT, 302));

const PORT = parseInt(process.env.PORT ?? '3000');

export default {
  port: PORT,
  fetch: app.fetch,
};

log(`🟠 ${BRAND_NAME} v${VERSION} listening on http://localhost:${PORT}`);
// Connect to the running Chrome instance when starting up
getBrowser().catch(() => {});
