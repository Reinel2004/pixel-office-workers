/**
 * Takes the ready-to-send message from Joy's answer (the "Reply" section), without the
 * "Notes for staff". Fills in [Customer name] when the office knows the name.
 */
export function replyFrom(answer: string, customer?: string | null): string {
  const m = answer.match(/\*\*\s*Reply\s*\*\*:?\s*\n?([\s\S]*?)(?=\n\s*\*\*[^*\n]+\*\*|$)/i);
  const text = (m ? m[1] : answer).replace(/\*\*/g, '').trim();
  return customer ? text.replace(/\[Customer name\]/gi, customer) : text;
}

/** When Carlo was asked for a posting time: "now", or a Manila date and time. Checked again by code. */
export type PostWhen = { kind: 'now' } | { kind: 'at'; date: string; time: string };

/** Reads Carlo's "**Schedule:** YYYY-MM-DD HH:MM" (or "now") line; null when there is none or it is malformed. */
export function scheduleFrom(answer: string): PostWhen | null {
  const m = answer.match(/\*\*\s*Schedule\s*:?\s*\*\*\s*:?\s*(now|(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2}))\s*$/im);
  if (!m) return null;
  if (m[1].toLowerCase() === 'now') return { kind: 'now' };
  const [y, mo, d] = m[2].split('-').map(Number);
  const h = Number(m[3]);
  const mi = Number(m[4]);
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return { kind: 'at', date: m[2], time: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

/**
 * Takes the Facebook post from Carlo's answer: the "Caption" section plus "Hashtags", without
 * the "What I see" notes or the "Short version". Falls back to the whole answer without
 * Markdown (and without "What I see") when there are no sections.
 */
export function captionFrom(answer: string): string {
  const clean = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*•]\s+/, '').replace(/\*\*/g, '').trimEnd())
      .join('\n')
      .trim();
  const section = (name: string) => {
    const m = answer.match(new RegExp(`\\*\\*\\s*${name}\\s*\\*\\*:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*\\*\\*[^*\\n]+\\*\\*|$)`, 'i'));
    return m ? clean(m[1]) : '';
  };
  const caption = section('Caption');
  // Only the hashtags themselves: any note Carlo adds after them ("Ready for your approval")
  // must never end up in the post.
  const tags = [...new Set(section('Hashtags').match(/#[\p{L}\p{N}_]+/gu) ?? [])].join(' ');
  if (caption) return tags ? `${caption}\n\n${tags}` : caption;
  return clean(answer.replace(/\*\*\s*What I see\s*\*\*[\s\S]*?(?=\n\s*\*\*[^*\n]+\*\*|$)/i, '').replace(/^.*\*\*\s*Schedule\b.*$/gim, ''));
}
