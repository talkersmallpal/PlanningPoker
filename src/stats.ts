export const UNKNOWN = '?';
export const COFFEE = '☕';

import { config } from './config';

/**
 * Hours = SP x rate, always rounded UP to the next multiple of `step`
 * (HOURS_ROUNDING_STEP, default 0.5h), with a float-error guard.
 * e.g. step 0.5: 21.32 -> 21.5, 20.1 -> 20.5, 20 -> 20; step 1: 21.32 -> 22.
 */
export function ceilHours(sp: number, rate: number, step: number = config.hoursRoundingStep): number {
  const s = Number.isFinite(step) && step > 0 ? step : 0.5;
  const units = Math.ceil(Math.round(((sp * rate) / s) * 1e6) / 1e6);
  return Math.round(units * s * 1e6) / 1e6;
}

/** Jira duration for a number of hours: 32 -> "32h", 2.5 -> "2h 30m", 0.25 -> "15m". */
export function jiraDuration(hours: number): string {
  let whole = Math.floor(hours + 1e-9);
  let min = Math.round((hours - whole) * 60);
  if (min >= 60) { whole += 1; min -= 60; }
  if (!min) return `${whole}h`;
  return whole ? `${whole}h ${min}m` : `${min}m`;
}

/** Jira duration from seconds, rounded to whole minutes: 9000 -> "2h 30m", 1800 -> "30m", 0 -> "0m". */
export function jiraDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.round((Number(seconds) || 0) / 60));
  const h = Math.floor(total / 60), m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Remaining estimate after a new original estimate: max(0, new original - time spent), in Jira duration format. */
export function remainingAfter(hours: number, timeSpentSeconds: number): string {
  return jiraDurationSeconds(Math.max(0, Math.round(hours * 3600) - Math.max(0, Number(timeSpentSeconds) || 0)));
}

export function isNumericCard(v: string): boolean {
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Deck card nearest to value. Ties go up (the higher card). */
export function nearestCard(value: number, deck: string[]): number {
  const numericDeck = deck.filter(isNumericCard).map(Number).sort((a, b) => a - b);
  if (!numericDeck.length) return value;
  return numericDeck.reduce((best, c) => {
    const d = Math.abs(c - value), bd = Math.abs(best - value);
    return d < bd || (d === bd && c > best) ? c : best;
  }, numericDeck[0]);
}

export interface Results {
  /** All vote values, sorted (numeric ascending, then ?, then coffee). No identities. */
  values: string[];
  histogram: { card: string; count: number }[];
  totalVotes: number;
  numericCount: number;
  unknownCount: number;
  coffeeCount: number;
  avg: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  avgHours: number | null;
  medianHours: number | null;
  consensus: 'consensus' | 'close' | 'spread' | 'none';
  suggestedSP: number | null;
}

export function computeResults(votes: string[], rate: number, deck: string[]): Results {
  const numeric = votes.filter(isNumericCard).map(Number).sort((a, b) => a - b);
  const unknownCount = votes.filter((v) => !isNumericCard(v) && v !== COFFEE).length;
  const coffeeCount = votes.filter((v) => v === COFFEE).length;
  const n = numeric.length;
  const avgExact = n ? numeric.reduce((a, b) => a + b, 0) / n : null;
  const median = n ? (n % 2 ? numeric[(n - 1) / 2] : (numeric[n / 2 - 1] + numeric[n / 2]) / 2) : null;
  const min = n ? numeric[0] : null;
  const max = n ? numeric[n - 1] : null;

  const values = [
    ...numeric.map((x) => votes.find((v) => isNumericCard(v) && Number(v) === x) ?? String(x)),
    ...votes.filter((v) => !isNumericCard(v) && v !== COFFEE).sort(),
    ...Array(coffeeCount).fill(COFFEE),
  ];

  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v, (counts.get(v) || 0) + 1);
  const histogram: { card: string; count: number }[] = [];
  for (const card of deck) if (counts.has(card)) histogram.push({ card, count: counts.get(card)! });
  for (const [card, count] of counts) if (!deck.includes(card)) histogram.push({ card, count });

  const numericDeck = deck.filter(isNumericCard).map(Number).sort((a, b) => a - b);
  let consensus: Results['consensus'] = 'none';
  if (n) {
    if (min === max) consensus = 'consensus';
    else {
      const iMin = numericDeck.indexOf(min!);
      const iMax = numericDeck.indexOf(max!);
      consensus = iMin >= 0 && iMax >= 0 && iMax - iMin <= 1 ? 'close' : 'spread';
    }
  }

  // Official suggestion: deck card nearest the median (ties go up). Not a sum or average.
  const suggestedSP = median === null ? null : nearestCard(median, deck);

  return {
    values,
    histogram,
    totalVotes: votes.length,
    numericCount: n,
    unknownCount,
    coffeeCount,
    avg: avgExact === null ? null : round2(avgExact),
    median,
    min,
    max,
    avgHours: avgExact === null ? null : ceilHours(avgExact, rate),
    medianHours: median === null ? null : ceilHours(median, rate),
    consensus,
    suggestedSP,
  };
}

/** Fisher-Yates shuffle (used so any vote ordering never correlates with join/vote order). */
export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
