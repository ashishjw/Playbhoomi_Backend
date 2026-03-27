const axios = require("axios");

async function resolveShortUrl(url) {
  try {
    const response = await axios.get(url, {
      maxRedirects: 10,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const finalUrl =
      response.request?._redirectable?._currentUrl ||
      response.request?.res?.responseUrl ||
      url;

    // If resolved URL has coordinates, return it directly
    if (extractLatLngFromUrl(finalUrl)) {
      return finalUrl;
    }

    // Fallback: scan the HTML response body for coordinates
    const html = typeof response.data === "string" ? response.data : "";
    const coordsFromHtml = extractLatLngFromHtml(html);
    if (coordsFromHtml) {
      // Return a synthetic URL that extractLatLngFromUrl can parse
      return `https://maps.google.com/?q=${coordsFromHtml.lat},${coordsFromHtml.lng}`;
    }

    return finalUrl;
  } catch (error) {
    throw new Error("Failed to resolve short URL: " + error.message);
  }
}

function extractLatLngFromHtml(html) {
  if (!html) return null;

  // Pattern: APP_INITIALIZATION_STATE or window.APP_OPTIONS containing [null,null,lat,lng]
  const regexInitState = /\[null,null,([-+]?\d{1,3}\.\d{4,}),([-+]?\d{1,3}\.\d{4,})\]/;

  // Pattern: /@lat,lng in any embedded URL within the HTML
  const regexEmbeddedAt = /\/@([-+]?\d{1,3}\.\d{4,}),([-+]?\d{1,3}\.\d{4,})/;

  // Pattern: Google Maps image/static map center=lat%2Clng or center=lat,lng
  const regexCenter = /center=([-+]?\d{1,3}\.\d{4,})(?:%2C|,)([-+]?\d{1,3}\.\d{4,})/;

  // Pattern: pb=...!2d<lng>!3d<lat> (note: 2d is lng, 3d is lat in this format)
  const regexPb2d3d = /!2d([-+]?\d{1,3}\.\d{4,})!3d([-+]?\d{1,3}\.\d{4,})/;

  let match;

  // Prefer embedded @ pattern (most reliable)
  if ((match = html.match(regexEmbeddedAt))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }

  // pb format: !2d is longitude, !3d is latitude
  if ((match = html.match(regexPb2d3d))) {
    return { lat: parseFloat(match[2]), lng: parseFloat(match[1]) };
  }

  if ((match = html.match(regexInitState))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }

  if ((match = html.match(regexCenter))) {
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    // Sanity check: valid lat/lng ranges
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }

  return null;
}

function extractLatLngFromUrl(url) {
  // Pattern 1: @lat,lng  — standard Google Maps place URL
  // e.g. /maps/place/Name/@18.5204,73.8567,15z
  const regexAt = /@([-+]?\d{1,3}\.\d+),([-+]?\d{1,3}\.\d+)/;

  // Pattern 2: q=lat,lng — query parameter
  // e.g. ?q=18.5204,73.8567
  const regexQ = /[?&]q=([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  // Pattern 3: /search/lat,lng
  const regexSearch = /\/search\/([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  // Pattern 4: !3d<lat>!4d<lng> — Google Maps embed/data URL format
  // e.g. /maps/embed?pb=...!3d18.5204...!4d73.8567
  const regexEmbed = /!3d([-+]?\d+\.\d+)[^!]*!4d([-+]?\d+\.\d+)/;

  // Pattern 5: ll=lat,lng — older Google Maps URL format
  // e.g. ?ll=18.5204,73.8567
  const regexLL = /[?&]ll=([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  // Pattern 6: loc:lat,lng or loc:lat+lng
  // e.g. loc:18.5204+73.8567
  const regexLoc = /loc:([-+]?\d+\.\d+)[+,]([-+]?\d+\.\d+)/;

  // Pattern 7: daddr=lat,lng (directions URL)
  // e.g. ?daddr=18.5204,73.8567
  const regexDaddr = /[?&]daddr=([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  let match;
  if ((match = url.match(regexAt))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  if ((match = url.match(regexEmbed))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  if ((match = url.match(regexQ))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  if ((match = url.match(regexLL))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  if ((match = url.match(regexSearch))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  if ((match = url.match(regexDaddr))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
  if ((match = url.match(regexLoc))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }

  return null;
}

module.exports = { resolveShortUrl, extractLatLngFromUrl };
