// Amber-policy keyword guard + per-assignment caps

const DEFAULT_CAP = 500; // per assignment/session limit

export const AMBER_BLOCKLIST = [
  /write\s*(my|the)\s*essay/i,
  /paraphrase\s*to\s*avoid\s*turnitin/i,
  /cheat|bypass|evade\s*(policy|plagiarism)/i,
  /generate\s*references\s*without\s*sources/i,
];

export function checkAmberPolicy(text) {
  for (const rx of AMBER_BLOCKLIST) {
    if (rx.test(text)) {
      return {
        ok: false,
        reason:
          "Your message triggers our amber-policy guard. Please rephrase to comply with assignment rules.",
      };
    }
  }
  return { ok: true };
}

export function isUnderCap(sessionStats) {
  const cap = sessionStats?.cap ?? DEFAULT_CAP;
  const used = sessionStats?.used ?? 0;
  return used < cap;
}
