const axios = require("axios");

async function resolveShortUrl(url) {
  try {
    const response = await axios.get(url, {
      maxRedirects: 5, // allow redirects
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });
    return response.request.res.responseUrl; // final resolved URL
  } catch (error) {
    throw new Error("Failed to resolve short URL: " + error.message);
  }
}

function extractLatLngFromUrl(url) {
  const regexAt = /@([-+]?\d{1,2}\.\d+),([-+]?\d{1,3}\.\d+)/; // e.g. @12.9716,77.5946
  const regexQ = /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/; // e.g. q=23.240461,87.859321
  const regexSearch = /\/search\/([-+]?\d+\.\d+),([-+]?\d+\.\d+)/; // /search/lat,long

  let match;
  if ((match = url.match(regexAt))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  } else if ((match = url.match(regexQ))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  } else if ((match = url.match(regexSearch))) {
    return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
  }

  return null;
}

// if (require.main === module) {
//   (async () => {
//     const shortUrl = "https://maps.app.goo.gl/9nBRMugkdWRcqHPt5";
//     try {
//       const resolvedUrl = await resolveShortUrl(shortUrl);
//       const coords = extractLatLngFromUrl(resolvedUrl);
//       console.log("[RESULT] Coordinates:", coords);
//     } catch (err) {
//       console.error("[FINAL ERROR]", err.message);
//     }
//   })();
// }

module.exports = { resolveShortUrl, extractLatLngFromUrl };
