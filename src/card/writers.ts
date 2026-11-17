// The order of Pathix's confidence tiers, for ordering the hover card's writer
// rows: the strongest tier first, a tier the extension does not know last.
// The card and X-ray read the same rows with the rules in model.ts and xray.ts.

export const TIERS: Array<{ value: string; label: string }> = [
  { value: "Declared", label: "Declared" },
  { value: "Parsed", label: "Parsed" },
  { value: "Observed", label: "Observed" },
  { value: "AiDerived", label: "AI-derived (unverified)" },
  { value: "Low", label: "Low" },
  { value: "Unresolved", label: "Unresolved" },
];

export function tierRank(tier: string): number {
  const index = TIERS.findIndex((candidate) => candidate.value === tier);
  return index === -1 ? TIERS.length : index;
}
