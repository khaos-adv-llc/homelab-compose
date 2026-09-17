# Mealie

[Mealie](https://mealie.io/) is a self-hosted recipe manager and meal
planner — import recipes from a URL, organize them, plan meals, generate
shopping lists. This deployment also wires in a local
[Ollama](https://ollama.com/) instance (an OpenAI-API-compatible local LLM
server, container name `paperless-ollama`) for AI-assisted features like
auto-tagging recipes, using a small local model (`llama3.2:3b`) rather than
a cloud API.

## Prerequisites

- An existing `proxy_net` and `shared-services` Docker network.
- A dedicated Postgres database (bundled in this same compose file as
  `mealie-postgres`).
- Authentik configured with an OIDC application/provider for Mealie, if you
  want OIDC login to actually work (`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`).
- A reachable Ollama instance at the hostname/port referenced by
  `OPENAI_BASE_URL` if you want AI features — this homelab's is named
  `paperless-ollama`, suggesting it may have originally been set up
  alongside a Paperless-ngx deployment not otherwise present in this repo.

## Running it standalone

Moderately portable. You'll need: your own Postgres (or reuse the bundled
`mealie-postgres` service, which has no dependency on anything else in this
repo), your own OIDC provider if you want SSO (or disable OIDC and use
Mealie's own local accounts), and either your own Ollama instance or none
at all (Mealie works fine without the AI features, just leave those env
vars unset). Change `BASE_URL` to whatever hostname you'll actually serve
this from.

## How it fits into this homelab

- **Traefik / hostname**: not Traefik-routed by design. Mealie is reached
  externally via Pangolin at `meals.valdeze.ch` (confirmed by Tucker) —
  internal-only access via Traefik was tried and dropped as clunky for
  phone/computer app use, so its `traefik.*` labels are deliberately
  commented out rather than an oversight. `BASE_URL` and the (inactive)
  label both correctly reference `meals.valdeze.ch`.
- **Networks**: `default` (for its own Postgres), `proxy_net`, and
  `shared-services`.
- **Git Sync**: wired up like every other non-exempt stack.
- **Secrets**: `MEALIE_DB_PASSWORD`, `MEALIE_OIDC_CLIENT_ID`, and
  `MEALIE_OIDC_CLIENT_SECRET` are Infisical-backed via `render-env.sh`.

## Notes / gotchas

- **Confirmed by Tucker: Mealie is intentionally not Traefik-routed.** It's
  reached externally via Pangolin at `meals.valdeze.ch` instead —
  internal-only access via Traefik was tried and dropped as clunky for
  phone/computer app use. The commented-out labels have been corrected
  (hostname now matches `BASE_URL`, and `certresolver` now reads
  `cloudflare` instead of the stale `letsencrypt`) so they'd work
  correctly if this ever gets revisited, but they remain intentionally
  disabled.
- `OPENAI_SEND_DATABASE_DATA: "true"` sends more of Mealie's own database
  content to the local Ollama instance for better tagging suggestions —
  since Ollama is local/self-hosted here, that's a much smaller privacy
  consideration than it would be against a cloud LLM API, but worth
  knowing if this ever points at a different Ollama endpoint.
