import { Hono } from 'hono';
import pkg from '../package.json';


const VERSION = pkg.version;
const LEBONCOIN_ROOT = 'https://www.leboncoin.fr';
const BRAND_NAME = 'FxLeboncoin';
const BRAND_COLOR = '#ff6e14'; // Leboncoin orange
const MOSAIC_DOMAIN = process.env.MOSAIC_DOMAIN ?? '';

const BOT_UA_REGEX =
  /bot|facebook|embed|got|firefox\/92|firefox\/38|curl|wget|go-http|yahoo|whatsapp|revoltchat|preview|link|proxy|vkshare|analyzer|crawl|spider|python|node|deno|mastodon|http\.rb|ruby|bun\/|iframely|cardyb|bluesky|matrix|feedly|rss|reader|atom|telegrambot|discordbot|twitterbot|slackbot|linkedinbot|applebot|signal/gi;


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


// fETCHer
async function fetchAd(adId: string, category: string): Promise<LeboncoinAd | null> {
  const url = `${LEBONCOIN_ROOT}/ad/${category}/${adId}`;
  console.log(`[fxlbc] fetching ${url}`);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
      },
      redirect: 'follow',
    });
  } catch (e) {
    console.error(`[fxlbc] fetch threw: ${e}`);
    return null;
  }

  console.log(`[fxlbc] response: ${res.status}, content-type: ${res.headers.get('content-type')}`);

  if (!res.ok) {
    const body = await res.text();
    console.error(`[fxlbc] HTTP ${res.status}. Body snippet: ${body.slice(0, 400)}`);
    return null;
  }

  const html = await res.text();
  console.log(`[fxlbc] got ${html.length} bytes`);

  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    console.error(`[fxlbc] __NEXT_DATA__ not found. Page snippet: ${html.slice(0, 300)}`);
    return null;
  }

  try {
    const data = JSON.parse(match[1]);
    const ad = data?.props?.pageProps?.ad ?? null;
    console.log(`[fxlbc] parsed ad: ${ad?.subject ?? 'null'}`);
    return ad;
  } catch (e) {
    console.error(`[fxlbc] JSON parse failed: ${e}`);
    return null;
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
  let status = 0, contentType = '', snippet = '', hasNextData = false;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
    status = res.status;
    contentType = res.headers.get('content-type') ?? '';
    const body = await res.text();
    snippet = body.slice(0, 600);
    hasNextData = body.includes('__NEXT_DATA__');
  } catch (e) {
    snippet = `fetch threw: ${e}`;
  }
  return c.json({ url, status, contentType, hasNextData, snippet });
});

/* Main handler */
async function handleAd(c: any): Promise<Response> {
  const { id, category } = c.req.param();
  const userAgent = c.req.header('User-Agent') ?? '';
  const listingUrl = `${LEBONCOIN_ROOT}/ad/${category}/${id}`;

  if (!BOT_UA_REGEX.test(userAgent)) {
    return c.redirect(listingUrl, 302);
  }

  console.log(`[fxlbc] embed for ad ${id} | UA: ${userAgent.slice(0, 60)}`);

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
  const locParts = [loc?.city_label ?? loc?.city, loc?.zipcode, loc?.department_name].filter(Boolean);
  if (locParts.length) parts.push(`📍 ${locParts.join(' ')}`);
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

console.log(`${BRAND_NAME} v${VERSION} listening on http://localhost:${PORT}`);
