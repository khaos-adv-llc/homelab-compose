#!/usr/bin/env bash
# Weekly full apt upgrade for media-server, with an ntfy notification summarizing
# the result. Complements (does not replace) unattended-upgrades, which keeps
# doing daily *security-only* patches on its own schedule -- this handles
# everything else (regular repo updates, driver-line transitions like the
# 535->580 NVIDIA one, etc.) once a week, and makes sure a stuck/held-back
# package (like that NVIDIA transition sitting silent for 3+ weeks) actually
# surfaces instead of just logging quietly to
# /var/log/unattended-upgrades/unattended-upgrades.log where nobody looks.
#
# Install: /usr/local/sbin/weekly-full-upgrade.sh (root-owned, 0755)
# Needs NTFY_TOKEN set in /etc/default/weekly-full-upgrade (see below) --
# that file is NOT committed to the repo, create it by hand on the host.
set -uo pipefail

# shellcheck disable=SC1091
[ -f /etc/default/weekly-full-upgrade ] && source /etc/default/weekly-full-upgrade

NTFY_URL="${NTFY_URL:-https://ntfy.valdeze.ch/homelab-updates}"
NTFY_TOKEN="${NTFY_TOKEN:?NTFY_TOKEN not set -- create /etc/default/weekly-full-upgrade}"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

{
    echo "=== weekly-full-upgrade: $(date -Is) ==="
    apt-get update
} >>"$LOG" 2>&1

# --force-confdef/--force-confold: on a conffile prompt, keep the local
# version unless there's no local change, in which case take the new
# default. This is what actually would have unstuck the NVIDIA
# 535->580 transition automatically instead of it looping unattended
# for weeks -- unattended-upgrades deliberately skips these prompts,
# this weekly job deliberately answers them.
UPGRADE_OUT="$(DEBIAN_FRONTEND=noninteractive apt-get -y \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    full-upgrade 2>&1)"
UPGRADE_STATUS=$?
echo "$UPGRADE_OUT" >>"$LOG"

apt-get -y autoremove --purge >>"$LOG" 2>&1
apt-get clean >>"$LOG" 2>&1

HELD_BACK="$(echo "$UPGRADE_OUT" | grep -i "kept back" || true)"
REBOOT_NEEDED="no"
[ -f /var/run/reboot-required ] && REBOOT_NEEDED="yes"

if [ "$UPGRADE_STATUS" -ne 0 ]; then
    PRIORITY="urgent"
    TITLE="media-server: weekly upgrade FAILED"
    BODY="apt full-upgrade exited $UPGRADE_STATUS.
$HELD_BACK"
elif [ -n "$HELD_BACK" ]; then
    PRIORITY="high"
    TITLE="media-server: upgrade ran, packages held back"
    BODY="$HELD_BACK

Reboot required: $REBOOT_NEEDED"
else
    PRIORITY="default"
    TITLE="media-server: weekly upgrade OK"
    BODY="All packages up to date. Reboot required: $REBOOT_NEEDED"
fi

curl -sf \
    -H "Authorization: Bearer $NTFY_TOKEN" \
    -H "Title: $TITLE" \
    -H "Priority: $PRIORITY" \
    -H "Tags: package" \
    -d "$BODY" \
    "$NTFY_URL" || echo "WARNING: ntfy notification failed to send" >>"$LOG"

# Keep a copy of the last run's log for manual inspection.
cp "$LOG" /var/log/weekly-full-upgrade.log
