// Removes contact details from text before it is sent to the AI provider.
//
// Customer messages pasted into the office often contain a phone number or an email address.
// Joy does not need them to write a reply, so they are replaced with a placeholder before the
// request is stored or sent. Names and street addresses cannot be found reliably by a pattern;
// the office asks staff to remove those before pasting.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Philippine mobile numbers: 09XX XXX XXXX, +63 9XX XXX XXXX, 639XXXXXXXXX (spaces, dots or dashes allowed).
const PH_MOBILE = /(?:\+?63|\b0)[\s.-]?9\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
// Landlines: (02) 8123 4567, 02-8123-4567, (049) 123 4567.
const PH_LANDLINE = /(?:\(0\d{1,3}\)|\b0\d{1,3})[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g;
// Any other international number written with a plus sign: +1 415 555 0100.
const INTL = /\+\d[\d\s.-]{7,16}\d\b/g;

export function redactContacts(text: string): { text: string; count: number } {
  let count = 0;
  const swap = (label: string) => () => {
    count++;
    return label;
  };
  const out = text
    .replace(EMAIL, swap('[email removed]'))
    .replace(PH_MOBILE, swap('[phone removed]'))
    .replace(PH_LANDLINE, swap('[phone removed]'))
    .replace(INTL, swap('[phone removed]'));
  return { text: out, count };
}
