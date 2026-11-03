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
export const agentStatuses = ["in-progress", "personal-project"] as const;
export type AgentStatus = (typeof agentStatuses)[number];

export type AgentProject = {
  slug: string;
  name: string;
  status?: AgentStatus;
  /** Who it was built for. */
  context: string;
  description: string;
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

const satella =
  "Satella Tickets, the event ticketing platform I co-founded and run as a side business";

export const agents: AgentProject[] = [
  {
    slug: "fraud-detection-agent",
    name: "Fraud Detection Agent",
    status: "in-progress",
    context: satella,
    description:
      "Monitors ticket purchases and flags or blocks suspicious orders (e.g. card testing, bulk resale patterns) without manual review. Escalates to a human below a confidence threshold.",
    stack: ["TypeScript", "PostgreSQL", "GCP"],
  },
  {
    slug: "organizer-support-agent",
    name: "Organizer Support Agent",
    context: satella,
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

/** "2019 — now", "2016 — 2019". */
export function formatPeriod({ from, to }: Period): string {
  return `${from} — ${to ?? "now"}`;
}
