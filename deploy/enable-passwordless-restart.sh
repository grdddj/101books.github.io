#!/usr/bin/env bash
#
# Allow restarting the reader without typing a sudo password, so an automated
# agent can restart the service after changing reader/server.py.
#
#   sudo ./deploy/enable-passwordless-restart.sh
#   sudo ./deploy/enable-passwordless-restart.sh --remove
#
# The grant is limited to tsumego.service. It does not widen sudo in general:
# every other command still asks for the password as before.
#
set -euo pipefail

RUN_USER=${RUN_USER:-${SUDO_USER:-jirka}}
SERVICE=${SERVICE:-tsumego.service}
# sudoers.d ignores any filename containing a dot, hence the bare name.
SUDOERS_FILE=/etc/sudoers.d/tsumego

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "run with sudo"
command -v visudo >/dev/null || die "visudo is required"

if [[ ${1:-} == "--remove" ]]; then
    log "Removing ${SUDOERS_FILE}"
    rm -f "${SUDOERS_FILE}"
    echo "Removed. Restarting ${SERVICE} needs a password again."
    exit 0
fi

id -u "${RUN_USER}" >/dev/null 2>&1 || die "user '${RUN_USER}' does not exist"
systemctl list-unit-files "${SERVICE}" --no-legend | grep -q . \
    || die "${SERVICE} is not installed; run deploy/deploy.sh first"

# Sudoers matches the command line literally, so each spelling the caller might
# use needs its own entry -- "restart tsumego" does not match "restart
# tsumego.service".
UNIT_SHORT=${SERVICE%.service}
log "Granting ${RUN_USER} passwordless control of ${SERVICE}"

temporary_file=$(mktemp)
trap 'rm -f "${temporary_file}"' EXIT
{
    echo "# Managed by deploy/enable-passwordless-restart.sh of the 101books Go reader."
    echo "# Scoped to ${SERVICE} so an agent can restart the reader unattended."
    for verb in restart start stop status; do
        echo "${RUN_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl ${verb} ${SERVICE}"
        echo "${RUN_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl ${verb} ${UNIT_SHORT}"
    done
    echo "${RUN_USER} ALL=(root) NOPASSWD: /usr/bin/journalctl -u ${SERVICE} *"
    echo "${RUN_USER} ALL=(root) NOPASSWD: /usr/bin/journalctl -u ${UNIT_SHORT} *"
} > "${temporary_file}"

# Never install an unvalidated sudoers file: a syntax error there can lock the
# machine out of sudo entirely.
visudo --check --file "${temporary_file}" >/dev/null \
    || die "generated sudoers file failed validation; nothing was installed"

install -o root -g root -m 0440 "${temporary_file}" "${SUDOERS_FILE}"
visudo --check >/dev/null || die "sudoers set is now invalid; remove ${SUDOERS_FILE}"

log "Verifying"
if sudo -n -u root -l -U "${RUN_USER}" 2>/dev/null | grep -q "systemctl restart ${SERVICE}"; then
    echo "rule active for ${RUN_USER}"
else
    echo "rule installed; run 'sudo -l' as ${RUN_USER} to confirm"
fi

cat <<EOM

  Installed ${SUDOERS_FILE}

  Now works without a password (as ${RUN_USER}):
    sudo systemctl restart ${SERVICE}
    sudo systemctl status ${SERVICE}
    sudo journalctl -u ${SERVICE} -n 50

  Undo with:
    sudo ./deploy/enable-passwordless-restart.sh --remove

EOM
