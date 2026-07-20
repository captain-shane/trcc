// Domain model for TRs (Technical Requests). Replaces v1's terse {t:[],i:[]}
// JSON blobs with named, typed shapes. Structured fields (myRole/outcome/
// valueThemes) are first-class so role attribution never has to be
// reconstructed from freetext again.
//
// The taxonomies below are DEFAULTS — the live lists (statuses, roles,
// outcomes, themes, which statuses count as closed) are user-editable in
// Settings, so field values are plain strings.

export const DEFAULT_STATUSES = [
  'New', 'In Progress', 'Waiting Customer', 'Waiting Internal',
  'POC', 'Evaluation', 'Closed Won', 'Closed Lost', 'Archived',
];

export const COMPLEXITIES = ['Simple', 'Medium', 'Complex'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INTERACTION_TYPES = [
  'Call', 'Email', 'Meeting', 'Chat', 'Note', 'Demo', 'POC', 'Other',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export const DEFAULT_ROLES = ['Lead', 'Supporting', 'SME', 'POST'];

export const DEFAULT_OUTCOMES = [
  'Ongoing', 'Tech Win', 'POC Complete', 'Closed Won', 'Closed Lost', 'Stalled',
];

export const DEFAULT_THEMES = [
  'Cloud', 'Networking', 'Security', 'Identity', 'Data & Analytics', 'AI/ML',
  'Observability', 'Automation', 'Integration', 'Compliance', 'Endpoint', 'Other',
];

export const DEFAULT_CLOSED_STATUSES = ['Closed Won', 'Closed Lost', 'Archived'];
export const DEFAULT_ARCHIVED_STATUS = 'Archived';

export interface Trr {
  id: string;
  num: number;           // short human-friendly handle (#1, #42), auto-assigned
  customer: string;
  title: string;
  status: string;        // domain = settings.statuses (user-editable)
  complexity: Complexity;
  priority: Priority;
  contact: string;
  rep: string;
  targetClose: string;   // ISO date or ''
  description: string;
  myRole: string;        // domain = settings.roles
  outcome: string;       // domain = settings.outcomes
  valueThemes: string[]; // multi-select — domain = settings.themes
  deactivated: boolean;
  deactivatedAt: string; // ISO datetime or ''
  createdAt: string;     // ISO datetime
  lastContact: string;   // ISO date or ''
}

export interface Interaction {
  id: string;
  trrId: string;
  type: InteractionType;
  date: string;          // ISO date
  note: string;
  aiExec: string;        // generated exec summary ('' = none yet)
  aiCust: string;        // generated customer-facing version
  sensitive: boolean;
  createdAt: string;
}

export interface StoredDigest {
  trrId: string;
  customer: string;
  title: string;
  status: string;
  interactions: number;
  first: string;
  last: string;
  summary: string;
  model: string;
  generatedAt: string;
}

export interface TrrHistoryEntry {
  id: number;
  trrId: string;
  changedAt: string;
  field: string;
  oldValue: string;
  newValue: string;
}

export interface Settings {
  greenDays: number;     // last contact <= N days => green
  yellowDays: number;    // <= N days => yellow, else red
  archiveDays: number;   // deactivation-to-archive window
  autoBackfillHours: number; // run an exec-summary backfill batch every N hours (0 = off)
  aiEnabled: boolean;    // global AI switch — off = fully usable without any local model server
  statuses: string[];        // editable taxonomy
  closedStatuses: string[];  // which statuses mean "closed" (archive tab, health)
  archivedStatus: string;    // entering this status triggers the auto-digest
  roles: string[];           // editable taxonomy ("my role")
  outcomes: string[];        // editable taxonomy
  themes: string[];          // editable taxonomy (value themes)
  officialTag: string;       // notes containing this word count as the "official record"
  model: string;         // fast model: per-note exec summaries
  digestModel: string;   // quality model: digests / reports
  embedModel: string;    // embedding model: semantic search
  custTmpl: string;
  execTmpl: string;
  evalTmpl: string;
  trrDigestTmpl: string;
  reviewTmpl: string;
}

export type Rag = 'green' | 'yellow' | 'red';

export function rag(lastContact: string, s: Settings): Rag {
  if (!lastContact) return 'red';
  const days = Math.floor((Date.now() - new Date(lastContact).getTime()) / 86_400_000);
  return days <= s.greenDays ? 'green' : days <= s.yellowDays ? 'yellow' : 'red';
}

export function daysSince(date: string): number {
  if (!date) return 999;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
