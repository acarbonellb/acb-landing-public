// The one tool layer of the Portfolio Agent. The MCP server serves these tools
// as-is and the chat endpoint hands them to the model, so both interfaces
// answer from the same data. Read-only and public by design: every tool only
// reads the shared content module.
import * as z from "zod";
import { formatPeriod } from "../../src/shared/format";
import * as shared from "../../src/shared/profile";
import type {
  AgentProject,
  Education,
  Practice,
  Profile,
  Role,
  SkillGroup,
  SpokenLanguage,
} from "../../src/shared/profile";

/** Everything the tools read. Defaults to the landing's content module. */
export type Content = {
  profile: Profile;
  agentProjects: AgentProject[];
  /** How he runs agents (#43), served with the projects. */
  practices: Practice[];
  experience: Role[];
  skillGroups: SkillGroup[];
  education: Education[];
  languages: SpokenLanguage[];
  /**
   * The address `get_contact` gives out. Not in the public repo: production
   * reads it from `CONTACT_EMAIL` (`config.ts`, wired in `compose.ts`); without it there's no email.
   */
  contactEmail?: string;
};

export const siteContent: Content = {
  profile: shared.profile,
  agentProjects: shared.agentProjects,
  practices: shared.practices,
  experience: shared.experience,
  skillGroups: shared.skillGroups,
  education: shared.education,
  languages: shared.languages,
};

/** A tool's input or output: always a JSON object (MCP structured content). */
type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export type ToolDefinition<
  I extends ObjectSchema = ObjectSchema,
  O extends ObjectSchema = ObjectSchema,
> = {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  run: (input: z.infer<I>) => z.infer<O>;
};

function defineTool<I extends ObjectSchema, O extends ObjectSchema>(
  tool: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return tool;
}

const period = z.string().describe('Year range, e.g. "2019 — now"');

/** Links that work off the page: one to a card on it means nothing to an MCP client. */
const offPageLinks = (links: shared.PracticeSource[]) =>
  links.filter((l) => l.href.startsWith("https://")).map((l) => ({ label: l.label, url: l.href }));

