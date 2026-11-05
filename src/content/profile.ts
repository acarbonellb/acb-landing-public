// Single source of truth for the CV. The landing sections render it and the
// portfolio agent reads it, so keep it plain data: no JSX, no formatting.

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
  /** Short call to action above the contact email. */
  contactNote: string;
  links: { email: string; github: string; linkedin: string };
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
  href?: string;
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
    email: "alberto.carbonell.beceiro@gmail.com",
    github: "https://github.com/acarbonellb",
    linkedin: "https://www.linkedin.com/in/albertocarbonell/",
  },
};

const ticketing = "An online event ticketing platform";

export const agents: AgentProject[] = [
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

/**
 * Shown under the chat input. Each claim is checked against the agent's code
 * and the GCP config (PR for #46): re-check it when logging, the store or the
 * model provider changes. Site-only: no tool, tool description or system
 * prompt reads it, so it never reaches the model.
 */
export const chatPrivacyNote =
  "Your questions go to Claude (Anthropic) to answer. Conversations aren't stored: the weekly usage stats keep only counts, tokens, cost and latency. Server logs keep your IP, browser, time and status for 30 days, and per-IP rate-limit counters expire after a minute and are then deleted. The agent and its MCP server share my contact email on purpose.";

/**
 * What the contact section's "ask my agent" button sends to the chat, as the
 * visitor's message (#50). The eval case `on11` asks exactly this and is
 * gated in CI (ADR 0001), as it's the site's contact path.
 */
export const contactQuestion = "I'd like to contact Alberto, what's his email address?";

/** "2019 — now", "2016 — 2019". */
export function formatPeriod({ from, to }: Period): string {
  return `${from} — ${to ?? "now"}`;
}
