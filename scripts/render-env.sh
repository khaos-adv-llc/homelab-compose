#!/usr/bin/env bash
# render-env.sh -- materializes a stack's real .env file from Infisical.
#
# Run this BEFORE Arcane's first Git sync for a stack (Arcane's Git sync
# currently fails if a compose file references a variable and no .env exists
# yet locally: https://github.com/getarcaneapp/arcane/issues/2566). After
# that first sync, run it on whatever schedule you want secrets refreshed
# (see homelab-env-render.timer for a systemd-driven option) -- Arcane's own
# Git-pull/redeploy cycle and this script's Infisical-pull cycle are
# independent of each other.
#
# Requires the Infisical CLI (https://infisical.com/docs/cli/overview)
# installed on the host, and a machine identity (Universal Auth) scoped
# read-only to secrets.
#
# Usage:
#   ./render-env.sh                # render every stack in STACKS
#   ./render-env.sh SearXNG AirTrail   # render only the named stack(s) --
#                                       # use this for the Phase 2 pilot so
#                                       # you don't touch every stack's live
#                                       # /docker/<stack>/.env at once.
#
# REPO_ROOT can be overridden via env var for smoke-testing against a
# scratch directory instead of the real /docker tree, e.g.:
#   sudo REPO_ROOT=/tmp/render-env-test ./render-env.sh

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/docker}"         # where Arcane's PROJECTS_DIRECTORY points
INFISICAL_DOMAIN="https://infisical.internal.valdeze.ch/api"  # self-hosted, not cloud SaaS
INFISICAL_PROJECT_ID="f067eba8-f3b1-4cd5-89c8-6425e81ca3b6"    # "Homelab" Secrets Management project
INFISICAL_ENV="prod"                      # single environment is enough for a homelab
INFISICAL_CLIENT_ID="cf4fd700-c720-4d2b-865b-e60f84f10122"    # render-env-host machine identity
INFISICAL_CLIENT_SECRET_FILE="/docker/.infisical/client-secret.txt"  # mode 600, root-owned, never in git

# Folder name in this repo == folder name under $REPO_ROOT == Infisical
# secrets path (/<stack>) -- all three now use the real on-host directory
# names confirmed via `tree -L 2 /docker` plus a couple of targeted `grep`s
# on Sept 16, 2026 (see homelab-context-brief_1.md's "Real On-Host Directory
# Names" table). All 18 stacks are listed here, including `postgres`
# (central Postgres already uses Docker secrets files for its own DB
# credentials, but this still renders anything else its compose references)
# and low/no-secret stacks like AdGuardHome/FileBrowser/searxng/
# MinecraftServer -- render just writes an empty/near-empty .env for those,
# which is harmless.
STACKS=(
    AdGuardHome
    AirTrail
    arcane
    Authentik
    AuthentikOutpost
    Cloudflared
    EdgeGateway
    FileBrowser
    HomeAssistant
    Mealie
    MinecraftServer
    postgres
    ReactiveResume
    searxng
    ServarrSuite
    Traefik
    Trek
    YTzero
)

# Optional positional args restrict which stacks get rendered -- validated
# against the known list so a typo fails loudly instead of silently no-op'ing.
if [[ $# -gt 0 ]]; then
    TARGET_STACKS=("$@")
    for s in "${TARGET_STACKS[@]}"; do
        found=0
        for known in "${STACKS[@]}"; do
            [[ "$s" == "$known" ]] && found=1 && break
        done
        if [[ "$found" -eq 0 ]]; then
            echo "ERROR: unknown stack '$s' -- must be one of: ${STACKS[*]}" >&2
            exit 1
        fi
    done
else
    TARGET_STACKS=("${STACKS[@]}")
fi

if [[ ! -f "$INFISICAL_CLIENT_SECRET_FILE" ]]; then
    echo "ERROR: $INFISICAL_CLIENT_SECRET_FILE not found. Bootstrap the machine identity first." >&2
    exit 1
fi

CLIENT_SECRET="$(cat "$INFISICAL_CLIENT_SECRET_FILE")"

INFISICAL_TOKEN="$(infisical login \
    --domain="$INFISICAL_DOMAIN" \
    --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$CLIENT_SECRET" \
    --silent --plain)"
export INFISICAL_TOKEN

render_one() {
    local stack="$1"
    local dest_dir="$REPO_ROOT/$stack"
    local dest_file="$dest_dir/.env"
    local tmp_file
    tmp_file="$(mktemp)"

    if ! infisical export \
            --domain="$INFISICAL_DOMAIN" \
            --projectId="$INFISICAL_PROJECT_ID" \
            --env="$INFISICAL_ENV" \
            --path="/$stack" \
            --format=dotenv-export \
            --token="$INFISICAL_TOKEN" > "$tmp_file" 2>/tmp/render-env.err; then
        echo "WARN: failed to render $stack (see /tmp/render-env.err) -- leaving existing .env untouched" >&2
        rm -f "$tmp_file"
        return 1
    fi

    mkdir -p "$dest_dir"
    mv "$tmp_file" "$dest_file"
    chmod 600 "$dest_file"
    chown tuckeraa:tuckeraa "$dest_file" 2>/dev/null || true
    echo "rendered $dest_file"
}

status=0
for stack in "${TARGET_STACKS[@]}"; do
    render_one "$stack" || status=1
done

exit $status
