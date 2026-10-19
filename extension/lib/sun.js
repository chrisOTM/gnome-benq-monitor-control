// Sunrise/sunset from the NOAA solar calculator equations; no network needed.

const ZENITH_DEG = 90.833; // official: refraction + solar disc radius
const DAY_MS = 86400000;

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;

/**
 * Sun times for a calendar day (year, month 0-11, day) at a location.
 *
 * @returns {{sunrise: Date|null, sunset: Date|null}} null for polar day or night
 */
export function sunTimes(year, month, day, latitude, longitude) {
    const midnightUtc = Date.UTC(year, month, day);
    // Julian day at local solar noon (approximation good to well under a minute).
    const jd = midnightUtc / DAY_MS + 2440587.5 + 0.5 - longitude / 360;
    const t = (jd - 2451545.0) / 36525.0;
    const meanLong = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
    const meanAnom = rad(357.52911 + t * (35999.05029 - 0.0001537 * t));
    const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const center =
        Math.sin(meanAnom) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
        Math.sin(2 * meanAnom) * (0.019993 - 0.000101 * t) +
        Math.sin(3 * meanAnom) * 0.000289;
    const omega = rad(125.04 - 1934.136 * t);
    const appLong = rad(meanLong + center - 0.00569 - 0.00478 * Math.sin(omega));
    const obliq0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const obliq = rad(obliq0 + 0.00256 * Math.cos(omega));
    const decl = Math.asin(Math.sin(obliq) * Math.sin(appLong));
    const y = Math.tan(obliq / 2) ** 2;
    const l0 = rad(meanLong);
    const eqTimeMin = 4 * deg(
        y * Math.sin(2 * l0) -
        2 * ecc * Math.sin(meanAnom) +
        4 * ecc * y * Math.sin(meanAnom) * Math.cos(2 * l0) -
        0.5 * y * y * Math.sin(4 * l0) -
        1.25 * ecc * ecc * Math.sin(2 * meanAnom));
    const lat = rad(latitude);
    const cosHa = Math.cos(rad(ZENITH_DEG)) / (Math.cos(lat) * Math.cos(decl)) - Math.tan(lat) * Math.tan(decl);
    if (cosHa < -1 || cosHa > 1)
        return {sunrise: null, sunset: null}; // polar night (> 1) or polar day (< -1)
    const haMin = 4 * deg(Math.acos(cosHa));
    const noonUtcMin = 720 - 4 * longitude - eqTimeMin;
    return {
        sunrise: new Date(midnightUtc + (noonUtcMin - haMin) * 60000),
        sunset: new Date(midnightUtc + (noonUtcMin + haMin) * 60000),
    };
}
