/**
 * Body areas, severity levels, outcome routing and first-aid guidance.
 *
 * Wording is deliberately first-aid guidance and escalation advice, never a
 * diagnosis: the app routes the rider to the right kind of help, it doesn't
 * tell them what is wrong.
 */
import type { AffectedArea, BodyPart, OutcomePath, Severity } from './types';

export const BODY_PART_LABELS: Record<BodyPart, string> = {
  head: 'Head / face',
  neck: 'Neck',
  chest: 'Chest',
  abdomen: 'Stomach',
  upper_back: 'Upper back',
  lower_back: 'Lower back',
  pelvis: 'Hips / pelvis',
  left_arm: 'Left arm',
  right_arm: 'Right arm',
  left_hand: 'Left hand / wrist',
  right_hand: 'Right hand / wrist',
  left_leg: 'Left leg / knee',
  right_leg: 'Right leg / knee',
  left_foot: 'Left foot / ankle',
  right_foot: 'Right foot / ankle',
};

export const SEVERITY_INFO: Record<Severity, { label: string; emoji: string; description: string }> = {
  minor: {
    label: 'Minor',
    emoji: '🟢',
    description: 'Scrape, bruise, mild pain',
  },
  moderate: {
    label: 'Moderate',
    emoji: '🟡',
    description: 'Can move but it hurts a lot, swelling, possible sprain or break',
  },
  severe: {
    label: 'Severe',
    emoji: '🔴',
    description: "Can't move it, heavy bleeding, or someone saw you pass out",
  },
};

const RANK: Record<Severity, number> = { minor: 0, moderate: 1, severe: 2 };

export function highestSeverity(areas: Pick<AffectedArea, 'severity'>[]): Severity {
  return areas.reduce<Severity>((max, a) => (RANK[a.severity] > RANK[max] ? a.severity : max), 'minor');
}

export function outcomeFor(severity: Severity): OutcomePath {
  return severity === 'severe' ? 'emergency' : severity === 'moderate' ? 'hospital' : 'first_aid';
}

export const OUTCOME_LABELS: Record<OutcomePath, string> = {
  first_aid: 'First aid',
  hospital: 'Nearby hospital',
  emergency: 'Emergency call',
};

export type FirstAidCard = { title: string; steps: string[] };

const GENERAL: FirstAidCard = {
  title: 'Scrapes and small cuts',
  steps: [
    'Move somewhere safe, away from traffic, before anything else.',
    'Rinse the wound with clean drinking water to remove grit.',
    'Apply antiseptic and cover with a clean dressing or plaster.',
    'Press firmly with a clean cloth if it is bleeding. Most small cuts stop within 10 minutes.',
  ],
};

const BRUISE: FirstAidCard = {
  title: 'Bruises and knocks',
  steps: [
    'Rest the area and avoid putting weight on it for now.',
    'Apply a cold pack wrapped in cloth for 15–20 minutes. Never put ice directly on skin.',
    'Raise the limb above heart level if you can.',
    'Check it again over the next few hours for swelling or pain that gets worse.',
  ],
};

const HEAD: FirstAidCard = {
  title: 'Knock to the head',
  steps: [
    'Any hit to the head in a crash should be checked by a doctor today, even with a helmet on and even if you feel fine.',
    'Do not ride home. Ask someone to pick you up.',
    'Sit somewhere safe and have someone stay with you for the next few hours.',
    'Leave the helmet on if your neck hurts. Let a professional remove it.',
  ],
};

export function firstAidCardsFor(areas: AffectedArea[]): FirstAidCard[] {
  const parts = new Set(areas.map((a) => a.bodyPart));
  const cards: FirstAidCard[] = [];
  if (parts.has('head') || parts.has('neck')) cards.push(HEAD);
  cards.push(GENERAL, BRUISE);
  return cards;
}

/** Signs that mean "stop self-treating and get help": shown on every first-aid card. */
export const ESCALATE_IF = [
  'Headache that gets worse, vomiting, confusion or unusual sleepiness',
  'Numbness, tingling or weakness in arms or legs',
  "Bleeding that hasn't stopped after 10 minutes of firm pressure",
  "You can't put weight on a leg or move a joint",
  'Pain in the chest or stomach, or trouble breathing',
];
