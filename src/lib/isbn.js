/**
 * A real ISBN, without hyphens, or `undefined`. Shops put their own product numbers in the ISBN field
 * (Storytel's audiobooks: "0408311111451"); only a number whose check digit holds is kept.
 */
function validIsbn(value) {
  const digits = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (/^97[89]\d{10}$/.test(digits)) {
    const sum = [...digits].reduce((acc, d, i) => acc + Number(d) * (i % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? digits : undefined;
  }
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((acc, d, i) => acc + (d === 'X' ? 10 : Number(d)) * (10 - i), 0);
    return sum % 11 === 0 ? digits : undefined;
  }
  return undefined;
}

module.exports = { validIsbn };
