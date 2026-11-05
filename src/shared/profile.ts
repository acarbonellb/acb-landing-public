// The CV as the portfolio agent serves it: its tools (agent/src/tools.ts) read
// these values and the landing sections render the same ones, so the page and
// the agent never disagree. Keep it plain data: no JSX, no formatting.
//
// Editing a value here changes what the tools return to the model, which makes
// every eval recording stale (ADR 0001): only a new live run fixes it. Copy the
// page shows but the model never reads goes in `site-copy.ts`; formatting
// helpers go in `format.ts`.

/** A year range; `to: null` means "present". */
export type Period = { from: number; to: number | null };

export type Profile = {
  name: string;
  handle: string;
  title: string;
  location: string;
  /** One-line pitch, shown in the hero terminal. */
  tagline: string;
  /** About paragraphs. */
  summary: string[];
  /** Short call to action above the contact link ("ask my agent", or LinkedIn). */
  contactNote: string;
  /** No email: the repo is public. The agent reads it from its environment (#51). */
  links: { github: string; linkedin: string };
};

/** Statuses the CV states; a project without one makes no status claim. */
export const agentStatuses = [
  "in-progress",
  "offline-evals",
  "coming-soon",
  "personal-project",
] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export type AgentProject = {
  slug: string;
  name: string;
  status?: AgentStatus;
  /** Who it was built for. */
  context: string;
  description: string;
  /** Measured result, one line: what the evals showed. */
  result?: string;
  /** Secondary line under the result: caveats, cost, run counts. */
  resultDetail?: string;
  stack: string[];
  /** Where the whole card points: e.g. the chat on this page. */
  href?: string;
  /** Extra links on the card, e.g. its source and eval report. */
  links?: PracticeSource[];
};

/** Where a practice can be checked: this public repo or a card on the page. */
export type PracticeSource = { label: string; href: string };

/**
 * One "how I run agents" bullet (#43). State only what a public source backs:
 * this repo, or approved copy already on the page. Never link a private repo.
 */
export type Practice = {
  title: string;
  text: string;
  sources: PracticeSource[];
};

export type Role = {
  slug: string;
  /** Short commit-style hash, decorative (git log styling). */
  hash: string;
  company: string;
  role: string;
  place: string;
  period: Period;
  /** What the company does; optional. */
  description?: string;
  highlights: string[];
  /** Technologies used in this role. */
  stack: string[];
};

export type SkillGroup = {
  /** Identifier-style key, rendered as an object key in stack.ts. */
  key: string;
  label: string;
  items: string[];
};

export type Education = {
  title: string;
  school: string;
  place: string;
  period: Period;
};

export type SpokenLanguage = { name: string; level: string };

export const profile: Profile = {
  name: "Alberto Carbonell",
  handle: "acarbonellb",
  title: "Senior Software Engineer — AI Agents & Full-Stack TypeScript",
  location: "Spain · Remote",
  tagline:
    "Senior engineer, 10+ years with TypeScript, Node.js and PostgreSQL. I build AI agents that do real work end to end.",
  summary: [
    "Senior engineer with 10+ years shipping production software in TypeScript, Node.js and PostgreSQL. Lately my focus has been building AI agents that handle real work end to end, wired into the tools and data a business already uses. With AI in the loop I ramp up fast on any new stack; what never changes is the fundamentals: clean design, tests and code that's easy to maintain.",
    "I work closely with non-technical teams to find where agents save time or money, then build, deploy and monitor them. I use Claude daily: through its API to build agents, and in my own engineering workflow via Claude Code and OpenCode.",
  ],
  contactNote: "Drop me a line:",
  links: {
    github: "https://github.com/acarbonellb",
    linkedin: "https://www.linkedin.com/in/albertocarbonell/",
  },
};

const ticketing = "An online event ticketing platform";

const repo = "https://github.com/acarbonellb/acb-landing-public";

export const agentProjects: AgentProject[] = [
  {
    slug: "fraud-detection-agent",
    name: "Fraud Detection Agent",
    status: "offline-evals",
    context: ticketing,
    description:
      "Reviews newly published events and organizers on an event ticketing platform and leaves an approve / reject / request-info recommendation, with its reasons, for a human admin. Graded autonomy: it auto-approves only on evidence verified in code, and web sources can hold a decision back but never approve it.",
    result:
      "Offline evals, 31 cases: on a local 9B model, approved fraud fell from 54% to 8% over twelve iterations, and fraud approved without a human from 27% to 0%. Claude Haiku 5.5, chosen for deployment: 86% accuracy vs 71%, 1% of fraud approved vs 8%.",
    resultDetail:
      "Haiku escalates more cases to a human (86% vs 71%). About $0.002 per review. Haiku: mean of 3 runs; local model: 1 run.",
    stack: ["TypeScript", "PostgreSQL", "GCP"],
  },
  {
    slug: "organizer-support-agent",
    name: "Organizer Support Agent",
    status: "coming-soon",
    context: ticketing,
    description:
      "Answers event organizers' questions about sales, payouts and setup without human review, pulling live data from PostgreSQL and the payments API.",
    stack: ["TypeScript", "Tool calling", "MCP", "PostgreSQL"],
  },
  {
    slug: "portfolio-agent",
    name: "Portfolio Agent",
    status: "personal-project",
    context: "This portfolio site",
    description:
      "Agent on my portfolio site that answers visitors' questions about my experience and projects in natural language. Also exposed as an MCP server so external agents can query it.",
    stack: ["TypeScript", "Claude", "MCP"],
    href: "#agent",
    // No `result` here, on purpose: the page adds the eval results line at
    // build time (src/lib/eval-results.ts), from the eval history a live run
    // writes. Served through a tool, the line would be in the recordings, so
    // every live run would change the tool output and make its own recordings
    // stale: a re-record loop. It stays page-only.
    links: [
      { label: "source", href: `${repo}/tree/main/agent` },
      { label: "eval report", href: `${repo}/blob/main/agent/evals/report.md` },
    ],
  },
];

