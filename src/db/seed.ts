import { db } from './index.js';
import { insertInteraction, insertTrr, recordHistory } from './repo.js';
import { uid, type Interaction, type Trr } from '../types.js';

// Realistic-but-fictional seed data exercising every feature: RAG states,
// deactivation + archive countdown, closed/archived TRRs, structured fields,
// official-record tagged notes, and notes long enough for AI summaries.

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const day = (daysAgo: number) => iso(daysAgo).slice(0, 10);

type SeedTrr = Omit<Trr, 'id' | 'num' | 'createdAt' | 'lastContact'> & { createdDaysAgo: number };
type SeedInt = { trr: number; type: Interaction['type']; daysAgo: number; note: string; sensitive?: boolean };

const trrs: SeedTrr[] = [
  { // 0 — green, active lead
    customer: 'Meridian Health Group', title: 'Cloud migration — clinical applications',
    status: 'In Progress', complexity: 'Complex', priority: 'Critical',
    contact: 'Dana Whitfield', rep: 'Chris Alvarez', targetClose: day(-45),
    description: 'Migrate 14 clinical applications from two aging data centers to cloud infrastructure in 3 waves; strict uptime and compliance requirements.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['Cloud', 'Security', 'Compliance'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 40,
  },
  { // 1 — green, POC
    customer: 'Bluewater Logistics', title: 'WAN refresh — 62 depot sites',
    status: 'POC', complexity: 'Complex', priority: 'High',
    contact: 'Marcus Reed', rep: 'Priya Nair', targetClose: day(-60),
    description: 'Replace aging branch routers across 62 depots; dual-uplink design with LTE failover, traffic policies to protect voice. Competing against the incumbent refresh quote.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['Networking'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 55,
  },
  { // 2 — yellow, supporting
    customer: 'Ferrostahl Manufacturing', title: 'OT network segmentation',
    status: 'Evaluation', complexity: 'Medium', priority: 'High',
    contact: 'Ingrid Vollmer', rep: 'Chris Alvarez', targetClose: day(-30),
    description: 'Segment plant-floor systems from the corporate network; identity-based access to maintenance jump hosts for third-party vendors.',
    myRole: 'Supporting', outcome: 'Ongoing', valueThemes: ['Security', 'Networking'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 35,
  },
  { // 3 — red / stalled
    customer: 'Quill & Sable Publishing', title: 'Data-loss prevention for cloud office suite',
    status: 'Waiting Customer', complexity: 'Medium', priority: 'Medium',
    contact: 'Tom Okafor', rep: 'Priya Nair', targetClose: day(-20),
    description: 'API onboarding of their document platform (~9TB content), DLP policies for subscriber PII in shared links. Waiting on security council sign-off.',
    myRole: 'SME', outcome: 'Ongoing', valueThemes: ['Security', 'Compliance'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 50,
  },
  { // 4 — green, new
    customer: 'Northgate Financial', title: 'GenAI usage governance',
    status: 'In Progress', complexity: 'Simple', priority: 'High',
    contact: 'Sofia Marchetti', rep: 'Chris Alvarez', targetClose: day(-75),
    description: 'Visibility and policy on generative-AI tool usage: discover what is in use, allow sanctioned tools with controls, block the rest. Exec-driven initiative.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['AI/ML', 'Security'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 15,
  },
  { // 5 — deactivated, inside archive window
    customer: 'Harborline Ferries', title: 'Fleet connectivity monitoring pilot',
    status: 'Waiting Customer', complexity: 'Simple', priority: 'Low',
    contact: 'Nils Bergman', rep: 'Priya Nair', targetClose: '',
    description: 'Customer went dark after the initial monitoring demo. Deactivated pending re-engagement next budget cycle.',
    myRole: 'Supporting', outcome: 'Stalled', valueThemes: ['Observability'],
    deactivated: true, deactivatedAt: iso(12), createdDaysAgo: 70,
  },
  { // 6 — closed won
    customer: 'Veldt Energy', title: 'Zero-trust access platform',
    status: 'Closed Won', complexity: 'Complex', priority: 'Critical',
    contact: 'Amara Osei', rep: 'Chris Alvarez', targetClose: day(20),
    description: 'Replace legacy VPN with identity-based access for 2,800 remote users across 14 sites. Tech win confirmed after a 3-week POC.',
    myRole: 'Lead', outcome: 'Closed Won', valueThemes: ['Security', 'Identity'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 120,
  },
  { // 7 — closed lost
    customer: 'Copperfield Retail', title: 'Branch firewall refresh',
    status: 'Closed Lost', complexity: 'Simple', priority: 'Low',
    contact: 'Jill Hartman', rep: 'Priya Nair', targetClose: day(35),
    description: 'Lost on price to the incumbent renewal. Door open for a network conversation next fiscal year.',
    myRole: 'Supporting', outcome: 'Closed Lost', valueThemes: ['Other'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 90,
  },
  { // 8 — archived
    customer: 'Aster & Pine Architects', title: 'Secure workspace pilot for contractors',
    status: 'Archived', complexity: 'Simple', priority: 'Low',
    contact: 'Ray Donnelly', rep: 'Chris Alvarez', targetClose: '',
    description: 'Pilot shelved indefinitely after a re-org; archived for future follow-up.',
    myRole: 'SME', outcome: 'Stalled', valueThemes: ['Endpoint'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 140,
  },
  { // 9 — yellow
    customer: 'Tidal Grid Utilities', title: 'Centralized configuration management',
    status: 'In Progress', complexity: 'Medium', priority: 'Medium',
    contact: 'Elena Petrova', rep: 'Priya Nair', targetClose: day(-50),
    description: 'Move device configuration management to a central platform: hierarchy design, shared-policy strategy, config-drift reporting.',
    myRole: 'Lead', outcome: 'Ongoing', valueThemes: ['Automation', 'Networking'],
    deactivated: false, deactivatedAt: '', createdDaysAgo: 28,
  },
];

const ints: SeedInt[] = [
  // Meridian Health (0)
  { trr: 0, type: 'Meeting', daysAgo: 38, note: 'Kickoff with infrastructure + security teams. Current state: 14 clinical apps across two aging data centers, ~4,200 users. Pain: hardware end-of-life, DR gaps, audit findings. Agreed 3-wave migration plan; wave 1 = six low-risk apps.' },
  { trr: 0, type: 'Call', daysAgo: 30, note: 'Architecture review: landing zone design, private connectivity to both DCs during transition, encryption-at-rest requirements from their compliance team, backup/restore targets per app tier.' },
  { trr: 0, type: 'Note', daysAgo: 21, note: 'OFFICIAL update: Wave 1 complete — six applications migrated, helpdesk tickets down 40% vs baseline week. Monitoring dashboards live for the pilot group. Wave 2 (five apps including the scheduling system) now planned.' },
  { trr: 0, type: 'Meeting', daysAgo: 8, note: 'Wave 2 readiness review. Capacity and cost model approved. Security team asked for a quarantine workflow for non-compliant workloads; agreed on a tagging + restricted-network design. Open item: 8% of legacy clients still on an old agent.' },
  { trr: 0, type: 'Chat', daysAgo: 2, note: 'Ping from Dana: wave 2 at 70% complete, smooth. Asked for exec-readout slides for their CIO next week — action on me.' },
  // Bluewater (1)
  { trr: 1, type: 'Meeting', daysAgo: 50, note: 'Discovery: 62 depots on aging routers, circuit costs rising 18% at renewal. Voice-quality complaints at 11 sites. Proposed a 5-site pilot with dual uplinks and LTE failover.' },
  { trr: 1, type: 'POC', daysAgo: 33, note: 'Pilot install day: 3 of 5 depots cut over in one maintenance window. Traffic policies pin voice to the lowest-loss path; bulk traffic on the primary uplink. Zero-touch provisioning worked from staging; one site needed an LTE APN fix.' },
  { trr: 1, type: 'POC', daysAgo: 18, note: 'Pilot week 2 results: voice quality scores improved from 3.1 to 4.2 at the two worst sites. LTE failover tested live — 8s convergence, no dropped calls. Customer network lead impressed.' },
  { trr: 1, type: 'Note', daysAgo: 10, note: 'official: POC formally passed exit criteria (voice score >4.0, failover <15s, zero-touch install at all sites). Commercial proposal for 62 depots submitted; competing against the incumbent renewal. Decision expected end of month.' },
  // Ferrostahl (2)
  { trr: 2, type: 'Meeting', daysAgo: 25, note: 'Segmentation workshop with plant engineering. Mapped 3 vendors needing remote maintenance access. Design: browser-based access to jump hosts, identity from their directory, session recording required by compliance.' },
  { trr: 2, type: 'Email', daysAgo: 12, note: 'Sent reference architecture for vendor access: per-vendor app definitions, time-boxed access windows, no client install. Ingrid reviewing with the steering committee; they asked whether session recordings can export to their SIEM.' },
  { trr: 2, type: 'Call', daysAgo: 6, note: 'Answered the SIEM question (log forwarding of session metadata; recordings stay in the platform). Steering committee meets in two weeks — decision gate for moving to POC.' },
  // Quill & Sable (3)
  { trr: 3, type: 'Meeting', daysAgo: 45, note: 'Scoped the DLP onboarding: document platform via API, ~9TB content. Policy focus: subscriber PII (names, addresses, payment refs) in shared links. Security council must approve the API app registration.' },
  { trr: 3, type: 'Email', daysAgo: 28, note: 'Follow-up on security council review — agenda slipped to next month. Sent a data-handling one-pager and the API permission scopes doc to unblock their review.' },
  { trr: 3, type: 'Email', daysAgo: 9, note: 'Checked in with Tom: council review still pending, now expected in ~3 weeks. No technical blockers on our side; purely governance queue.' },
  // Northgate (4)
  { trr: 4, type: 'Meeting', daysAgo: 14, note: 'Exec sponsor briefing: CISO wants visibility on GenAI usage within 30 days. Plan: discovery first (which AI tools are actually in use), then policy tiers — sanctioned tools allowed with controls, the rest blocked with a guidance page.' },
  { trr: 4, type: 'Call', daysAgo: 7, note: 'Policy design session: 3 tiers — sanctioned assistants allowed with data controls, tolerated developer tools coached, everything else blocked with a custom page linking to the AI usage policy.' },
  { trr: 4, type: 'Note', daysAgo: 1, note: 'OFFICIAL update: discovery dashboard live — found 47 distinct AI tools in the first 48h, 9x what the customer expected. CISO circulated the screenshot internally; strong momentum toward the control phase. [Alex ' + day(1) + ' 14:00 GMT]' },
  // Harborline (5) — deactivated
  { trr: 5, type: 'Demo', daysAgo: 40, note: 'Monitoring demo for the crew-connectivity use case. Positive reception from the IT lead but the budget owner was absent. Promised follow-up with pricing for 300 users.' },
  { trr: 5, type: 'Note', daysAgo: 12, note: '[DEACTIVATED] No response to three follow-ups over four weeks. Deactivating pending their next budget cycle; rep will revisit next quarter.' },
  // Veldt Energy (6) — closed won
  { trr: 6, type: 'POC', daysAgo: 60, note: 'POC exit review: all 9 success criteria met, including a 2,800-user authentication load test against their identity provider and failover between paired regions. Security team signed off on the inspection approach.' },
  { trr: 6, type: 'Note', daysAgo: 32, note: 'official: Tech win confirmed and recorded. Commercials moved to procurement; 3-year term with migration services attached. My role: lead engineer through POC design, execution, and performance objection handling.' },
  { trr: 6, type: 'Note', daysAgo: 20, note: 'official: Deal signed — 2,800 users across 14 sites. Handover call with the deployment team scheduled; I stay on as technical sponsor through wave 1.' },
  // Copperfield (7) — closed lost
  { trr: 7, type: 'Call', daysAgo: 55, note: 'Presented the refresh proposal. Strong technical fit but the incumbent came back with a steep renewal discount. Champion is the IT manager, but the CFO decides on price alone this cycle.' },
  { trr: 7, type: 'Note', daysAgo: 35, note: 'official: Closed lost on price — incumbent renewal at 40% discount. No technical objections raised. Agreed with the rep to re-engage on the wider network refresh when their circuit contract renews next fiscal.' },
  // Aster & Pine (8) — archived
  { trr: 8, type: 'Demo', daysAgo: 130, note: 'Secure-workspace demo for the design-tools team: isolate contractor access to project files without the cost of full virtual desktops. Good fit for their 40-contractor workflow.' },
  { trr: 8, type: 'Note', daysAgo: 95, note: 'Company re-org announced; IT projects frozen. Champion left the org. Archiving — revisit only if they re-engage.' },
  // Tidal Grid (9)
  { trr: 9, type: 'Meeting', daysAgo: 24, note: 'Config-management workshop: 11 device groups today, heavy shared-object sprawl. Proposed a hierarchy mirroring their region/site structure with shared policy sets for the 6 truly-common configs.' },
  { trr: 9, type: 'Call', daysAgo: 11, note: 'Walked through the config-drift report between running configs and the central platform. 23 diffs, mostly logging profiles. Elena wants weekly drift exports during the transition; agreed to schedule via API.' },
  { trr: 9, type: 'Email', daysAgo: 5, note: 'Sent the migration runbook draft: phase 1 read-only visibility, phase 2 policy authoring for one region, phase 3 cutover. Waiting on their change-board date.' },
];

export function seedIfEmpty(): boolean {
  const n = (db.prepare('SELECT count(*) n FROM trrs').get() as { n: number }).n;
  if (n > 0) return false;
  const ids: string[] = [];
  const tx = db.transaction(() => {
    for (const t of trrs) {
      const id = uid() + ids.length;
      ids.push(id);
      insertTrr({
        ...t, id,
        createdAt: iso(t.createdDaysAgo),
        lastContact: '', // set from interactions below
      });
    }
    for (const i of ints) {
      insertInteraction({
        id: uid() + Math.random().toString(36).slice(2, 5),
        trrId: ids[i.trr]!,
        type: i.type, date: day(i.daysAgo), note: i.note,
        aiExec: '', aiCust: '', sensitive: i.sensitive ?? false,
        createdAt: iso(i.daysAgo),
      });
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
  });
  tx();
  console.log(`Seeded ${trrs.length} TRs / ${ints.length} interactions`);
  return true;
}
