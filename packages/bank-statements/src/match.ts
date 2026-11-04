/**
 * Batch reconciliation: pair statement lines with transactions already in the
 * ledger. One-to-one, greedy by score:
 *   +100 bank reference equals the transaction's externalRef
 *   +40 same day, +20 within 1 day, +10 within 3 days (beyond 3 days: no match)
 *   +5  description shares a merchant word
 * Amounts must be equal to the halala (signed from the account's view).
 */
export interface MatchLine { id: string; date: string; amount: number; reference?: string | null; description?: string }
export interface MatchCandidate { id: string; date: string; amount: number; externalRef?: string | null; merchantName?: string | null }
export interface MatchResult { lineId: string; transactionId: string; score: number }

const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
const words = (s?: string | null) => new Set((s ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

export function matchStatementLines(lines: MatchLine[], candidates: MatchCandidate[], maxDays = 3): MatchResult[] {
  const pairs: MatchResult[] = [];
  for (const l of lines) {
    for (const c of candidates) {
      if (Math.round(l.amount * 100) !== Math.round(c.amount * 100)) continue;
      const d = days(l.date, c.date);
      const refHit = !!l.reference && !!c.externalRef && l.reference === c.externalRef;
      if (d > maxDays && !refHit) continue;
      let score = refHit ? 100 : 0;
      score += d < 0.5 ? 40 : d <= 1 ? 20 : d <= maxDays ? 10 : 0;
      const lw = words(l.description); for (const w of words(c.merchantName)) if (lw.has(w)) { score += 5; break; }
      pairs.push({ lineId: l.id, transactionId: c.id, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.lineId.localeCompare(b.lineId));
  const usedL = new Set<string>(), usedT = new Set<string>(), out: MatchResult[] = [];
  for (const p of pairs) if (!usedL.has(p.lineId) && !usedT.has(p.transactionId)) { usedL.add(p.lineId); usedT.add(p.transactionId); out.push(p); }
  return out;
}
