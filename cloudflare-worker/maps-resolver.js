/**
 * Zapfy Google Maps Shortlink Resolver (Cloudflare Worker)
 * Safely expands `maps.app.goo.gl` and `goo.gl/maps` links server-side with CORS
 * so the browser PWA can resolve mobile Google Maps share links into coordinates.
 */

const ALLOWED_INITIAL_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);
const ALLOWED_REDIRECT_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'consent.google.com',
  'google.com',
  'www.google.com',
  'maps.google.com',
  'www.google.de',
  'maps.google.de'
]);

const MAX_REDIRECT_HOPS = 6;

function corsHeaders(env) {
  const origin = env && env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function jsonResponse(payload, status, env, cacheSeconds = 0) {
  const headers = {
    ...corsHeaders(env),
    'Content-Type': 'application/json; charset=utf-8'
  };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    (Math.abs(lat) > 0.001 || Math.abs(lng) > 0.001)
  );
}

function extractLabelFromUrl(urlStr) {
  const placeMatch = urlStr.match(/\/maps\/place\/([^/@?#]+)/i);
  if (placeMatch && placeMatch[1]) {
    try {
      const decoded = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
      if (decoded && !/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(decoded)) {
        return decoded.split(',')[0].trim().slice(0, 64);
      }
    } catch {
      // Ignore malformed encoding
    }
  }
  const qMatch = urlStr.match(/[?&](?:q|query)=([^&#]+)/i);
  if (qMatch && qMatch[1]) {
    try {
      const decoded = decodeURIComponent(qMatch[1].replace(/\+/g, ' ')).trim();
      if (decoded && !/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(decoded) && !/^ftid=/i.test(decoded)) {
        return decoded.split(',')[0].trim().slice(0, 64);
      }
    } catch {
      // Ignore malformed encoding
    }
  }
  return '';
}

function extractCoordsFromMapsUrl(urlStr) {
  if (!urlStr) return null;

  const pinMatch = urlStr.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pinMatch) {
    const lat = Number(pinMatch[1]);
    const lng = Number(pinMatch[2]);
    if (isValidCoord(lat, lng)) {
      return { lat, lng, label: extractLabelFromUrl(urlStr) };
    }
  }

  const queryCoord = urlStr.match(/[?&](?:q|query|destination|daddr|ll)=(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (queryCoord) {
    const lat = Number(queryCoord[1]);
    const lng = Number(queryCoord[2]);
    if (isValidCoord(lat, lng)) {
      return { lat, lng, label: extractLabelFromUrl(urlStr) };
    }
  }

  const atMatch = urlStr.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (atMatch) {
    const lat = Number(atMatch[1]);
    const lng = Number(atMatch[2]);
    if (isValidCoord(lat, lng)) {
      return { lat, lng, label: extractLabelFromUrl(urlStr) };
    }
  }

  return null;
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaFromHtml(html) {
  let lat = null;
  let lng = null;
  let label = '';

  const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (titleMatch && titleMatch[1]) {
    label = decodeHtmlEntities(titleMatch[1])
      .replace(/\s*[·\-–|]\s*Google\s*Maps\s*$/i, '')
      .trim()
      .slice(0, 64);
  }

  const imgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (imgMatch && imgMatch[1]) {
    const imgUrl = decodeHtmlEntities(imgMatch[1]);
    const centerMatch = imgUrl.match(/[?&](?:center|markers)=([^&]+)/i);
    if (centerMatch && centerMatch[1]) {
      const decodedCenter = decodeURIComponent(centerMatch[1]);
      const coordMatch = decodedCenter.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
      if (coordMatch) {
        const cLat = Number(coordMatch[1]);
        const cLng = Number(coordMatch[2]);
        if (isValidCoord(cLat, cLng)) {
          lat = cLat;
          lng = cLng;
        }
      }
    }
  }

  if (lat === null || lng === null) {
    const bodyPin = html.match(/!3d(-?\d+\.\d{4,})!4d(-?\d+\.\d{4,})/);
    if (bodyPin) {
      const bLat = Number(bodyPin[1]);
      const bLng = Number(bodyPin[2]);
      if (isValidCoord(bLat, bLng)) {
        lat = bLat;
        lng = bLng;
      }
    }
  }

  return { lat, lng, label };
}

function unwrapConsentUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.hostname === 'consent.google.com') {
      const cont = parsed.searchParams.get('continue');
      if (cont) {
        const contUrl = new URL(cont);
        if (contUrl.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.has(contUrl.hostname)) {
          return contUrl.toString();
        }
      }
    }
  } catch {
    // Ignore invalid URL
  }
  return urlStr;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, env);
    }

    const reqUrl = new URL(request.url);
    const targetParam = (reqUrl.searchParams.get('url') || '').trim();
    if (!targetParam) {
      return jsonResponse({ ok: false, error: 'Missing url parameter' }, 400, env);
    }

    let currentUrl;
    try {
      const parsed = new URL(targetParam);
      if (parsed.protocol !== 'https:' || !ALLOWED_INITIAL_HOSTS.has(parsed.hostname)) {
        return jsonResponse({ ok: false, error: 'Only maps.app.goo.gl or goo.gl/maps URLs are allowed' }, 400, env);
      }
      if (parsed.hostname === 'goo.gl' && !parsed.pathname.startsWith('/maps')) {
        return jsonResponse({ ok: false, error: 'Only goo.gl/maps paths are allowed' }, 400, env);
      }
      currentUrl = parsed.toString();
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid URL' }, 400, env);
    }

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      'Cookie': 'SOCS=CAESHAgBEhJnd3NfMjAyNDAxMDEtMF9SQzEaAmRlIAEaBgiA_LCuBg'
    };

    try {
      let lastResponse = null;

      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        currentUrl = unwrapConsentUrl(currentUrl);

        const quickCoords = extractCoordsFromMapsUrl(currentUrl);
        if (quickCoords) {
          return jsonResponse(
            {
              ok: true,
              resolvedUrl: currentUrl,
              lat: quickCoords.lat,
              lng: quickCoords.lng,
              label: quickCoords.label || ''
            },
            200,
            env,
            86400
          );
        }

        const resp = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          headers: upstreamHeaders
        });
        lastResponse = resp;

        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get('location');
          if (!location) break;

          const nextParsed = new URL(location, currentUrl);
          if (nextParsed.protocol !== 'https:' || !ALLOWED_REDIRECT_HOSTS.has(nextParsed.hostname)) {
            return jsonResponse({ ok: false, error: 'Blocked unexpected redirect target' }, 400, env);
          }
          currentUrl = unwrapConsentUrl(nextParsed.toString());
          continue;
        }

        break;
      }

      const finalCoords = extractCoordsFromMapsUrl(currentUrl);
      if (finalCoords) {
        return jsonResponse(
          {
            ok: true,
            resolvedUrl: currentUrl,
            lat: finalCoords.lat,
            lng: finalCoords.lng,
            label: finalCoords.label || ''
          },
          200,
          env,
          86400
        );
      }

      // Fallback: inspect final Google Maps HTML for staticmap center or embedded pin
      let htmlMeta = { lat: null, lng: null, label: '' };
      if (lastResponse && lastResponse.ok) {
        const html = await lastResponse.text();
        htmlMeta = extractMetaFromHtml(html);
      } else {
        const htmlResp = await fetch(currentUrl, { method: 'GET', redirect: 'follow', headers: upstreamHeaders });
        if (htmlResp.ok) {
          currentUrl = unwrapConsentUrl(htmlResp.url || currentUrl);
          const urlCoords = extractCoordsFromMapsUrl(currentUrl);
          if (urlCoords) {
            return jsonResponse(
              {
                ok: true,
                resolvedUrl: currentUrl,
                lat: urlCoords.lat,
                lng: urlCoords.lng,
                label: urlCoords.label || ''
              },
              200,
              env,
              86400
            );
          }
          htmlMeta = extractMetaFromHtml(await htmlResp.text());
        }
      }

      return jsonResponse(
        {
          ok: true,
          resolvedUrl: currentUrl,
          lat: htmlMeta.lat,
          lng: htmlMeta.lng,
          label: htmlMeta.label || extractLabelFromUrl(currentUrl) || ''
        },
        200,
        env,
        htmlMeta.lat !== null ? 86400 : 300
      );
    } catch (err) {
      return jsonResponse({ ok: false, error: err && err.message ? err.message : 'Upstream error' }, 502, env);
    }
  }
};
