const { db } = require("../firebase/firebase");

/**
 * Get list of courts configured for a specific sport in a turf.
 * Returns an array of court names (e.g., ["Court A", "Court B"])
 * Returns empty array if no courts configured (falls back to single-capacity mode).
 */
async function getCourtsForSport(vendorId, turfId, sport) {
  const turfDoc = await db
    .collection("vendors")
    .doc(vendorId)
    .collection("turfs")
    .doc(turfId)
    .get();

  if (!turfDoc.exists) return [];

  const turfData = turfDoc.data();
  const normalizedSport = sport.trim().toLowerCase();
  const sportData = (turfData.sports || []).find(
    (s) => s.name?.toLowerCase() === normalizedSport
  );
  return sportData?.courts || [];
}

/**
 * Pick the next available court for a given slot.
 * Returns { court: string | null, availableCount: number, totalCount: number }
 * - court: name of an available court (null if all taken)
 * - availableCount: how many courts are still free
 * - totalCount: total courts configured (0 if none = legacy single-capacity mode)
 */
function pickAvailableCourt(allCourts, takenCourts) {
  const takenSet = new Set(takenCourts.filter(Boolean));
  const available = allCourts.filter((c) => !takenSet.has(c));
  return {
    court: available[0] || null,
    availableCount: available.length,
    totalCount: allCourts.length,
  };
}

module.exports = { getCourtsForSport, pickAvailableCourt };
