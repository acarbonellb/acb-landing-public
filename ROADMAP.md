# Roadmap

Goal: a portfolio at albertocarbonell.dev that presents my experience and works as a live demo of what I build: React/TypeScript, GCP and AI agents connected to tools.

## Architecture

```
albertocarbonell.dev
   ├─ /*          ──► Firebase Hosting (static Next.js export, CDN, no cold starts)
   └─ /api/agent  ──► Cloud Run: agent + MCP server (TypeScript)

albertocarbonell.es ──► 301 redirect to albertocarbonell.dev
```

## Phase 1 — Static landing

- [x] Next.js + React + TypeScript + Tailwind, static export (`output: "export"`)
- [x] Retro dev style, Tokyo Night (default) / Tokyo Light switcher
- [x] Sections with placeholder content: hero, about, stack, experience, projects, agent, contact
- [x] GitHub Actions deploy to Firebase Hosting with Workload Identity Federation
- [ ] Create public GitHub repo `acb-landing-public` and push
- [ ] Replace lorem ipsum with real content (`src/content/profile.ts`)
- [ ] Open Graph image, favicon, `robots.txt`, `sitemap.xml`

## Phase 1.5 — GCP & domains

- [ ] Install `gcloud` and `firebase-tools`, log in
- [ ] Billing account + budget alert (e.g. 5 €)
- [ ] GCP project with Firebase and a Hosting site
- [ ] Workload Identity Federation pool/provider for the repo + deploy service account
- [ ] Repository variables `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`
- [ ] First deploy from CI
- [ ] Custom domain `albertocarbonell.dev` in Firebase Hosting, DNS records in GoDaddy
- [ ] `albertocarbonell.es` redirecting to `.dev`

## Phase 2 — "About me" agent + MCP server

The same tools serve both the landing chat and any external MCP client.

- [ ] `agent/` service in TypeScript, deployed to Cloud Run (scale to zero)
- [ ] MCP server over Streamable HTTP with tools: `get_profile`, `get_experience`, `get_projects`, `get_stack`, `get_contact`
- [ ] Tools read from the same data as the landing (shared with `src/content/profile.ts`)
- [ ] Chat endpoint `/api/agent`: Claude with tool use over those tools, streaming responses
- [ ] Check whether the Firebase Hosting rewrite to Cloud Run streams correctly; if not, call Cloud Run directly from the browser (CORS)
- [ ] Anthropic API key in Secret Manager
- [ ] Guardrails: rate limiting per IP, max tokens per request, monthly spend cap, scope limited to questions about me
- [ ] Chat UI in the "ask my agent" section (terminal style)
- [ ] "Connect your own agent" snippet on the landing (`claude mcp add …`) pointing to the public MCP endpoint
- [ ] CI deploy for the agent service (same Workload Identity Federation setup)

## Phase 3 — Ideas

- [ ] Evals for the agent: a set of questions with expected answers, run in CI
- [ ] Basic observability: logs and token usage in Cloud Logging
- [ ] Spanish version of the landing
- [ ] Rewrite the agent service in Go
- [ ] GraphQL API for the profile data
