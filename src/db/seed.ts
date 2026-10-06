import { db } from './index.js';
import {
  getSettings, getTrr, insertInteraction, insertOpportunity, insertTrr, markUpdatePosted,
  recordHistory, saveUpdateDraft, setInteractionLinks,
} from './repo.js';
import { addDays, cycleDueFor, localDay } from '../services/cycle.js';
import { uid, type Interaction, type NewTrr } from '../types.js';

// Realistic-but-fictional seed data exercising every feature: RAG states,
// deactivation + archive countdown, closed/archived TRRs, structured fields,
// official-record tagged notes, and notes long enough for AI summaries.

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const day = (daysAgo: number) => iso(daysAgo).slice(0, 10);

type SeedTrr = Omit<NewTrr, 'id' | 'createdAt' | 'lastContact'> & { createdDaysAgo: number; parent?: number };
type SeedInt = { trr: number; type: Interaction['type']; daysAgo: number; note: string; sensitive?: boolean; also?: number[] };

const trrs: SeedTrr[] = [
  { // 0 — green, active lead
    customer: 'Meridian Health Group', title: 'Prisma Access rollout — 4,200 remote users',
    status: 'In Progress', complexity: 'Complex', priority: 'Critical',
    contact: 'Dana Whitfield', rep: 'Chris Alvarez', targetClose: day(-45),
    description: 'Replace legacy VPN concentrators with Prisma Access Mobile Users; GlobalProtect agent rollout in 3 waves, ADEM for helpdesk triage.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['Prisma Access', 'ADEM', 'ZTNA'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 40,
  },
  { // 1 — green, POC
    customer: 'Bluewater Logistics', title: 'SD-WAN branch refresh — 62 sites',
    status: 'POC', complexity: 'Complex', priority: 'High',
    contact: 'Marcus Reed', rep: 'Priya Nair', targetClose: day(-60),
    description: 'ION 3200 pilot at 5 branches, DIA + LTE failover, path SLA policies for voice. Compete vs incumbent Viptela estate.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['SD-WAN'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 55,
  },
  { // 2 — yellow, supporting
    customer: 'Ferrostahl Manufacturing', title: 'ZTNA segmentation for OT network',
    status: 'Evaluation', complexity: 'Medium', priority: 'High',
    contact: 'Ingrid Vollmer', rep: 'Chris Alvarez', targetClose: day(-30),
    description: 'User-ID based access to SCADA jump hosts; agentless ZTNA for third-party maintenance vendors.',
    myRole: 'Supporting', outcome: 'Ongoing', valueThemes: ['ZTNA'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 35,
  },
  { // 3 — red / stalled
    customer: 'Quill & Sable Publishing', title: 'CASB + DLP for M365 tenant',
    status: 'Waiting Customer', complexity: 'Medium', priority: 'Medium',
    contact: 'Tom Okafor', rep: 'Priya Nair', targetClose: day(-20),
    description: 'SaaS Security API onboarding for SharePoint/OneDrive, DLP policies for PII exfil. Waiting on customer security council sign-off.',
    myRole: 'SME', outcome: 'Ongoing', valueThemes: ['CASB', 'DLP'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 50,
  },
  { // 4 — green, new AI Access
    customer: 'Northgate Financial', title: 'AI Access controls for GenAI tools',
    status: 'In Progress', complexity: 'Simple', priority: 'High',
    contact: 'Sofia Marchetti', rep: 'Chris Alvarez', targetClose: day(-75),
    description: 'Visibility + policy on ChatGPT/Copilot usage; block unsanctioned AI apps, coach sanctioned ones. Exec-driven initiative.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['AI Access', 'DLP'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 15,
  },
  { // 5 — deactivated, inside archive window
    customer: 'Harborline Ferries', title: 'ADEM for crew connectivity',
    status: 'Waiting Customer', complexity: 'Simple', priority: 'Low',
    contact: 'Nils Bergman', rep: 'Priya Nair', targetClose: '',
    description: 'Customer went dark after initial ADEM demo. Deactivated pending re-engagement next budget cycle.',
    myRole: 'Supporting', outcome: 'Stalled', valueThemes: ['ADEM'],
    deactivated: true, deactivatedAt: iso(12), createdDaysAgo: 70,
  },
  { // 6 — closed won
    customer: 'Veldt Energy', title: 'Prisma Access + Panorama migration',
    status: 'Closed Won', complexity: 'Complex', priority: 'Critical',
    contact: 'Amara Osei', rep: 'Chris Alvarez', targetClose: day(20),
    description: 'Full SASE displacement: 2,800 mobile users, 14 RN sites, Panorama-managed. Tech win confirmed after 3-week POC.',
    myRole: 'Lead', outcome: 'Closed Won', valueThemes: ['Prisma Access', 'Panorama'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 120,
  },
  { // 7 — closed lost
    customer: 'Copperfield Retail', title: 'Branch firewall refresh',
    status: 'Closed Lost', complexity: 'Simple', priority: 'Low',
    contact: 'Jill Hartman', rep: 'Priya Nair', targetClose: day(35),
    description: 'Lost on price to incumbent renewal. Door open for SD-WAN conversation next fiscal year.',
    myRole: 'Supporting', outcome: 'Closed Lost', valueThemes: ['Other'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 90,
  },
  { // 8 — archived
    customer: 'Aster & Pine Architects', title: 'Prisma Browser pilot',
    status: 'Archived', complexity: 'Simple', priority: 'Low',
    contact: 'Ray Donnelly', rep: 'Chris Alvarez', targetClose: '',
    description: 'Pilot shelved indefinitely after re-org; archived for future follow-up.',
    myRole: 'SME', outcome: 'Stalled', valueThemes: ['Prisma Browser'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 140,
  },
  { // 9 — yellow, SCM
    customer: 'Tidal Grid Utilities', title: 'Strata Cloud Manager adoption',
    status: 'In Progress', complexity: 'Medium', priority: 'Medium',
    contact: 'Elena Petrova', rep: 'Priya Nair', targetClose: day(-50),
    description: 'Move NGFW config management from Panorama to SCM; folder structure design, snippet strategy, config drift reporting.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['SCM', 'Panorama'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 28,
  },
  // --- v3 hierarchy: child TRs under two parent requests -----------------------
  { // 10 — child of Meridian (0)
    customer: 'Meridian Health Group', title: 'Wave 2 — clinical staff onboarding to Prisma Access',
    status: 'In Progress', complexity: 'Medium', priority: 'High',
    contact: 'Dana Whitfield', rep: 'Chris Alvarez', targetClose: day(-20),
    description: 'Second wave: 1,600 clinical staff incl. shared nursing-station devices; pre-logon and HIP checks for the Mac fleet.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['Prisma Access'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 20, parent: 0,
  },
  { // 11 — child of Meridian (0), quiet this week
    customer: 'Meridian Health Group', title: 'HIP quarantine workflow',
    status: 'New', complexity: 'Medium', priority: 'Medium',
    contact: 'Dana Whitfield', rep: 'Chris Alvarez', targetClose: day(-40),
    description: 'Security team request from the wave 2 readiness review: quarantine list + restricted access policy for endpoints failing HIP.',
    myRole: 'SME', outcome: 'Ongoing', valueThemes: ['Prisma Access'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 8, parent: 0,
  },
  { // 12 — child of Bluewater (1)
    customer: 'Bluewater Logistics', title: 'LTE failover design — ION cellular',
    status: 'POC', complexity: 'Medium', priority: 'High',
    contact: 'Marcus Reed', rep: 'Priya Nair', targetClose: day(-50),
    description: 'Carrier selection, APN design and path-policy thresholds for the cellular backup circuit on the ION devices at all 62 depots.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['SD-WAN'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 30, parent: 1,
  },
];

// TR IDs from the (fictional) upstream request system.
const extIds: Record<number, string> = {
  0: 'TR-10421', 1: 'TR-10388', 2: 'TR-10455', 3: 'TR-10302', 4: 'TR-10517', 5: 'TR-10277',
  6: 'TR-10115', 7: 'TR-10164', 8: 'TR-10050', 9: 'TR-10490', 10: 'TR-10422', 11: 'TR-10423', 12: 'TR-10389',
};

// Opportunities: `trr` names the TR whose customer owns it; `members` are the
// top-level TRs placed in it (children follow their parent automatically).
const opps: { trr: number; name: string; stage: string; rep: string; closeDaysAhead: number; members: number[] }[] = [
  { trr: 0, name: 'Prisma Access — clinical workforce', stage: 'Technical validation', rep: 'Chris Alvarez', closeDaysAhead: 45, members: [0] },
  { trr: 1, name: 'Prisma SD-WAN depot refresh', stage: 'Proposal', rep: 'Priya Nair', closeDaysAhead: 60, members: [1] },
  { trr: 6, name: 'SASE migration FY26', stage: 'Closed Won', rep: 'Chris Alvarez', closeDaysAhead: -20, members: [6] },
];

// Updates posted LAST cycle, so the desk shows "since last update" next to overdue ones.
const postedLastCycle: { trr: number; text: string }[] = [
  { trr: 4, text: '-Status: In Progress\n-Activity: CISO briefing held; AI Access discovery first, then sanctioned / tolerated / blocked policy tiers.\n-Next: policy design session' },
  { trr: 10, text: '-Status: In Progress\n-Activity: Wave 2 scoped — 1,600 clinical staff; pre-logon + HIP plan for the Mac fleet agreed.\n-Next: onboarding runbook review' },
];

const ints: SeedInt[] = [
  // Meridian Health (0)
  { trr: 0, type: 'Meeting', daysAgo: 38, note: 'Kickoff with network + security teams. Current state: 6 ASA VPN concentrators at 2 DCs, ~4,200 remote users, split tunnel disabled so all traffic hairpins through DC. Pain: latency for M365, no visibility per-app. Agreed 3-wave GlobalProtect rollout plan; wave 1 = IT + pilot group (200 users).' },
  { trr: 0, type: 'Call', daysAgo: 30, note: 'Design review of Mobile Users config: 2 PA locations (us-east, us-central), split tunnel with M365 exclusions per Microsoft guidance, HIP checks for disk encryption + EDR presence before granting finance-app access.' },
  { trr: 0, type: 'Note', daysAgo: 21, note: 'SFDC update: Wave 1 complete — 212 users migrated, helpdesk tickets down 40% vs VPN baseline week. ADEM licensed and deployed to pilot; two Wi-Fi-related issues resolved using ADEM self-serve data. Wave 2 (1,800 users) scheduled.' },
  { trr: 0, type: 'Meeting', daysAgo: 8, note: 'Wave 2 readiness review. Capacity check on portal/gateway sizing passed. Customer security team asked for quarantine workflow for failed HIP: agreed on quarantine list + restricted access policy design. Open item: Mac fleet at 8% still on old agent version.', also: [10, 11] },
  { trr: 0, type: 'Chat', daysAgo: 2, note: 'Slack ping from Dana: wave 2 at 70% complete, smooth. Asked for exec-readout slides for their CIO next week — action on me.' },
  // Bluewater (1)
  { trr: 1, type: 'Meeting', daysAgo: 50, note: 'Discovery: 62 branches on aging ISR + Viptela mix, MPLS costs rising 18% at renewal. Voice quality complaints at 11 sites. Proposed ION 3200 pilot at 5 representative branches with DIA primary + LTE failover.' },
  { trr: 1, type: 'POC', daysAgo: 33, note: 'Pilot install day: 3 of 5 branches cut over in one maintenance window. Path policies: voice pinned to lowest-loss path, bulk traffic on DIA. Zero-touch provisioning worked from staging; one site needed LTE APN fix.' },
  { trr: 1, type: 'POC', daysAgo: 18, note: 'Pilot week 2 results: voice MOS improved from 3.1 to 4.2 at the two worst sites, measured via app SLA dashboards. LTE failover tested live — 8s convergence, no dropped calls on SIP re-register. Customer network lead impressed.' },
  { trr: 1, type: 'Note', daysAgo: 10, note: 'sfdc: POC formally passed exit criteria (voice MOS >4.0, failover <15s, ZTP for all installs). Commercial proposal for 62 sites submitted; competing against incumbent renewal quote. Decision expected end of month.' },
  // Ferrostahl (2)
  { trr: 2, type: 'Meeting', daysAgo: 25, note: 'OT segmentation workshop with plant engineering. Mapped 3 SCADA vendors needing remote maintenance access. Design: agentless ZTNA browser access to jump hosts, User-ID from their AD, session recording requirement raised by compliance.' },
  { trr: 2, type: 'Email', daysAgo: 12, note: 'Sent reference architecture for vendor access: per-vendor app definitions, time-boxed access windows, no client install. Ingrid reviewing with OT steering committee; they asked whether session recording can export to their SIEM.' },
  { trr: 2, type: 'Call', daysAgo: 6, note: 'Answered SIEM export question (syslog forward of session metadata; full recording stays in tenant). Steering committee meets in two weeks — decision gate for moving to POC.' },
  // Quill & Sable (3)
  { trr: 3, type: 'Meeting', daysAgo: 45, note: 'Scoped CASB onboarding for M365: SharePoint + OneDrive via SaaS Security API, ~9TB content. DLP focus: subscriber PII (names, addresses, payment refs) in shared links. Security council must approve API app registration.' },
  { trr: 3, type: 'Email', daysAgo: 28, note: 'Follow-up on security council review — agenda slipped to next month. Sent data-handling one-pager and API permission scopes doc to unblock their review.' },
  { trr: 3, type: 'Email', daysAgo: 9, note: 'Checked in with Tom: council review still pending, now expected in ~3 weeks. No technical blockers on our side; purely governance queue.' },
  // Northgate (4)
  { trr: 4, type: 'Meeting', daysAgo: 14, note: 'Exec sponsor briefing: CISO wants visibility on GenAI usage within 30 days. Plan: enable AI Access visibility first (discover ChatGPT/Copilot/Claude usage), then coach-mode policies for sanctioned tools, block for the rest. No agent changes needed — existing PA tenant.' },
  { trr: 4, type: 'Call', daysAgo: 7, note: 'Policy design session: 3 tiers — sanctioned (Copilot, enterprise ChatGPT) allowed with DLP inline, tolerated (coding assistants) coached, everything else blocked with custom response page linking to AI usage policy.' },
  { trr: 4, type: 'Note', daysAgo: 1, note: 'SFDC update: visibility dashboard live — discovered 47 distinct AI apps in first 48h, 9x what the customer expected. CISO circulated screenshot internally; strong momentum toward the control phase. [Shane ' + day(1) + ' 14:00 GMT]' },
  // Harborline (5) — deactivated
  { trr: 5, type: 'Demo', daysAgo: 40, note: 'ADEM demo for crew Wi-Fi troubleshooting use case. Positive reception from IT lead but budget owner absent. Promised follow-up with pricing for 300 users.' },
  { trr: 5, type: 'Note', daysAgo: 12, note: '[DEACTIVATED] No response to three follow-ups over four weeks. Deactivating pending their next budget cycle; rep will revisit in Q1.' },
  // Veldt Energy (6) — closed won
  { trr: 6, type: 'POC', daysAgo: 60, note: 'POC exit review: all 9 success criteria met, including 2,800-user auth load test against their Azure AD and RN failover between paired PA locations. Security team signed off on decryption policy approach.' },
  { trr: 6, type: 'Note', daysAgo: 32, note: 'sfdc: Tech win confirmed and recorded. Commercials moved to procurement; 3-year term, Panorama migration services attached. My role: lead SE through POC design, execution, and objection handling on decryption performance.' },
  { trr: 6, type: 'Note', daysAgo: 20, note: 'sfdc: Deal signed. 2,800 MU + 14 RN sites. Handover call with deployment team scheduled; I stay on as technical sponsor through wave 1.' },
  // Copperfield (7) — closed lost
  { trr: 7, type: 'Call', daysAgo: 55, note: 'Presented branch refresh proposal. Strong technical fit but incumbent came back with steep renewal discount. Champion is IT manager, but CFO decides on price alone this cycle.' },
  { trr: 7, type: 'Note', daysAgo: 35, note: 'sfdc: Closed lost on price — incumbent renewal at 40% discount. No technical objections raised. Agreed with rep to re-engage on SD-WAN when their MPLS contract renews next fiscal.' },
  // Aster & Pine (8) — archived
  { trr: 8, type: 'Demo', daysAgo: 130, note: 'Prisma Browser demo to design-tools team: isolate contractor access to project files without VDI cost. Good fit for their 40-contractor workflow.' },
  { trr: 8, type: 'Note', daysAgo: 95, note: 'Company re-org announced; IT projects frozen. Champion left the org. Archiving — revisit only if they re-engage.' },
  // Tidal Grid (9)
  { trr: 9, type: 'Meeting', daysAgo: 24, note: 'SCM adoption workshop: current Panorama has 11 device groups, heavy shared-object sprawl. Proposed folder design mirroring their region/site hierarchy, snippets for the 6 truly-shared policy sets. Flagged that folder-scoped objects cannot be referenced from custom snippets — shapes the design.' },
  { trr: 9, type: 'Call', daysAgo: 11, note: 'Walked through config drift report between Panorama running config and SCM candidate. 23 diffs, mostly log-forwarding profiles. Elena wants weekly drift exports during transition; agreed to schedule via API.' },
  { trr: 9, type: 'Email', daysAgo: 5, note: 'Sent migration runbook draft: phase 1 read-only SCM visibility, phase 2 policy authoring in SCM for one region, phase 3 cutover. Waiting on their change board date.' },
  // Meridian wave 2 (10)
  { trr: 10, type: 'Meeting', daysAgo: 6, note: 'Wave 2 onboarding runbook review: nursing-station shared devices get pre-logon, Mac fleet agent upgrade pushed via MDM before cutover. Two clinics need split-tunnel exceptions for the imaging app.' },
  { trr: 10, type: 'Call', daysAgo: 2, note: 'First 600 clinical users live on Prisma Access, 0 sev-1s. One HIP false positive on an older macOS build — profile adjusted. Remaining 1,000 next week.' },
  // Meridian HIP quarantine (11) — only the linked readiness-review note; nothing new this week
  // Bluewater LTE (12)
  { trr: 12, type: 'POC', daysAgo: 15, note: 'Compared two carriers at the pilot depots: carrier B had better signal at 4 of 5 sites. Private APN with per-depot static addressing on the ION cellular interface.' },
  { trr: 12, type: 'Email', daysAgo: 3, note: 'Sent path-policy thresholds: fail to LTE after 3 lost probes at 1s, fail back after 60s stable; voice pinned to lowest-loss path. Marcus checking against their voice SLA.' },
];

export function seedIfEmpty(): boolean {
  const n = (db.prepare('SELECT count(*) n FROM trrs').get() as { n: number }).n;
  if (n > 0) return false;
  const ids: string[] = [];
  const tx = db.transaction(() => {
    for (const [n, t] of trrs.entries()) {
      const id = uid() + ids.length;
      ids.push(id);
      const { parent, ...fields } = t;
      insertTrr({
        ...fields, id, externalId: extIds[n] ?? '',
        parentId: parent !== undefined ? ids[parent] : '',
        createdAt: iso(t.createdDaysAgo),
        lastContact: '', // set from interactions below
      });
    }
    for (const i of ints) {
      const iid = uid() + Math.random().toString(36).slice(2, 5);
      insertInteraction({
        id: iid,
        trrId: ids[i.trr]!,
        type: i.type, date: day(i.daysAgo), note: i.note,
        aiExec: '', aiCust: '', sensitive: i.sensitive ?? false,
        createdAt: iso(i.daysAgo),
      });
      if (i.also) setInteractionLinks(iid, i.also.map(n => ids[n]!));
    }
    // Opportunities (children follow their parent's opportunity on save).
    for (const o of opps) {
      const owner = getTrr(ids[o.trr]!)!;
      const opp = insertOpportunity({
        customerId: owner.customerId, name: o.name, stage: o.stage, rep: o.rep,
        closeDate: day(-o.closeDaysAhead), notes: '', createdAt: iso(60),
      });
      for (const m of o.members) {
        db.prepare('UPDATE trrs SET opportunity_id = ? WHERE id = ? OR parent_id = ?').run(opp.id, ids[m], ids[m]);
      }
    }
    // Last cycle's posted updates.
    const prevDue = addDays(cycleDueFor(localDay(), getSettings().updateDueWeekday), -7);
    for (const u of postedLastCycle) {
      const at = new Date(`${prevDue}T16:00:00`).toISOString();
      const row = saveUpdateDraft({
        trrId: ids[u.trr]!, cycleDue: prevDue, windowFrom: iso(14), windowTo: at, interactions: 1, text: u.text, model: '',
      });
      markUpdatePosted(row.id, at);
    }
    // last_contact = most recent interaction date per TRR
    for (const id of ids) {
      const last = db.prepare('SELECT max(date) d FROM interactions WHERE trr_id = ?').get(id) as { d: string | null };
      if (last.d) db.prepare('UPDATE trrs SET last_contact = ? WHERE id = ?').run(last.d, id);
    }
    // Audit-trail history showing how projects shifted over time.
    // (insertTrr already recorded a 'created' entry at createdAt.)
    const h = (idx: number, daysAgo: number, field: string, oldV: string, newV: string) =>
      recordHistory(ids[idx]!, field, oldV, newV, iso(daysAgo));
    h(0, 36, 'status', 'New', 'In Progress');
    h(0, 30, 'complexity', 'Medium', 'Complex');
    h(1, 45, 'status', 'New', 'In Progress');
    h(1, 35, 'status', 'In Progress', 'POC');
    h(1, 33, 'complexity', 'Medium', 'Complex');
    h(2, 24, 'status', 'New', 'Evaluation');
    h(3, 44, 'status', 'New', 'In Progress');
    h(3, 27, 'status', 'In Progress', 'Waiting Customer');
    h(4, 13, 'status', 'New', 'In Progress');
    h(4, 7, 'value themes', 'AI Access', 'AI Access, DLP');
    h(5, 39, 'status', 'New', 'Waiting Customer');
    h(5, 12, 'deactivation', 'active', 'deactivated');
    h(5, 12, 'outcome', 'Ongoing', 'Stalled');
    h(6, 100, 'status', 'New', 'In Progress');
    h(6, 75, 'status', 'In Progress', 'POC');
    h(6, 55, 'priority', 'High', 'Critical');
    h(6, 32, 'outcome', 'Ongoing', 'Tech Win');
    h(6, 20, 'status', 'POC', 'Closed Won');
    h(6, 20, 'outcome', 'Tech Win', 'Closed Won');
    h(7, 50, 'status', 'New', 'In Progress');
    h(7, 35, 'status', 'In Progress', 'Closed Lost');
    h(7, 35, 'outcome', 'Ongoing', 'Closed Lost');
    h(8, 110, 'status', 'New', 'Evaluation');
    h(8, 90, 'status', 'Evaluation', 'Archived');
    h(9, 22, 'status', 'New', 'In Progress');
    // Track what we seeded so "Remove demo data" can surgically delete it later.
    db.prepare(`INSERT INTO settings (key, value) VALUES ('_seedTrrIds', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(ids));
    const custIds = [...new Set(ids.map(id => getTrr(id)!.customerId))];
    db.prepare(`INSERT INTO settings (key, value) VALUES ('_seedCustomerIds', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(custIds));
  });
  tx();
  console.log(`Seeded ${trrs.length} TRs / ${ints.length} interactions`);
  return true;
}