export const practices: Practice[] = [
  {
    title: "Offline evals before shipping",
    text: "This site's agent records its eval cases against a real model and replays them in CI, with no model or network: a stale recording or an off-topic leak fails the build.",
    sources: [
      {
        label: "ADR 0001",
        href: `${repo}/blob/main/docs/adr/0001-agent-evals-record-replay.md`,
      },
    ],
  },
  {
    // Backed only by the fraud agent's approved copy above (#41).
    title: "Graded autonomy, a human in the loop",
    text: "The fraud detection agent recommends and a human admin decides; it approves on its own only on evidence verified in code.",
    sources: [{ label: "Fraud Detection Agent", href: "#agent-fraud-detection-agent" }],
  },
  {
    title: "Cost and limits tracked",
    text: "A token budget per request, per-IP rate limits and a monthly spend cap on this site's agent; every eval report shows mean tokens, latency and cost per case.",
    sources: [
      { label: "guardrails", href: `${repo}#guardrails` },
      { label: "eval report", href: `${repo}/blob/main/agent/evals/report.md` },
    ],
  },
  {
    title: "Changes measured run over run",
    text: "Every eval run appends its metrics to a history, so a prompt, tool or content change that moves the numbers shows up next to the run before it.",
    sources: [
      { label: "eval history", href: `${repo}/blob/main/agent/evals/history.jsonl` },
    ],
  },
];

export const experience: Role[] = [
  {
    slug: "coverwallet",
    hash: "a1f3c9e",
    company: "CoverWallet",
    role: "Senior Software Engineer",
    place: "Madrid / Remote",
    period: { from: 2019, to: null },
    description:
      "Insurtech platform integrating external insurance carriers into a single commerce flow.",
    highlights: [
      "Led multiple cross-team projects end to end, from architecture to production, in React, Node.js/TypeScript and Ruby on Rails.",
      "Integrated third-party insurance carrier APIs into the core platform.",
      "Introduced AI agents into the team's engineering workflow (code review, refactoring, docs) and set guidelines to use them well and avoid common agentic-coding pitfalls.",
      "Mentored new hires and drove engineering standards.",
    ],
    stack: ["TypeScript", "Node.js", "React", "Ruby on Rails"],
  },
  {
    slug: "mgt-consulting",
    hash: "7b2d01f",
    company: "M&GT Consulting",
    role: "Software Developer",
    place: "Madrid",
    period: { from: 2016, to: 2019 },
    highlights: [
      "Built REST APIs in Node.js and web/mobile apps (iOS/Android) for large international clients.",
      "Delivered blockchain solutions on Hyperledger Fabric and Ethereum.",
    ],
    stack: ["Node.js", "REST", "iOS", "Android", "Hyperledger Fabric", "Ethereum"],
  },
  {
    slug: "indra",
    hash: "c40e8aa",
    company: "Indra",
    role: "Software Developer",
    place: "A Coruña",
    period: { from: 2015, to: 2016 },
    highlights: [
      "Java/Spring and Oracle PL/SQL for telecom clients; QA and hotfixes.",
    ],
    stack: ["Java", "Spring", "Oracle PL/SQL"],
  },
];

export const skillGroups: SkillGroup[] = [
  {
    key: "ai",
    label: "AI / agents",
    items: [
      "Claude",
      "Grok",
      "Open-source models (cloud and local via Ollama)",
      "Tool calling",
      "MCP",
      "Agent evals and monitoring",
    ],
  },
  {
    key: "languages",
    label: "Languages",
    items: ["TypeScript", "JavaScript", "Ruby"],
  },
  {
    key: "backend",
    label: "Backend & data",
    items: [
      "Node.js",
      "NestJS",
      "Express",
      "Next.js",
      "REST",
      "GraphQL",
      "PostgreSQL",
      "MongoDB",
    ],
  },
  {
    key: "infra",
    label: "Infra",
    items: ["Docker", "Kubernetes", "CircleCI", "Vercel", "Railway", "Neon", "GCP"],
  },
  {
    key: "frontend",
    label: "Frontend",
    items: ["React", "React Native", "Angular"],
  },
];

export const education: Education[] = [
  {
    title:
      "Higher Technical Diplomas (CFGS) in Web Development, Multiplatform Development and Systems Administration",
    school: "CIFP Rodolfo Ucha Piñeiro",
    place: "A Coruña",
    period: { from: 2010, to: 2015 },
  },
];

export const languages: SpokenLanguage[] = [
  { name: "Spanish", level: "Native" },
  { name: "English", level: "C1" },
];
