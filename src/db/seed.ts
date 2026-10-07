import { db } from './index.js';
import { runSeed, type SeedStory } from './seedEngine.js';

// Demo data — the vendor-neutral flavor. A fictional book of business told in
// relative days (so it is always "current"), exercising every feature:
// customers -> opportunities -> parent TRs -> child TRs, the full health
// spread, project-management notes on parents, flagged and linked logs, an
// applied import, four weekly cycles of updates (posted / draft / missing),
// versioned summaries, digests for closed work, a saved period report, and an
// audit trail with status changes, an opportunity move, a rename and stage
// changes. The engine (seedEngine.ts) is shared by both flavors.

const story: SeedStory = {
  customerNotes: {
    'Meridian Health Group': 'Regional hospital network, 9 sites. CIO sponsor: Dana Whitfield. Change board meets Tuesdays.',
    'Bluewater Logistics': 'Freight and depot operator, 62 depots. Network team of 4; Marcus Reed is the lead.',
    'Northgate Financial': 'Mid-size bank. Security reports to the CRO; exec-driven GenAI initiative.',
  },

  opps: [
    { key: 'mer-cloud', customer: 'Meridian Health Group', name: 'Clinical cloud program FY27', stage: 'Technical validation', rep: 'Chris Alvarez', closeDaysAhead: 75, createdDaysAgo: 125,
      stageHistory: [[95, 'Discovery', 'Solution design'], [52, 'Solution design', 'Technical validation']] },
    { key: 'mer-id', customer: 'Meridian Health Group', name: 'Identity modernization', stage: 'Discovery', rep: 'Chris Alvarez', closeDaysAhead: 140, createdDaysAgo: 24 },
    { key: 'blu-wan', customer: 'Bluewater Logistics', name: 'Depot WAN refresh', stage: 'Proposal', rep: 'Priya Nair', closeDaysAhead: 45, createdDaysAgo: 95,
      stageHistory: [[60, 'Discovery', 'Technical validation'], [14, 'Technical validation', 'Proposal']], renamedFrom: [70, 'Depot network refresh'] },
    { key: 'blu-obs', customer: 'Bluewater Logistics', name: 'Fleet telemetry observability', stage: 'Discovery', rep: 'Priya Nair', closeDaysAhead: 120, createdDaysAgo: 30 },
    { key: 'fer-ot', customer: 'Ferrostahl Manufacturing', name: 'Plant OT security', stage: 'Technical validation', rep: 'Chris Alvarez', closeDaysAhead: 60, createdDaysAgo: 80,
      stageHistory: [[40, 'Discovery', 'Technical validation']] },
    { key: 'nor-ai', customer: 'Northgate Financial', name: 'GenAI governance', stage: 'Solution design', rep: 'Chris Alvarez', closeDaysAhead: 50, createdDaysAgo: 48,
      stageHistory: [[20, 'Discovery', 'Solution design']] },
    { key: 'nor-id', customer: 'Northgate Financial', name: 'Workforce identity refresh', stage: 'Proposal', rep: 'Chris Alvarez', closeDaysAhead: 35, createdDaysAgo: 40 },
    { key: 'qui-dlp', customer: 'Quill & Sable Publishing', name: 'Cloud data protection', stage: 'Technical validation', rep: 'Priya Nair', closeDaysAhead: 20, createdDaysAgo: 60 },
    { key: 'tid-auto', customer: 'Tidal Grid Utilities', name: 'Network automation', stage: 'Solution design', rep: 'Priya Nair', closeDaysAhead: 90, createdDaysAgo: 65 },
    { key: 'har-mon', customer: 'Harborline Ferries', name: 'Fleet connectivity', stage: 'Discovery', rep: 'Chris Alvarez', closeDaysAhead: 30, createdDaysAgo: 50 },
    { key: 'cop-fw', customer: 'Copperfield Retail', name: 'Store firewall refresh', stage: 'Closed lost', rep: 'Priya Nair', closeDaysAhead: -40, createdDaysAgo: 110 },
    { key: 'cop-pos', customer: 'Copperfield Retail', name: 'POS network segmentation', stage: 'Discovery', rep: 'Priya Nair', closeDaysAhead: 100, createdDaysAgo: 6 },
    { key: 'ast-ws', customer: 'Aster & Pine Architects', name: 'Secure contractor workspace', stage: 'Closed lost', rep: 'Chris Alvarez', closeDaysAhead: -90, createdDaysAgo: 150 },
    { key: 'vel-cc', customer: 'Veldt Energy', name: 'Control-center modernization', stage: 'Closed won', rep: 'Chris Alvarez', closeDaysAhead: -25, createdDaysAgo: 200 },
    { key: 'kes-lz', customer: 'Kestrel Aerospace', name: 'Engineering cloud landing zone', stage: 'Discovery', rep: 'Priya Nair', closeDaysAhead: 160, createdDaysAgo: 5 },
  ],

  trs: [
    // --- Meridian: clinical cloud program (parent + 4 children) ---
    { key: 'mer-p', customer: 'Meridian Health Group', opp: 'mer-cloud', title: 'Clinical cloud program FY27', status: 'In Progress', complexity: 'Complex', priority: 'Critical',
      contact: 'Dana Whitfield', rep: 'Chris Alvarez', targetCloseDaysAhead: 75, myRole: 'Lead', outcome: 'Ongoing', themes: ['Cloud', 'Security', 'Compliance'], createdDaysAgo: 120,
      description: 'Program parent: move 14 clinical applications out of two aging data centers in three waves. Holds assignment timing, resourcing and cross-wave notes.',
      history: [[118, 'status', 'New', 'In Progress'], [90, 'priority', 'High', 'Critical']] },
    { key: 'mer-w1', customer: 'Meridian Health Group', parent: 'mer-p', externalId: 'TR-10418', title: 'Wave 1 — patient portal and identity', status: 'Closed Won', complexity: 'Medium', priority: 'High',
      contact: 'Dana Whitfield', myRole: 'Lead', outcome: 'Closed Won', themes: ['Cloud', 'Identity'], createdDaysAgo: 115,
      description: 'Patient portal and its identity provider to cloud; SSO for 4,000 staff; zero-downtime cutover target.',
      history: [[112, 'status', 'New', 'In Progress'], [64, 'status', 'In Progress', 'Closed Won'], [64, 'outcome', 'Ongoing', 'Closed Won']] },
    { key: 'mer-w2', customer: 'Meridian Health Group', parent: 'mer-p', externalId: 'TR-10421', title: 'Wave 2 — scheduling and lab systems cutover', status: 'In Progress', complexity: 'Complex', priority: 'Critical',
      contact: 'Dana Whitfield', myRole: 'Lead', outcome: 'Ongoing', themes: ['Cloud', 'Compliance'], createdDaysAgo: 70,
      description: 'Scheduling system and lab integrations (two interface engines) to cloud over two weekends; rollback point at T+4h.',
      history: [[66, 'status', 'New', 'In Progress'], [40, 'complexity', 'Medium', 'Complex']] },
    { key: 'mer-w3', customer: 'Meridian Health Group', parent: 'mer-p', externalId: 'TR-10423', title: 'Wave 3 — imaging archive migration', status: 'New', complexity: 'Complex', priority: 'High',
      contact: 'Dana Whitfield', myRole: 'Lead', themes: ['Cloud', 'Data & Analytics'], createdDaysAgo: 12,
      description: '210 TB imaging archive; retrieval latency SLA for radiology; staged copy with checksum verification.' },
    { key: 'mer-q', customer: 'Meridian Health Group', parent: 'mer-p', externalId: 'TR-10427', title: 'Quarantine workflow for non-compliant workloads', status: 'Waiting Internal', complexity: 'Medium', priority: 'Medium',
      contact: 'Raj Patel', myRole: 'SME', themes: ['Security', 'Compliance'], createdDaysAgo: 30,
      description: 'Auto-isolate cloud workloads that drift out of the compliance baseline; ticket to owner; release on fix.',
      history: [[28, 'status', 'New', 'In Progress'], [10, 'status', 'In Progress', 'Waiting Internal']] },
    { key: 'mer-idp', customer: 'Meridian Health Group', opp: 'mer-id', externalId: 'TR-10431', title: 'Identity provider consolidation', status: 'Evaluation', complexity: 'Medium', priority: 'High',
      contact: 'Raj Patel', rep: 'Chris Alvarez', targetCloseDaysAhead: 120, myRole: 'Lead', outcome: 'Ongoing', themes: ['Identity', 'Security'], createdDaysAgo: 22,
      description: 'Collapse three identity providers into one; conditional access for clinical kiosks; badge-tap sign-in.',
      history: [[15, 'status', 'New', 'Evaluation']] },

    // --- Bluewater: depot WAN program (parent + 3 children), telemetry moved out ---
    { key: 'blu-p', customer: 'Bluewater Logistics', opp: 'blu-wan', title: 'Depot WAN refresh program', status: 'In Progress', complexity: 'Complex', priority: 'High',
      contact: 'Marcus Reed', rep: 'Priya Nair', targetCloseDaysAhead: 45, myRole: 'Lead', outcome: 'Ongoing', themes: ['Networking'], createdDaysAgo: 90,
      description: 'Program parent: replace branch routers at 62 depots with a dual-uplink design. Competing against the incumbent refresh quote.',
      history: [[88, 'status', 'New', 'In Progress']] },
    { key: 'blu-pilot', customer: 'Bluewater Logistics', parent: 'blu-p', externalId: 'TR-10388', title: 'Pilot — five depots, dual uplink', status: 'POC', complexity: 'Medium', priority: 'High',
      contact: 'Marcus Reed', myRole: 'Lead', outcome: 'Ongoing', themes: ['Networking'], createdDaysAgo: 62,
      description: 'Five pilot depots on broadband + LTE; application steering for voice and the warehouse system; exit criteria agreed up front.',
      history: [[58, 'status', 'New', 'In Progress'], [36, 'status', 'In Progress', 'POC']] },
    { key: 'blu-lte', customer: 'Bluewater Logistics', parent: 'blu-p', externalId: 'TR-10389', title: 'LTE failover design', status: 'In Progress', complexity: 'Medium', priority: 'High',
      contact: 'Marcus Reed', myRole: 'Lead', themes: ['Networking'], createdDaysAgo: 40,
      description: 'Carrier selection, private APN, failover and fail-back thresholds that protect the voice SLA.' },
    { key: 'blu-voice', customer: 'Bluewater Logistics', parent: 'blu-p', externalId: 'TR-10395', title: 'Voice QoS policy for depot phones', status: 'Evaluation', complexity: 'Simple', priority: 'Medium',
      contact: 'Lena Ortiz', myRole: 'Supporting', themes: ['Networking'], createdDaysAgo: 26,
      description: 'Marking and queuing for 900 desk phones; jitter budget for the dispatch floor.' },
    { key: 'blu-tele', customer: 'Bluewater Logistics', opp: 'blu-obs', externalId: 'TR-10402', title: 'Truck telemetry ingestion', status: 'In Progress', complexity: 'Medium', priority: 'Medium',
      contact: 'Marcus Reed', rep: 'Priya Nair', targetCloseDaysAhead: 110, myRole: 'SME', themes: ['Observability', 'Integration'], createdDaysAgo: 34,
      description: 'Stream truck telemetry from depot gateways into their analytics platform; started inside the WAN program, now its own opportunity.',
      moves: [[18, 'Depot WAN refresh', 'Fleet telemetry observability']] },

    // --- Ferrostahl: plant OT security (parent + 2 children) ---
    { key: 'fer-p', customer: 'Ferrostahl Manufacturing', opp: 'fer-ot', title: 'Plant OT security program', status: 'In Progress', complexity: 'Complex', priority: 'High',
      contact: 'Ingrid Vollmer', rep: 'Chris Alvarez', targetCloseDaysAhead: 60, myRole: 'Supporting', outcome: 'Ongoing', themes: ['Security', 'Networking'], createdDaysAgo: 75,
      description: 'Program parent for plant-floor security across three plants. Supporting the partner-led design.' },
    { key: 'fer-seg', customer: 'Ferrostahl Manufacturing', parent: 'fer-p', externalId: 'TR-10455', title: 'OT network segmentation — plant 1', status: 'Evaluation', complexity: 'Medium', priority: 'High',
      contact: 'Ingrid Vollmer', myRole: 'Supporting', themes: ['Security', 'Networking'], createdDaysAgo: 70,
      description: 'Zone and conduit model for plant 1; separate the historian and engineering workstations from corporate IT.',
      history: [[50, 'status', 'New', 'Evaluation']] },
    { key: 'fer-vend', customer: 'Ferrostahl Manufacturing', parent: 'fer-p', externalId: 'TR-10461', title: 'Vendor remote access to jump hosts', status: 'In Progress', complexity: 'Medium', priority: 'Medium',
      contact: 'Jonas Becker', myRole: 'Supporting', themes: ['Security', 'Identity'], createdDaysAgo: 44,
      description: 'Identity-based, recorded access for 12 third-party maintenance vendors; no standing VPN accounts.' },

    // --- Northgate: GenAI governance (parent + 3 children) and MFA ---
    { key: 'nor-p', customer: 'Northgate Financial', opp: 'nor-ai', title: 'GenAI governance rollout', status: 'In Progress', complexity: 'Medium', priority: 'High',
      contact: 'Sofia Marchetti', rep: 'Chris Alvarez', targetCloseDaysAhead: 50, myRole: 'Lead', outcome: 'Ongoing', themes: ['AI/ML', 'Security'], createdDaysAgo: 45,
      description: 'Program parent: see, allow and control generative-AI use across 3,000 staff. Exec-driven.' },
    { key: 'nor-disc', customer: 'Northgate Financial', parent: 'nor-p', externalId: 'TR-10517', title: 'Discovery — sanctioned vs unsanctioned AI tools', status: 'In Progress', complexity: 'Simple', priority: 'High',
      contact: 'Sofia Marchetti', myRole: 'Lead', themes: ['AI/ML', 'Observability'], createdDaysAgo: 42,
      description: 'Inventory of AI tools in use from proxy and SaaS logs; classify sanctioned, tolerated, blocked.',
      history: [[40, 'status', 'New', 'In Progress']] },
    { key: 'nor-dlp', customer: 'Northgate Financial', parent: 'nor-p', externalId: 'TR-10519', title: 'Prompt data-loss controls', status: 'New', complexity: 'Medium', priority: 'High',
      contact: 'Sofia Marchetti', myRole: 'Lead', themes: ['AI/ML', 'Compliance'], createdDaysAgo: 20,
      description: 'Stop account numbers and customer PII from being pasted into prompts; coach, then block.' },
    { key: 'nor-pol', customer: 'Northgate Financial', parent: 'nor-p', externalId: 'TR-10522', title: 'Acceptable-use policy and exec briefing', status: 'Waiting Customer', complexity: 'Simple', priority: 'Medium',
      contact: 'Owen Clarke', myRole: 'Supporting', themes: ['AI/ML', 'Compliance'], createdDaysAgo: 18,
      description: 'Draft the AI acceptable-use policy with legal; 20-minute briefing for the exec committee.',
      history: [[8, 'status', 'In Progress', 'Waiting Customer']] },
    { key: 'nor-mfa', customer: 'Northgate Financial', opp: 'nor-id', externalId: 'TR-10530', title: 'Phishing-resistant MFA rollout', status: 'POC', complexity: 'Medium', priority: 'High',
      contact: 'Owen Clarke', rep: 'Chris Alvarez', targetCloseDaysAhead: 35, myRole: 'Lead', outcome: 'Ongoing', themes: ['Identity', 'Security'], createdDaysAgo: 38,
      description: 'Passkeys and hardware keys for 400 privileged users first, then all staff; legacy app exceptions tracked.',
      history: [[33, 'status', 'New', 'In Progress'], [21, 'status', 'In Progress', 'POC']] },

    // --- Tidal Grid: network automation (parent + 2 children, some notes imported) ---
    { key: 'tid-p', customer: 'Tidal Grid Utilities', opp: 'tid-auto', title: 'Network automation program', status: 'In Progress', complexity: 'Medium', priority: 'Medium',
      contact: 'Elena Varga', rep: 'Priya Nair', targetCloseDaysAhead: 90, myRole: 'Lead', outcome: 'Ongoing', themes: ['Automation', 'Networking'], createdDaysAgo: 60,
      description: 'Program parent: central configuration, drift reporting and change automation for 11 device groups.' },
    { key: 'tid-cfg', customer: 'Tidal Grid Utilities', parent: 'tid-p', externalId: 'TR-10490', title: 'Centralized configuration management', status: 'In Progress', complexity: 'Medium', priority: 'Medium',
      contact: 'Elena Varga', myRole: 'Lead', themes: ['Automation', 'Networking'], createdDaysAgo: 58,
      description: 'Hierarchy mirroring region and site; shared policy sets for the six truly common configs.',
      history: [[55, 'status', 'New', 'In Progress']] },
    { key: 'tid-drift', customer: 'Tidal Grid Utilities', parent: 'tid-p', externalId: 'TR-10494', title: 'Config-drift reporting via API', status: 'POC', complexity: 'Simple', priority: 'Medium',
      contact: 'Elena Varga', myRole: 'Lead', themes: ['Automation', 'Observability'], createdDaysAgo: 30,
      description: 'Weekly drift export between running configs and the central source of truth, scheduled through the API.',
      history: [[16, 'status', 'In Progress', 'POC']] },

    // --- Veldt: closed-won program ---
    { key: 'vel-p', customer: 'Veldt Energy', opp: 'vel-cc', title: 'Control-center modernization', status: 'Closed Won', complexity: 'Complex', priority: 'High',
      contact: 'Pieter Smit', rep: 'Chris Alvarez', myRole: 'Lead', outcome: 'Closed Won', themes: ['Networking', 'Security'], createdDaysAgo: 200,
      description: 'Program parent: redesign the control-center network and SCADA access.',
      history: [[195, 'status', 'New', 'In Progress'], [28, 'status', 'In Progress', 'Closed Won'], [28, 'outcome', 'Ongoing', 'Closed Won']] },
    { key: 'vel-net', customer: 'Veldt Energy', parent: 'vel-p', externalId: 'TR-10301', title: 'Control-center network redesign', status: 'Closed Won', complexity: 'Complex', priority: 'High',
      contact: 'Pieter Smit', myRole: 'Lead', outcome: 'Closed Won', themes: ['Networking'], createdDaysAgo: 190,
      description: 'Redundant core for two control centers; deterministic paths for SCADA traffic.',
      history: [[185, 'status', 'New', 'In Progress'], [120, 'status', 'In Progress', 'POC'], [30, 'status', 'POC', 'Closed Won'], [30, 'outcome', 'Tech Win', 'Closed Won']] },
    { key: 'vel-sec', customer: 'Veldt Energy', parent: 'vel-p', externalId: 'TR-10305', title: 'SCADA access policy', status: 'Closed Won', complexity: 'Medium', priority: 'High',
      contact: 'Pieter Smit', myRole: 'SME', outcome: 'Closed Won', themes: ['Security'], createdDaysAgo: 170,
      description: 'Least-privilege access to SCADA consoles with session recording.',
      history: [[165, 'status', 'New', 'In Progress'], [29, 'status', 'In Progress', 'Closed Won']] },

    // --- standalone requests ---
    { key: 'qui', customer: 'Quill & Sable Publishing', opp: 'qui-dlp', externalId: 'TR-10364', title: 'Data-loss prevention for cloud office suite', status: 'Waiting Customer', complexity: 'Medium', priority: 'Medium',
      contact: 'Tom Okafor', rep: 'Priya Nair', targetCloseDaysAhead: 20, myRole: 'SME', outcome: 'Ongoing', themes: ['Security', 'Compliance'], createdDaysAgo: 55,
      description: 'API onboarding of ~9 TB of documents; DLP for subscriber PII in shared links. Waiting on their security council.',
      history: [[52, 'status', 'New', 'In Progress'], [30, 'status', 'In Progress', 'Waiting Customer']] },
    { key: 'har', customer: 'Harborline Ferries', opp: 'har-mon', externalId: 'TR-10277', title: 'Fleet connectivity monitoring pilot', status: 'Waiting Customer', complexity: 'Simple', priority: 'Low',
      contact: 'Nils Hagen', rep: 'Chris Alvarez', myRole: 'Supporting', outcome: 'Stalled', themes: ['Observability'], createdDaysAgo: 48, deactivatedDaysAgo: 12,
      description: 'Connectivity experience monitoring for crew Wi-Fi on four vessels.',
      history: [[45, 'status', 'New', 'Waiting Customer'], [12, 'deactivation', 'active', 'deactivated'], [12, 'outcome', 'Ongoing', 'Stalled']] },
    { key: 'cop-fw', customer: 'Copperfield Retail', opp: 'cop-fw', externalId: 'TR-10233', title: 'Store firewall refresh — 140 stores', status: 'Closed Lost', complexity: 'Medium', priority: 'High',
      contact: 'Gwen Talbot', rep: 'Priya Nair', myRole: 'Lead', outcome: 'Closed Lost', themes: ['Security', 'Networking'], createdDaysAgo: 105,
      description: 'Replace store firewalls with a centrally managed design; zero-touch provisioning for new stores.',
      history: [[100, 'status', 'New', 'In Progress'], [70, 'status', 'In Progress', 'Evaluation'], [42, 'status', 'Evaluation', 'Closed Lost'], [42, 'outcome', 'Ongoing', 'Closed Lost']] },
    { key: 'cop-pos', customer: 'Copperfield Retail', opp: 'cop-pos', externalId: 'TR-10541', title: 'POS network segmentation', status: 'New', complexity: 'Simple', priority: 'Medium',
      contact: 'Gwen Talbot', rep: 'Priya Nair', targetCloseDaysAhead: 100, myRole: 'Lead', themes: ['Security', 'Compliance'], createdDaysAgo: 5,
      description: 'Card-data scope reduction: isolate point-of-sale lanes from store Wi-Fi and back-office systems.' },
    { key: 'ast', customer: 'Aster & Pine Architects', opp: 'ast-ws', externalId: 'TR-10190', title: 'Secure contractor workspace', status: 'Archived', complexity: 'Simple', priority: 'Low',
      contact: 'Mira Chen', rep: 'Chris Alvarez', myRole: 'Lead', outcome: 'Stalled', themes: ['Security'], createdDaysAgo: 145,
      description: 'Isolated access to project files for 40 contractors without full virtual desktops.',
      history: [[140, 'status', 'New', 'Evaluation'], [92, 'status', 'Evaluation', 'Archived']] },
    { key: 'kes', customer: 'Kestrel Aerospace', opp: 'kes-lz', externalId: 'TR-10548', title: 'Engineering cloud landing zone — discovery', status: 'New', complexity: 'Medium', priority: 'Medium',
      contact: 'Ada Brennan', rep: 'Priya Nair', targetCloseDaysAhead: 160, myRole: 'Lead', themes: ['Cloud', 'Compliance'], createdDaysAgo: 4,
      description: 'Landing zone for engineering simulation workloads; export-control data residency requirements.' },
  ],

  logs: [
    // Meridian parent — project-management notes
    { tr: 'mer-p', type: 'Meeting', daysAgo: 118, note: 'Program kickoff with Dana and the app owners. Three waves agreed: portal + identity, scheduling + lab, imaging. I own the technical plan; their PMO owns dates.',
      exec: 'Kickoff set three migration waves; we own the technical plan, Meridian PMO owns the schedule.' },
    { tr: 'mer-p', type: 'Email', daysAgo: 74, exec: 'Requested a weekend migration engineer for wave 2 (six weeks).', note: 'Asked our resourcing desk for a migration engineer for wave 2 (weekends, 6 weeks). Requested start date three weeks out.' },
    { tr: 'mer-p', type: 'Email', daysAgo: 66, exec: 'Wave 2 engineer still unassigned; escalated to the regional manager.', note: 'Chased the resourcing request — no engineer assigned yet. Escalated to the regional manager with the wave 2 dates attached.' },
    { tr: 'mer-p', type: 'Note', daysAgo: 61, exec: 'Wave 2 engineer assigned (start in 9 days); wave 3 still needs a storage specialist.', note: 'Engineer assigned for wave 2: Sam Ito, starting in 9 days. Wave 3 still needs a storage specialist.' },
    { tr: 'mer-p', type: 'Note', daysAgo: 47, flagged: true, note: 'Dana mentioned off the record that next year\'s budget may be cut 15% and wave 3 could slip to FY28. Not to be shared with the account team yet.' },
    { tr: 'mer-p', type: 'Email', daysAgo: 13, exec: 'Requested a large-archive storage specialist for wave 3 by month end.', note: 'Requested a storage specialist for wave 3 (imaging archive). Need someone with large-archive migration experience by the end of the month.' },
    { tr: 'mer-p', type: 'Meeting', daysAgo: 6, also: ['mer-w2', 'mer-w3', 'mer-q'], note: 'Monthly readiness review across all three open requests: wave 2 on track for the second cutover weekend; wave 3 discovery starts once the storage specialist lands; quarantine workflow blocked on their ticketing integration.',
      exec: 'Readiness review: wave 2 on track, wave 3 waiting on a storage specialist, quarantine workflow blocked on ticketing integration.' },
    // Meridian wave 1 (closed won)
    { tr: 'mer-w1', type: 'Call', daysAgo: 110, note: 'Portal architecture call: active-active across two regions, identity provider fronted by conditional access, staff SSO through the existing directory.',
      exec: 'Agreed an active-active portal design with conditional access in front of the identity provider.' },
    { tr: 'mer-w1', type: 'Meeting', daysAgo: 88, note: 'Dry-run cutover in staging: 22 minutes end to end, two DNS TTLs too long. Fixed and re-ran: 9 minutes.',
      exec: 'Staging dry run cut from 22 to 9 minutes after fixing DNS TTLs.' },
    { tr: 'mer-w1', type: 'Note', daysAgo: 64, note: 'official: Wave 1 complete. Portal and identity live in cloud, zero downtime, 4,000 staff on SSO. Customer signed off the acceptance checklist.',
      exec: 'Wave 1 live with zero downtime; 4,000 staff on SSO; acceptance signed.' },
    // Meridian wave 2
    { tr: 'mer-w2', type: 'Meeting', daysAgo: 60, note: 'Wave 2 scoping with the scheduling and lab teams. Two interface engines carry 140 message flows; each flow gets a test case before cutover.',
      exec: 'Scoped wave 2: 140 interface flows across two engines, each with a test case.' },
    { tr: 'mer-w2', type: 'Call', daysAgo: 41, exec: 'Lab-to-cloud interface latency 18 ms p95, inside the 40 ms budget.', note: 'Latency test from the lab analyzers to the cloud interface engine: 18 ms p95, inside the 40 ms budget.' },
    { tr: 'mer-w2', type: 'Email', daysAgo: 27, exec: 'Runbook v1 sent: two weekends, T+4h rollback, named owners.', note: 'Sent the cutover runbook v1 for review: two weekends, rollback point at T+4h, named owners for every step.' },
    { tr: 'mer-w2', type: 'Meeting', daysAgo: 13, note: 'Runbook review with the app owners: scheduling moves first weekend, lab integrations second. Two firewall changes must be filed by Tuesday.',
      exec: 'Runbook approved: scheduling first weekend, lab second; two firewall changes due Tuesday.' },
    { tr: 'mer-w2', type: 'Call', daysAgo: 8, note: 'First weekend cutover done: scheduling system live in cloud, no sev-1 incidents, one slow report fixed with an index.',
      exec: 'Scheduling system cut over with no sev-1s; one slow report fixed.' },
    { tr: 'mer-w2', type: 'Chat', daysAgo: 1, note: 'Dana: lab integrations went live overnight, 140/140 flows green. Monitoring for 48h before decommissioning the old engines.',
      exec: 'Lab integrations live, all 140 flows green; 48h watch before decommissioning.' },
    // Meridian wave 3
    { tr: 'mer-w3', type: 'Call', daysAgo: 11, note: 'Intro call with radiology IT. 210 TB archive, 9 years of studies; retrieval under 3 seconds for the last 2 years is the hard requirement.',
      exec: 'Wave 3: 210 TB imaging archive; sub-3-second retrieval for recent studies is the key requirement.' },
    { tr: 'mer-w3', type: 'Note', daysAgo: 8, exec: 'Archive assessment waits on the storage specialist.', note: 'Waiting on the storage specialist before scheduling the archive assessment.' },
    // Meridian quarantine
    { tr: 'mer-q', type: 'Meeting', daysAgo: 27, note: 'Design session: drift detection from the posture tool, auto-tag and isolate, open a ticket to the workload owner, release once the check passes.',
      exec: 'Quarantine design: detect drift, isolate, ticket the owner, release on pass.' },
    { tr: 'mer-q', type: 'Email', daysAgo: 9, exec: 'Ticketing API unavailable until next quarter; proposed email-to-ticket interim.', note: 'Their ticketing team cannot expose the API until next quarter. Asked whether email-to-ticket is acceptable as an interim.' },
    // Meridian identity
    { tr: 'mer-idp', type: 'Meeting', daysAgo: 20, note: 'Identity discovery: three providers (staff, contractors, affiliated physicians). Kiosk sign-in with badge tap is the clinical team\'s top ask.',
      exec: 'Three identity providers to consolidate; badge-tap kiosk sign-in is the top clinical ask.' },
    { tr: 'mer-idp', type: 'Demo', daysAgo: 10, exec: 'Demoed kiosk policies: per-tap sessions, 2-minute idle lock, no persistent tokens.', note: 'Demoed conditional access policies for shared kiosks: session per badge tap, 2-minute idle lock, no persistent tokens.' },
    { tr: 'mer-idp', type: 'Email', daysAgo: 3, exec: 'Options paper sent: contractors first, physicians last; under architect review.', note: 'Sent the consolidation options paper: migrate contractors first, physicians last. Raj reviewing with their architect.' },

    // Bluewater parent — PM notes
    { tr: 'blu-p', type: 'Meeting', daysAgo: 88, note: 'Program kickoff: 62 depots in four regions. Pilot first, then region-by-region rollout. Marcus owns site readiness; I own design and the pilot.',
      exec: 'Kickoff: pilot then regional rollout across 62 depots; we own design and pilot.' },
    { tr: 'blu-p', type: 'Email', daysAgo: 44, exec: 'Partner can supply one field engineer now and a second in three weeks.', note: 'Asked the partner team for two field engineers for pilot installs. They can do one now and one in three weeks.' },
    { tr: 'blu-p', type: 'Note', daysAgo: 30, exec: 'Opportunity renamed to match the budget line; telemetry splitting into its own opportunity.', note: 'Renamed the opportunity to "Depot WAN refresh" to match their budget line. Telemetry work is splitting off into its own opportunity.' },
    { tr: 'blu-p', type: 'Meeting', daysAgo: 4, also: ['blu-pilot', 'blu-lte', 'blu-voice'], note: 'Weekly program sync: pilot exit criteria 4 of 5 met, LTE thresholds agreed in principle, voice marking still needs the dispatch-floor test.',
      exec: 'Program sync: pilot 4/5 exit criteria met, LTE thresholds agreed, voice test pending.' },
    // Bluewater pilot
    { tr: 'blu-pilot', type: 'Meeting', daysAgo: 58, note: 'Pilot plan: five depots chosen for a mix of rural and urban circuits. Exit criteria: failover under 3 s, no voice drops, warehouse app response under 200 ms.',
      exec: 'Pilot at five depots with exit criteria on failover time, voice and app latency.' },
    { tr: 'blu-pilot', type: 'POC', daysAgo: 35, exec: 'Pilot devices live at all five depots; one week of baseline before steering.', note: 'Pilot devices installed at all five depots. Baseline captured for a week before steering policies go on.' },
    { tr: 'blu-pilot', type: 'POC', daysAgo: 16, note: 'Failover test at depot 3: 1.4 s failover, no dropped calls. Warehouse app p95 dropped from 310 ms to 140 ms with steering on.',
      exec: 'Depot 3 failover in 1.4 s with no dropped calls; app p95 down from 310 to 140 ms.' },
    { tr: 'blu-pilot', type: 'Call', daysAgo: 2, note: 'Reviewed pilot results with Marcus. Only open criterion: one rural depot shows jitter on LTE. Retest next week with the second carrier.',
      exec: 'Pilot nearly complete; one rural depot needs an LTE jitter retest.' },
    // Bluewater LTE
    { tr: 'blu-lte', type: 'POC', daysAgo: 22, exec: 'Carrier B stronger at 4 of 5 depots; private APN with static addressing.', note: 'Compared two carriers at the pilot depots: carrier B had better signal at 4 of 5 sites. Private APN with per-depot static addressing.' },
    { tr: 'blu-lte', type: 'Email', daysAgo: 9, exec: 'Proposed LTE failover after 3 lost 1 s probes, fail-back after 60 s stable.', note: 'Sent the failover threshold proposal: fail to LTE after 3 lost probes at 1 s, fail back after 60 s stable.' },
    { tr: 'blu-lte', type: 'Call', daysAgo: 0, note: 'Marcus confirmed the thresholds meet their voice SLA. Carrier B contract going to procurement this week.',
      exec: 'Thresholds accepted against the voice SLA; carrier B contract to procurement.' },
    // Bluewater voice
    { tr: 'blu-voice', type: 'Meeting', daysAgo: 20, exec: 'Voice workshop: 900 phones, two codecs; marking at the access switch.', note: 'Voice workshop with Lena: 900 phones, two codecs, dispatch floor is the sensitive area. Agreed marking at the access switch.' },
    { tr: 'blu-voice', type: 'Email', daysAgo: 5, exec: 'Queuing policy draft shared; dispatch-floor test to be scheduled.', note: 'Shared the queuing policy draft. Lena will schedule the dispatch-floor test.' },
    // Bluewater telemetry (moved)
    { tr: 'blu-tele', type: 'Meeting', daysAgo: 32, note: 'Telemetry requirements: 1,800 trucks reporting every 30 s through depot gateways; analytics team wants it in their streaming platform.',
      exec: 'Telemetry from 1,800 trucks every 30 s into the analytics streaming platform.' },
    { tr: 'blu-tele', type: 'Note', daysAgo: 18, exec: 'Moved to its own opportunity — separate analytics budget and buyer.', note: 'Moved this request to its own opportunity: the analytics team has a separate budget and buyer.' },
    { tr: 'blu-tele', type: 'Call', daysAgo: 4, exec: 'Gateways buffered 6 hours of telemetry through an outage without loss.', note: 'Gateway buffering test: 6 hours of telemetry survives an outage without loss.' },

    // Ferrostahl
    { tr: 'fer-p', type: 'Meeting', daysAgo: 72, exec: 'Partner-led kickoff; we review segmentation design and own vendor access; plants 2–3 follow plant 1.', note: 'Partner-led program kickoff. Our role: segmentation design review and vendor access. Plants 2 and 3 follow plant 1 after lessons learned.' },
    { tr: 'fer-p', type: 'Email', daysAgo: 25, exec: 'Requested the plant 1 change calendar to time design reviews before freezes.', note: 'Asked the partner for their plant 1 change calendar so our design reviews land before their freeze windows.' },
    { tr: 'fer-seg', type: 'Meeting', daysAgo: 65, note: 'Walked the plant 1 floor with Ingrid. Historian and engineering workstations share a flat network with the office printers.',
      exec: 'Plant 1 is flat: historian and engineering stations share a network with office devices.' },
    { tr: 'fer-seg', type: 'Email', daysAgo: 38, exec: 'Sent a five-zone model with two conduits to IT, default deny elsewhere.', note: 'Sent the zone and conduit model: five zones, two conduits to IT, all others deny by default.' },
    { tr: 'fer-seg', type: 'Call', daysAgo: 4, note: 'Ingrid approved zones 1–3; zones 4–5 wait on the historian vendor confirming its ports.',
      exec: 'Zones 1–3 approved; zones 4–5 wait on the historian vendor\'s port list.' },
    { tr: 'fer-vend', type: 'Meeting', daysAgo: 40, note: 'Vendor access review: 12 vendors, 7 with standing VPN accounts. Target is just-in-time, recorded sessions to the jump hosts.',
      exec: '12 vendors, 7 with standing VPN accounts; moving to just-in-time recorded sessions.' },
    { tr: 'fer-vend', type: 'Email', daysAgo: 16, exec: 'Access-request workflow sent; awaiting Jonas\'s reply.', note: 'Sent the access-request workflow. No reply yet from Jonas.' },

    // Northgate
    { tr: 'nor-p', type: 'Meeting', daysAgo: 44, note: 'Exec kickoff with Sofia and the CRO: see what AI tools are in use within a month, then policy, then controls. Three workstreams created as child requests.',
      exec: 'Exec kickoff: visibility in a month, then policy, then controls; three workstreams.' },
    { tr: 'nor-p', type: 'Note', daysAgo: 30, flagged: true, note: 'Pricing discussion with procurement: they will accept a three-year term if we hold year-one pricing. Keep out of shared notes.' },
    { tr: 'nor-p', type: 'Email', daysAgo: 12, exec: 'Requested a data-protection specialist for two weeks on prompt controls.', note: 'Asked for a data-protection specialist to support the prompt-controls workstream for two weeks.' },
    { tr: 'nor-disc', type: 'Call', daysAgo: 39, note: 'Pulled 30 days of proxy logs: 61 distinct AI tools, 4 account for 85% of use.',
      exec: '61 AI tools in use; 4 account for 85% of usage.' },
    { tr: 'nor-disc', type: 'Meeting', daysAgo: 15, note: 'Classification workshop: 3 sanctioned, 9 tolerated with coaching, the rest blocked. Sofia presenting to the exec committee.',
      exec: 'Classified tools: 3 sanctioned, 9 tolerated with coaching, rest blocked.' },
    { tr: 'nor-disc', type: 'Note', daysAgo: 1, note: 'official: Discovery complete and accepted by the CISO. Tool inventory and classification handed to the policy workstream.',
      exec: 'Discovery accepted by the CISO and handed to the policy workstream.' },
    { tr: 'nor-dlp', type: 'Meeting', daysAgo: 17, exec: 'Prompt controls to target account numbers, card data and names; coach then block after 30 days.', note: 'Prompt-controls scoping: account numbers, card data and customer names are the priority patterns. Start with coaching, block after 30 days.' },
    { tr: 'nor-dlp', type: 'Call', daysAgo: 3, note: 'Tested the account-number detector against 2,000 sample prompts: 2 false positives, both fixed with a checksum rule.',
      exec: 'Account-number detector tested on 2,000 prompts; two false positives fixed.' },
    { tr: 'nor-pol', type: 'Email', daysAgo: 14, exec: 'Acceptable-use policy draft sent to Owen and legal.', note: 'Sent the acceptable-use policy draft to Owen and legal.' },
    { tr: 'nor-pol', type: 'Email', daysAgo: 5, exec: 'Legal requested a client-confidential data clause; wording pending.', note: 'Legal asked for a clause on client-confidential data. Waiting for their wording.' },
    { tr: 'nor-mfa', type: 'Meeting', daysAgo: 34, note: 'MFA scoping: 400 privileged users first with hardware keys, then passkeys for all staff. Two legacy apps cannot do modern auth.',
      exec: 'Privileged users get hardware keys first; two legacy apps need exceptions.' },
    { tr: 'nor-mfa', type: 'POC', daysAgo: 12, exec: '40-admin POC: 6-minute average enrolment; one helpdesk script updated.', note: 'POC with 40 admins: enrolment took 6 minutes on average; one helpdesk script needed updating.' },
    { tr: 'nor-mfa', type: 'Call', daysAgo: 3, exec: 'Legacy-app exception process required before wider MFA rollout.', note: 'Owen wants the legacy-app exception process written before the wider rollout.' },

    // Tidal Grid (several notes came in through the import)
    { tr: 'tid-p', type: 'Meeting', daysAgo: 58, exec: 'Automation roadmap: central config, then drift reporting, then change automation next year.', note: 'Automation program kickoff with Elena: central config first, then drift reporting, then change automation next year.' },
    { tr: 'tid-cfg', type: 'Meeting', daysAgo: 52, note: 'Config workshop: 11 device groups, heavy shared-object sprawl. Proposed a hierarchy mirroring region and site.',
      exec: 'Proposed a region/site hierarchy to tame shared-object sprawl across 11 device groups.' },
    { tr: 'tid-cfg', type: 'Call', daysAgo: 23, imported: true, exec: '1,240 unused objects confirmed safe to remove.', note: 'Reviewed the object clean-up list: 1,240 unused objects safe to remove.' },
    { tr: 'tid-cfg', type: 'Email', daysAgo: 16, imported: true, exec: 'Runbook draft sent: read-only, one region, then cutover.', note: 'Sent the migration runbook draft: read-only visibility, one region, then cutover.' },
    { tr: 'tid-cfg', type: 'Call', daysAgo: 4, exec: 'Change board approved the region 1 migration window for next month.', note: 'Change board approved the region 1 migration window for next month.' },
    { tr: 'tid-drift', type: 'Call', daysAgo: 25, imported: true, exec: 'First drift report: 23 differences, mostly logging profiles.', note: 'Walked through the first drift report: 23 differences, mostly logging profiles.' },
    { tr: 'tid-drift', type: 'POC', daysAgo: 12, note: 'Scheduled the weekly drift export through the API; first automated report delivered to Elena\'s team.',
      exec: 'Weekly drift export automated through the API; first report delivered.' },
    { tr: 'tid-drift', type: 'Chat', daysAgo: 2, exec: 'Drift down to 6 differences; report to go to the change board too.', note: 'Elena: second weekly report down to 6 differences. They want it sent to the change board too.' },

    // Veldt (closed won)
    { tr: 'vel-p', type: 'Meeting', daysAgo: 195, exec: 'Kicked off the control-center program: two sites, redundant core, SCADA access rework.', note: 'Control-center program kickoff: two sites, redundant core, SCADA access rework.' },
    { tr: 'vel-net', type: 'Meeting', daysAgo: 160, exec: 'Core design agreed: dual-homed SCADA servers with deterministic paths and sub-second convergence.', note: 'Core design review: dual-homed SCADA servers, deterministic paths, sub-second convergence.' },
    { tr: 'vel-net', type: 'POC', daysAgo: 110, exec: 'Redundant core converged in 280 ms on link loss in the lab.', note: 'Lab test of the redundant core: 280 ms convergence on link loss.' },
    { tr: 'vel-net', type: 'Note', daysAgo: 30, exec: 'Closed won: control-center network redesign signed; install next quarter.', note: 'official: Closed won. Control-center network redesign signed; installation starts next quarter.' },
    { tr: 'vel-sec', type: 'Meeting', daysAgo: 150, exec: 'SCADA access to use named accounts, recorded sessions and per-login vendor approval.', note: 'SCADA access workshop: named accounts only, recorded sessions, approval for every vendor login.' },
    { tr: 'vel-sec', type: 'Note', daysAgo: 29, exec: 'SCADA access policy accepted as part of the award.', note: 'official: SCADA access policy accepted as part of the control-center award.' },

    // Quill & Sable (stalled)
    { tr: 'qui', type: 'Meeting', daysAgo: 50, note: 'Scoping: 9 TB of documents, PII in subscriber exports shared by link. Want visibility first, then policy.',
      exec: 'Visibility-first DLP for 9 TB of documents with PII in shared links.' },
    { tr: 'qui', type: 'Email', daysAgo: 34, exec: 'Sent API onboarding steps and read-only permissions for the security council.', note: 'Sent the API onboarding steps and the read-only permission list for their security council.' },
    { tr: 'qui', type: 'Call', daysAgo: 24, exec: 'Security council postponed again with no new date.', note: 'Tom: security council postponed again. No new date.' },
    // Harborline (deactivated)
    { tr: 'har', type: 'Call', daysAgo: 40, exec: 'Crew Wi-Fi monitoring wanted on four vessels; satellite backhaul complicates it.', note: 'Nils wants crew Wi-Fi monitoring on four vessels; satellite backhaul makes it tricky.' },
    { tr: 'har', type: 'Note', daysAgo: 12, exec: 'No response in four weeks; deactivated pending auto-archive.', note: 'No response to three follow-ups over four weeks. Deactivated; will archive automatically if nothing changes.' },
    // Copperfield
    { tr: 'cop-fw', type: 'Demo', daysAgo: 95, exec: 'Demoed central management and zero-touch provisioning for new stores.', note: 'Demoed central management and zero-touch provisioning for new stores.' },
    { tr: 'cop-fw', type: 'Meeting', daysAgo: 66, exec: 'Technical evaluation passed; procurement comparing with the incumbent renewal.', note: 'Technical evaluation passed; procurement comparing against the incumbent renewal.' },
    { tr: 'cop-fw', type: 'Note', daysAgo: 42, exec: 'Closed lost on price to a discounted incumbent renewal; re-engage on POS segmentation.', note: 'official: Closed lost on price — incumbent renewed at a deep discount. No technical objections. Re-engage on POS segmentation.' },
    { tr: 'cop-pos', type: 'Call', daysAgo: 5, note: 'Gwen re-engaged: card-data audit next spring, wants POS lanes isolated before then.',
      exec: 'Re-engaged on POS isolation ahead of next spring\'s card-data audit.' },
    { tr: 'cop-pos', type: 'Email', daysAgo: 2, exec: 'Sent a store network discovery questionnaire.', note: 'Sent a short discovery questionnaire on store network layouts.' },
    // Aster & Pine (archived)
    { tr: 'ast', type: 'Demo', daysAgo: 130, exec: 'Demoed isolated contractor file access without virtual desktops.', note: 'Demoed isolated contractor access to project files without virtual desktops.' },
    { tr: 'ast', type: 'Note', daysAgo: 95, exec: 'Re-org froze IT projects and the champion left; archived.', note: 'Company re-org froze IT projects and the champion left. Archiving.' },
    // Kestrel (new)
    { tr: 'kes', type: 'Call', daysAgo: 3, note: 'Intro with Ada: simulation workloads need burst capacity; export-controlled data must stay in-country.',
      exec: 'New: burst capacity for simulation with in-country data residency.' },
    { tr: 'kes', type: 'Email', daysAgo: 1, exec: 'Landing-zone discovery agenda sent for next week.', note: 'Sent the landing-zone discovery agenda for next week.' },
  ],

  updates: [
    // Meridian wave 2 — posted every cycle, including this one
    { tr: 'mer-w2', cyclesAgo: 4, status: 'posted', text: '-Status: Runbook in review.\n-Activity: Runbook v1 sent with two weekends and a T+4h rollback point.\n-Next: Review with app owners.' },
    { tr: 'mer-w2', cyclesAgo: 3, status: 'posted', text: '-Status: Runbook under review by app owners.\n-Activity: Latency to the cloud interface engine confirmed at 18 ms p95.\n-Next: Runbook sign-off.' },
    { tr: 'mer-w2', cyclesAgo: 2, status: 'posted', text: '-Status: Runbook approved; cutover scheduled.\n-Activity: Scheduling moves first weekend, lab integrations second; two firewall changes filed.\n-Next: First cutover weekend.' },
    { tr: 'mer-w2', cyclesAgo: 1, status: 'posted', text: '-Status: Scheduling system live in cloud.\n-Activity: First weekend cutover completed with no sev-1 incidents; one slow report fixed with an index.\n-Next: Lab integrations cutover.' },
    { tr: 'mer-w2', cyclesAgo: 0, status: 'posted', ai: true, text: '-Status: Wave 2 cutover complete.\n-Activity: Lab integrations went live with all 140 interface flows green; readiness review confirmed wave 2 on track and closing.\n-Next: 48-hour watch, then decommission the old interface engines.' },
    // Meridian quarantine — missed last cycle (overdue)
    { tr: 'mer-q', cyclesAgo: 3, status: 'posted', text: '-Status: Design agreed.\n-Activity: Detect drift, isolate, ticket the owner, release on pass.\n-Next: Ticketing integration.' },
    { tr: 'mer-q', cyclesAgo: 2, status: 'posted', text: '-Status: In progress.\n-Activity: Posture-tool tagging tested on a sample of 30 workloads.\n-Next: Confirm ticketing API access.' },
    // Meridian identity
    { tr: 'mer-idp', cyclesAgo: 2, status: 'posted', text: '-Status: Discovery done.\n-Activity: Three identity providers mapped; badge-tap kiosk sign-in is the top ask.\n-Next: Kiosk demo.' },
    { tr: 'mer-idp', cyclesAgo: 1, status: 'posted', text: '-Status: Evaluation.\n-Activity: Demoed per-tap kiosk sessions with a 2-minute idle lock.\n-Next: Consolidation options paper.' },
    { tr: 'mer-idp', cyclesAgo: 0, status: 'draft', text: '-Status: Evaluation.\n-Activity: Consolidation options paper sent — contractors first, physicians last.\n-Next: Raj to review with their architect.' },
    // Bluewater
    { tr: 'blu-pilot', cyclesAgo: 4, status: 'posted', text: '-Status: Pilot installed.\n-Activity: Devices live at all five depots; baseline capture running.\n-Next: Enable steering policies.' },
    { tr: 'blu-pilot', cyclesAgo: 3, status: 'posted', text: '-Status: Pilot running.\n-Activity: Steering enabled for voice and the warehouse app.\n-Next: Failover testing.' },
    { tr: 'blu-pilot', cyclesAgo: 2, status: 'posted', text: '-Status: Pilot testing.\n-Activity: Depot 3 failover in 1.4 s with no dropped calls; warehouse app p95 from 310 to 140 ms.\n-Next: Remaining depots.' },
    { tr: 'blu-pilot', cyclesAgo: 1, status: 'posted', text: '-Status: Pilot testing.\n-Activity: Four depots meet all exit criteria.\n-Next: Results review with Marcus.' },
    { tr: 'blu-pilot', cyclesAgo: 0, status: 'posted', ai: true, text: '-Status: Pilot 4 of 5 exit criteria met.\n-Activity: Results reviewed with Marcus and in the weekly program sync; one rural depot shows LTE jitter.\n-Next: Retest that depot on the second carrier next week.' },
    { tr: 'blu-lte', cyclesAgo: 3, status: 'posted', text: '-Status: Carrier comparison.\n-Activity: Carrier B stronger at 4 of 5 pilot depots; private APN designed.\n-Next: Failover thresholds.' },
    { tr: 'blu-lte', cyclesAgo: 2, status: 'posted', text: '-Status: Design.\n-Activity: Working through fail-back timers with the voice team.\n-Next: Threshold proposal.' },
    { tr: 'blu-lte', cyclesAgo: 1, status: 'posted', text: '-Status: Proposal sent.\n-Activity: Fail to LTE after 3 lost probes at 1 s; fail back after 60 s stable.\n-Next: Marcus to check against the voice SLA.' },
    { tr: 'blu-lte', cyclesAgo: 0, status: 'draft', ai: true, text: '-Status: Thresholds accepted.\n-Activity: Marcus confirmed the failover thresholds meet the voice SLA; the program sync agreed them in principle.\n-Next: Carrier B contract to procurement this week.' },
    { tr: 'blu-voice', cyclesAgo: 2, status: 'posted', text: '-Status: Workshop held.\n-Activity: Marking at the access switch agreed for 900 phones.\n-Next: Queuing policy draft.' },
    { tr: 'blu-voice', cyclesAgo: 1, status: 'posted', text: '-Status: Evaluation.\n-Activity: Queuing policy in progress.\n-Next: Share the draft with Lena.' },
    { tr: 'blu-tele', cyclesAgo: 2, status: 'posted', text: '-Status: Moved to its own opportunity.\n-Activity: Analytics team has a separate budget and buyer.\n-Next: Gateway buffering test.' },
    { tr: 'blu-tele', cyclesAgo: 1, status: 'posted', text: '-Status: In progress.\n-Activity: Gateway sizing for 1,800 trucks at 30 s intervals.\n-Next: Buffering test.' },
    // Ferrostahl — vendor access missed last cycle (overdue)
    { tr: 'fer-seg', cyclesAgo: 3, status: 'posted', text: '-Status: Evaluation.\n-Activity: Zone and conduit model sent: five zones, two conduits to IT.\n-Next: Ingrid review.' },
    { tr: 'fer-seg', cyclesAgo: 2, status: 'posted', text: '-Status: Evaluation.\n-Activity: Partner reviewing the model against their change calendar.\n-Next: Approval of zones.' },
    { tr: 'fer-seg', cyclesAgo: 1, status: 'posted', text: '-Status: Evaluation.\n-Activity: Waiting on the historian vendor\'s port list.\n-Next: Zone approval meeting.' },
    { tr: 'fer-seg', cyclesAgo: 0, status: 'draft', ai: true, edited: true, text: '-Status: Zones 1–3 approved.\n-Activity: Ingrid approved zones 1–3 of the plant 1 model; zones 4–5 depend on the historian vendor confirming its ports.\n-Next: Chase the historian vendor for the port list.' },
    { tr: 'fer-vend', cyclesAgo: 3, status: 'posted', text: '-Status: In progress.\n-Activity: 7 standing VPN accounts identified for removal.\n-Next: Access-request workflow.' },
    { tr: 'fer-vend', cyclesAgo: 2, status: 'posted', text: '-Status: In progress.\n-Activity: Access-request workflow sent to Jonas.\n-Next: Workflow review.' },
    // Northgate
    { tr: 'nor-disc', cyclesAgo: 3, status: 'posted', text: '-Status: Discovery.\n-Activity: 61 AI tools found in 30 days of proxy logs.\n-Next: Classification workshop.' },
    { tr: 'nor-disc', cyclesAgo: 2, status: 'posted', text: '-Status: Classification.\n-Activity: 3 sanctioned, 9 tolerated with coaching, rest blocked.\n-Next: Exec committee readout.' },
    { tr: 'nor-disc', cyclesAgo: 1, status: 'posted', text: '-Status: Readout prepared.\n-Activity: Sofia presenting the classification to the exec committee.\n-Next: CISO acceptance.' },
    { tr: 'nor-disc', cyclesAgo: 0, status: 'posted', text: '-Status: Complete.\n-Activity: Discovery accepted by the CISO; inventory handed to the policy workstream.\n-Next: none' },
    { tr: 'nor-dlp', cyclesAgo: 1, status: 'posted', text: '-Status: Scoping done.\n-Activity: Priority patterns: account numbers, card data, customer names.\n-Next: Detector testing.' },
    { tr: 'nor-pol', cyclesAgo: 2, status: 'posted', text: '-Status: Drafting.\n-Activity: Acceptable-use policy draft sent to legal.\n-Next: Legal review.' },
    { tr: 'nor-pol', cyclesAgo: 1, status: 'posted', text: '-Status: Waiting on legal.\n-Activity: Clause on client-confidential data requested.\n-Next: Legal wording.' },
    { tr: 'nor-mfa', cyclesAgo: 3, status: 'posted', text: '-Status: Scoping.\n-Activity: Privileged users first with hardware keys; two legacy apps flagged.\n-Next: Admin POC.' },
    { tr: 'nor-mfa', cyclesAgo: 2, status: 'posted', text: '-Status: POC.\n-Activity: 40 admins enrolled, 6 minutes on average.\n-Next: Helpdesk script fix.' },
    { tr: 'nor-mfa', cyclesAgo: 1, status: 'posted', text: '-Status: POC.\n-Activity: Helpdesk script updated; no enrolment issues since.\n-Next: Rollout plan.' },
    { tr: 'nor-mfa', cyclesAgo: 0, status: 'draft', ai: true, text: '-Status: POC complete; rollout planning.\n-Activity: Owen asked for the legacy-app exception process to be written before the wider rollout.\n-Next: Draft the exception process.' },
    // Tidal Grid
    { tr: 'tid-cfg', cyclesAgo: 4, status: 'posted', text: '-Status: Design.\n-Activity: Region/site hierarchy proposed.\n-Next: Object clean-up list.' },
    { tr: 'tid-cfg', cyclesAgo: 3, status: 'posted', text: '-Status: Clean-up.\n-Activity: 1,240 unused objects identified.\n-Next: Runbook draft.' },
    { tr: 'tid-cfg', cyclesAgo: 2, status: 'posted', text: '-Status: Runbook drafted.\n-Activity: Read-only, one region, then cutover.\n-Next: Change board.' },
    { tr: 'tid-cfg', cyclesAgo: 1, status: 'posted', text: '-Status: Waiting on change board.\n-Activity: Runbook submitted.\n-Next: Board date.' },
    { tr: 'tid-drift', cyclesAgo: 2, status: 'posted', text: '-Status: POC.\n-Activity: First drift report: 23 differences, mostly logging profiles.\n-Next: Automate the export.' },
    { tr: 'tid-drift', cyclesAgo: 1, status: 'posted', text: '-Status: POC.\n-Activity: Weekly export scheduled through the API; first report delivered.\n-Next: Second report.' },
    { tr: 'tid-drift', cyclesAgo: 0, status: 'posted', text: '-Status: POC.\n-Activity: Second weekly report down to 6 differences.\n-Next: Add the change board to the distribution.' },
    // Quill — last posted long ago (overdue)
    { tr: 'qui', cyclesAgo: 4, status: 'posted', text: '-Status: Waiting on customer.\n-Activity: Security council review of API permissions pending.\n-Next: Council date.' },
  ],

  summaries: [
    { scope: 'family', key: 'mer-p', versions: [
      { daysAgo: 21, text: `## Clinical cloud program FY27 — summary to date

**What Meridian wants:** 14 clinical applications out of two aging data centers in three waves, with zero-downtime cutovers and compliance controls that keep up.

**Done so far**
- **Wave 1 (TR-10418) — complete.** Patient portal and identity provider live in cloud, active-active across two regions, 4,000 staff on SSO; staging dry run cut from 22 to 9 minutes before go-live; acceptance signed.
- **Wave 2 (TR-10421) — in progress.** 140 interface flows across two engines, each with a test case; latency to the cloud interface engine 18 ms p95 (budget 40 ms); runbook v1 out for review.
- **Quarantine workflow (TR-10427).** Design agreed: detect drift, isolate, ticket the owner, release on pass.

**Open items**
- Wave 2 runbook sign-off and firewall change requests.
- Storage specialist needed before wave 3 can start.` },
      { daysAgo: 3, text: `## Clinical cloud program FY27 — summary to date

**What Meridian wants:** 14 clinical applications out of two aging data centers in three waves, with zero-downtime cutovers and compliance controls that keep up.

**Status by request**
- **Wave 1 (TR-10418) — closed won.** Portal and identity live, 4,000 staff on SSO, acceptance signed.
- **Wave 2 (TR-10421) — cutover complete.** Scheduling moved the first weekend with no sev-1s; lab integrations went live with all 140 flows green. 48-hour watch before the old engines are decommissioned.
- **Wave 3 (TR-10423) — starting.** 210 TB imaging archive; sub-3-second retrieval for the last two years of studies is the hard requirement. Waiting on a storage specialist.
- **Quarantine workflow (TR-10427) — blocked.** Their ticketing API is not available until next quarter; email-to-ticket proposed as an interim.

**Program management**
- Wave 2 engineer assigned after an escalation; storage specialist requested for wave 3.

**Next steps**
- Decommission the wave 2 interface engines after the watch period.
- Land the storage specialist and schedule the archive assessment.
- Decide on the interim ticketing approach for quarantine.` },
    ] },
    { scope: 'opportunity', key: 'blu-wan', versions: [
      { daysAgo: 9, text: `## Bluewater — Depot WAN refresh

**Goal:** replace branch routers at 62 depots with a dual-uplink design (broadband + LTE) that protects voice and the warehouse application; competing with the incumbent's refresh quote.

**Requests**
- **Pilot, five depots (TR-10388):** failover measured at 1.4 s with no dropped calls; warehouse app p95 down from 310 ms to 140 ms with steering. Four of five depots meet every exit criterion.
- **LTE failover (TR-10389):** carrier B stronger at 4 of 5 sites; private APN; threshold proposal sent (3 lost probes at 1 s, fail back after 60 s stable).
- **Voice QoS (TR-10395):** marking at the access switch agreed for 900 phones; queuing policy in draft.

**Changes:** the opportunity was renamed from "Depot network refresh" to match the budget line, and truck telemetry (TR-10402) moved to its own opportunity.

**Next:** close the last pilot criterion, confirm LTE thresholds against the voice SLA, run the dispatch-floor voice test.` },
    ] },
    { scope: 'customer', key: 'Northgate Financial', versions: [
      { daysAgo: 6, text: `## Northgate Financial — summary to date

**GenAI governance (parent + 3 requests).** Exec-driven: see what AI is used, set policy, then control it.
- Discovery (TR-10517): 61 tools found, 4 carry 85% of use; classified 3 sanctioned / 9 tolerated / rest blocked.
- Prompt data-loss controls (TR-10519): account numbers, card data and customer names prioritised; coach first, block after 30 days.
- Acceptable-use policy (TR-10522): draft with legal; waiting on a client-confidential clause.

**Workforce identity — phishing-resistant MFA (TR-10530).** Hardware keys for 400 privileged users first; 40-admin POC enrolled in about 6 minutes each; two legacy apps need exceptions.

**Next:** CISO acceptance of discovery, detector testing, legal wording, MFA rollout plan.` },
    ] },
    { scope: 'trr', key: 'fer-vend', versions: [
      { daysAgo: 15, text: `## TR-10461 — Vendor remote access to jump hosts

Ferrostahl wants identity-based, recorded access for 12 maintenance vendors instead of standing VPN accounts (7 vendors still have one). We proposed just-in-time sessions to the jump hosts and sent an access-request workflow to Jonas Becker. No response yet — the next step is a review of that workflow.` },
    ] },
  ],

  digests: [
    { tr: 'vel-net', daysAgo: 28, text: `**Veldt Energy — Control-center network redesign (closed won).** Redundant core for two control centers with dual-homed SCADA servers and deterministic paths. Lab testing showed 280 ms convergence on link loss, which carried the technical evaluation. Signed as part of the control-center award; installation starts next quarter. Lesson: leading with a measured convergence number beat the competitor's datasheet claims.` },
    { tr: 'cop-fw', daysAgo: 40, text: `**Copperfield Retail — Store firewall refresh (closed lost).** Central management and zero-touch provisioning for 140 stores demoed well and the technical evaluation passed. Lost on price when the incumbent renewed at a deep discount; no technical objections were raised. Copperfield has since re-engaged on POS network segmentation.` },
    { tr: 'ast', daysAgo: 90, text: `**Aster & Pine Architects — Secure contractor workspace (archived).** Isolated access to project files for 40 contractors without full virtual desktops was a good fit, but a company re-org froze IT projects and the champion left. Archived; revisit only if they re-engage.` },
    { tr: 'mer-w1', daysAgo: 60, text: `**Meridian — Wave 1, patient portal and identity (closed won).** Active-active portal across two regions with conditional access in front of the identity provider; 4,000 staff on SSO. A staging dry run cut the cutover from 22 to 9 minutes by fixing DNS TTLs; production went live with zero downtime and acceptance was signed.` },
  ],

  reports: [
    { fromDaysAgo: 97, toDaysAgo: 7, daysAgo: 7, narrative: `## Quarter in review

**Headline:** two programs moved decisively — Meridian's clinical cloud program completed wave 1 and is closing wave 2, and Veldt Energy's control-center modernization closed won. Copperfield's store refresh was lost on price with no technical objections.

**Where time went:** most activity sat with the two largest programs (Meridian, Bluewater), each run as a parent request with child requests per workstream. Northgate's GenAI governance went from kickoff to an accepted discovery in about six weeks.

**Wins and evidence**
- Veldt: measured 280 ms convergence in the lab carried the technical evaluation.
- Meridian wave 1: zero-downtime cutover; 4,000 staff on SSO.
- Bluewater pilot: 1.4 s failover with no dropped calls; app latency more than halved.

**Risks**
- Quill & Sable has been waiting on its security council for over three weeks.
- Ferrostahl vendor access has had no reply for more than two weeks.
- Meridian wave 3 depends on landing a storage specialist.` },
  ],

  imports: [
    { label: 'Tidal Grid tracker (sheet)', daysAgo: 9, raw: [
      'TR ID\tCustomer\tRequest\tDate\tUpdate',
      'TR-10490\tTidal Grid Utilities\tCentralized configuration management\t' + '{{d23}}' + '\tReviewed the object clean-up list: 1,240 unused objects safe to remove.',
      'TR-10490\tTidal Grid Utilities\tCentralized configuration management\t' + '{{d16}}' + '\tSent the migration runbook draft: read-only visibility, one region, then cutover.',
      'TR-10494\tTidal Grid Utilities\tConfig-drift reporting via API\t' + '{{d25}}' + '\tWalked through the first drift report: 23 differences, mostly logging profiles.',
    ].join('\n') },
  ],
};

export function seedIfEmpty(): boolean {
  const n = (db.prepare('SELECT count(*) n FROM trrs').get() as { n: number }).n;
  if (n > 0) return false;
  // dates in the sample sheet follow the story's relative days
  const d = (ago: number) => new Date(Date.now() - ago * 86_400_000).toLocaleDateString('en-US');
  for (const im of story.imports ?? []) im.raw = im.raw.replace(/\{\{d(\d+)\}\}/g, (_, a: string) => d(Number(a)));
  const r = runSeed(story);
  console.log(`Seeded ${r.trs} TRs / ${r.logs} interactions`);
  return true;
}
