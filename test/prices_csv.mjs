// Price CSV (Octopus "Period from,Period to,Import,Export" download) -> per-instant arrays.
// "Period from" is UK local wall clock (dd/mm/yyyy HH:MM, no offset), converted with the
// last-Sunday-of-March/October rule; the autumn repeat hour is filled from its BST twin.
const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
function ukLocalToUtc(y, m, d, hh, mm) {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const bstStart = Date.UTC(y, 2, lastSunday(y, 2), 1), bstEnd = Date.UTC(y, 9, lastSunday(y, 9), 1);
  // the repeated autumn hour resolves to its BST instant; the GMT repeat is filled below
  const asBst = naive - 3600000;
  return asBst >= bstStart && asBst < bstEnd ? asBst : naive;
}
export function parsePrices(text) {
  const byUtc = new Map();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [from, , ip, ep] = line.split(',');
    const m = from.match(/^(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d)$/);
    if (!m) throw new Error(`bad Period from: ${from}`);
    const utc = ukLocalToUtc(+m[3], +m[2], +m[1], +m[4], +m[5]);
    byUtc.set(utc, { imp: Number(ip), exp: Number(ep) });
  }
  return byUtc;
}
export function alignPrices(byUtc, instants) {
  const imp = [], exp = [];
  let dstFilled = 0;
  for (const t of instants) {
    let p = byUtc.get(t);
    if (!p) { p = byUtc.get(t - 3600000); if (p) dstFilled++; }   // GMT repeat of the BST hour
    if (!p) throw new Error(`no price for ${new Date(t).toISOString()}`);
    imp.push(p.imp); exp.push(p.exp);
  }
  return { imp, exp, dstFilled };
}

