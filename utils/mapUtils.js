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

    // If resolved URL already has coordinates, return it
    if (extractLatLngFromUrl(finalUrl)) {
      return finalUrl;
    }

    // Fallback: scan the response HTML for any coordinate pattern
    const html = typeof response.data === "string" ? response.data : "";
    if (html) {
      // Look for /@lat,lng anywhere in the HTML (embedded links)
      const atMatch = html.match(/\/@([-+]?\d{1,3}\.\d{4,}),([-+]?\d{1,3}\.\d{4,})/);
      if (atMatch) {
        return `https://maps.google.com/?q=${atMatch[1]},${atMatch[2]}`;
      }

      // Look for !3d<lat>!4d<lng> in HTML
      const embedMatch = html.match(/!3d([-+]?\d{1,3}\.\d{4,})[^!]*!4d([-+]?\d{1,3}\.\d{4,})/);
      if (embedMatch) {
        return `https://maps.google.com/?q=${embedMatch[1]},${embedMatch[2]}`;
      }

      // Look for [null,null,lat,lng] pattern (Google Maps JS data)
      const nullMatch = html.match(/\[null,null,([-+]?\d{1,3}\.\d{4,}),([-+]?\d{1,3}\.\d{4,})\]/);
      if (nullMatch) {
        return `https://maps.google.com/?q=${nullMatch[1]},${nullMatch[2]}`;
      }
    }

    return finalUrl;
  } catch (error) {
    throw new Error("Failed to resolve short URL: " + error.message);
  }
}

function extractLatLngFromUrl(url) {
  // Pattern 0: Raw "lat,lng" input (e.g. "22.7532,75.8937")
  const regexRaw = /^([-+]?\d{1,3}\.\d+)\s*,\s*([-+]?\d{1,3}\.\d+)$/;

  // Pattern 1: @lat,lng  — standard Google Maps place URL
  const regexAt = /@([-+]?\d{1,3}\.\d+),([-+]?\d{1,3}\.\d+)/;

  // Pattern 2: q=lat,lng — query parameter
  const regexQ = /[?&]q=([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  // Pattern 3: /search/lat,lng
  const regexSearch = /\/search\/([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  // Pattern 4: !3d<lat>!4d<lng> — Google Maps embed/data URL format
  const regexEmbed = /!3d([-+]?\d+\.\d+)[^!]*!4d([-+]?\d+\.\d+)/;

  // Pattern 5: ll=lat,lng — older Google Maps URL format
  const regexLL = /[?&]ll=([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  // Pattern 6: loc:lat,lng or loc:lat+lng
  const regexLoc = /loc:([-+]?\d+\.\d+)[+,]([-+]?\d+\.\d+)/;

  // Pattern 7: daddr=lat,lng (directions URL)
  const regexDaddr = /[?&]daddr=([-+]?\d+\.\d+),([-+]?\d+\.\d+)/;

  let match;
  if ((match = url.match(regexRaw))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }
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
