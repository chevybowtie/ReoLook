// Small text formatting helpers shared by several modules.

/**
 * A number as at least two digits, with a leading zero: 7 gives "07".
 * @param {number} n
 * @returns {string}
 */
export const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The time of day of a Date as HHMMSS (local time), as used in recording file names.
 * @param {Date} d
 * @returns {string}
 */
export const hhmmss = (d) => `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

/**
 * Hides the password in any `scheme://user:password@host` address in a piece of text, so camera
 * credentials that ffmpeg echoes in its error messages never reach logs or the status page.
 * @param {string} text
 * @returns {string} the text with each password replaced by `***`
 */
export const maskCredentials = (text) => String(text).replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*):[^\s/@]*@/gi, '$1:***@');