function buildTools(content: Content) {
  const groupKeys = content.skillGroups.map((g) => g.key);

  return {
    get_profile: defineTool({
      name: "get_profile",
      title: "Profile",
      description:
        "Who Alberto is: name, title, location, a one-line pitch, the about summary, education and spoken languages.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        name: z.string(),
        title: z.string(),
        location: z.string(),
        tagline: z.string(),
        summary: z.array(z.string()),
        education: z.array(
          z.object({
            title: z.string(),
            school: z.string(),
            place: z.string(),
            period,
          }),
        ),
        languages: z.array(z.object({ name: z.string(), level: z.string() })),
      }),
      run: () => ({
        name: content.profile.name,
        title: content.profile.title,
        location: content.profile.location,
        tagline: content.profile.tagline,
        summary: content.profile.summary,
        education: content.education.map((e) => ({
          title: e.title,
          school: e.school,
          place: e.place,
          period: formatPeriod(e.period),
        })),
        languages: content.languages.map(({ name, level }) => ({ name, level })),
      }),
    }),

    get_experience: defineTool({
      name: "get_experience",
      title: "Work experience",
      description:
        "Alberto's work history, most recent first: company, role, place, period, highlights and stack. Optionally filter by company name.",
      inputSchema: z
        .object({
          company: z
            .string()
            .min(1)
            .max(100)
            .optional()
            .describe("Case-insensitive part of a company name, e.g. \"indra\""),
        })
        .strict(),
      outputSchema: z.object({
        roles: z.array(
          z.object({
            company: z.string(),
            role: z.string(),
            place: z.string(),
            period,
            current: z.boolean(),
            description: z.string().optional(),
            highlights: z.array(z.string()),
            stack: z.array(z.string()),
          }),
        ),
      }),
      run: ({ company }) => {
        const query = company?.toLowerCase();
        return {
          roles: content.experience
            .filter((r) => !query || r.company.toLowerCase().includes(query))
            .map((r) => ({
              company: r.company,
              role: r.role,
              place: r.place,
              period: formatPeriod(r.period),
              current: r.period.to === null,
              ...(r.description ? { description: r.description } : {}),
              highlights: r.highlights,
              stack: r.stack,
            })),
        };
      },
    }),

    get_projects: defineTool({
      name: "get_projects",
      title: "Agent projects",
      description:
        "AI agents Alberto has built: what each does, its context, its status (only when there is one: in progress, offline evals with deployment next, coming soon meaning not built yet, or personal project), its measured result with a detail line (only when there is one), stack and links (e.g. its source code, where public). Also how he builds and runs agents: evals, human in the loop, cost and limits, measuring changes, each with links to public sources where they exist. Optionally filter the projects by status.",
      inputSchema: z
        .object({
          status: z
            .enum(shared.agentStatuses)
            .optional()
            .describe("Only projects with this status"),
        })
        .strict(),
      outputSchema: z.object({
        projects: z.array(
          z.object({
            name: z.string(),
            status: z.enum(shared.agentStatuses).optional(),
            context: z.string(),
            description: z.string(),
            result: z.string().optional(),
            resultDetail: z.string().optional(),
            stack: z.array(z.string()),
            links: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
          }),
        ),
        practices: z.array(
          z.object({
            title: z.string(),
            text: z.string(),
            sources: z
              .array(z.object({ label: z.string(), url: z.string() }))
              .optional(),
          }),
        ),
      }),
      run: ({ status }) => ({
        projects: content.agentProjects
          .filter((a) => !status || a.status === status)
          .map((a) => {
            const links = offPageLinks(a.links ?? []);
            return {
              name: a.name,
              status: a.status,
              context: a.context,
              description: a.description,
              ...(a.result ? { result: a.result } : {}),
              ...(a.resultDetail ? { resultDetail: a.resultDetail } : {}),
              stack: a.stack,
              ...(links.length ? { links } : {}),
            };
          }),
        practices: content.practices.map(({ title, text, sources }) => {
          const links = offPageLinks(sources);
          return { title, text, ...(links.length ? { sources: links } : {}) };
        }),
      }),
    }),

    get_stack: defineTool({
      name: "get_stack",
      title: "Tech stack",
      description:
        "Alberto's skills grouped by area (AI/agents, languages, backend & data, infra, frontend). Optionally return a single group.",
      inputSchema: z
        .object({
          group: z
            .enum(groupKeys as [string, ...string[]])
            .optional()
            .describe("Key of one skill group"),
        })
        .strict(),
      outputSchema: z.object({
        groups: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            items: z.array(z.string()),
          }),
        ),
      }),
      run: ({ group }) => ({
        groups: content.skillGroups
          .filter((g) => !group || g.key === group)
          .map(({ key, label, items }) => ({ key, label, items })),
      }),
    }),

    get_contact: defineTool({
      name: "get_contact",
      title: "Contact",
      description: content.contactEmail
        ? "How to reach Alberto: email, GitHub and LinkedIn, plus where he works from."
        : "How to reach Alberto: GitHub and LinkedIn, plus where he works from. No email address is available here: point people to LinkedIn to message him.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        name: z.string(),
        note: z.string(),
        email: z.string().optional(),
        github: z.string(),
        linkedin: z.string(),
        location: z.string(),
      }),
      run: () => ({
        name: content.profile.name,
        note: content.contactEmail
          ? content.profile.contactNote
          : `No email address is available here: message ${content.profile.name} on LinkedIn.`,
        ...(content.contactEmail ? { email: content.contactEmail } : {}),
        github: content.profile.links.github,
        linkedin: content.profile.links.linkedin,
        location: content.profile.location,
      }),
    }),
  };
}

type Tools = ReturnType<typeof buildTools>;
export type ToolName = keyof Tools;
export type ToolOutput<N extends ToolName> = ReturnType<Tools[N]["run"]>;

export class ToolInputError extends Error {}

export type Toolset = {
  list(): ToolDefinition[];
  /** Validates `args` against the tool's input schema, then runs it. */
  call<N extends ToolName>(name: N, args: unknown): ToolOutput<N>;
  call(name: string, args: unknown): Record<string, unknown>;
};

export function createToolset(content: Content = siteContent): Toolset {
  const tools = buildTools(content);
  const byName = new Map<string, ToolDefinition>(
    Object.values(tools).map((t) => [t.name, t as unknown as ToolDefinition]),
  );

  return {
    list: () => [...byName.values()],
    call(name: string, args: unknown) {
      const tool = byName.get(name);
      if (!tool) throw new ToolInputError(`Unknown tool: ${name}`);
      const parsed = tool.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolInputError(
          `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`,
        );
      }
      return tool.run(parsed.data);
    },
  } as Toolset;
}
