#!/usr/bin/env bash
#
# Deploy the static Go problem reader behind Apache at
# https://jirkuvserver.cz/tsumego/
#
# It runs as your own user, straight out of this checkout -- no dedicated
# service account, no copy of the repository elsewhere.
#
#   sudo ./deploy/deploy.sh              # install or restart
#   sudo ./deploy/deploy.sh --uninstall  # remove service + Apache wiring
#
# Idempotent: re-run it after a git pull to pick the new code up.
#
set -euo pipefail

# --- configuration ----------------------------------------------------------

APP_DIR=${APP_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
RUN_USER=${RUN_USER:-${SUDO_USER:-jirka}}
DATA_DIR=${DATA_DIR:-${APP_DIR}/reader-data}
PORT=${PORT:-8123}
BASE_PATH=${BASE_PATH:-/tsumego}
DOMAIN=${DOMAIN:-jirkuvserver.cz}

SERVICE_NAME=tsumego.service
UNIT_FILE=/etc/systemd/system/${SERVICE_NAME}
VHOST_FILE=/etc/apache2/sites-available/${DOMAIN}-le-ssl.conf
PROXY_CONF=/etc/apache2/conf-available/tsumego.conf
PYTHON=/usr/bin/python3
# uv owns the dependencies now; the interpreter above is only used to check the
# version it will build the environment from.
UV=${UV:-}

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "run with sudo"

# --- uninstall --------------------------------------------------------------

if [[ ${1:-} == "--uninstall" ]]; then
    log "Stopping and removing ${SERVICE_NAME}"
    systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
    rm -f "${UNIT_FILE}"
    systemctl daemon-reload

    log "Removing Apache wiring"
    [[ -f ${VHOST_FILE} ]] && sed -i "\|Include ${PROXY_CONF}|d" "${VHOST_FILE}"
    rm -f "${PROXY_CONF}"
    apachectl configtest && systemctl reload apache2

    echo
    echo "Removed. The checkout and ${DATA_DIR} were left alone."
    exit 0
fi

# --- preflight --------------------------------------------------------------

log "Preflight checks"
[[ -f ${APP_DIR}/reader/server.py ]] || die "reader/server.py not found under ${APP_DIR}"
[[ -f ${APP_DIR}/uv.lock ]]          || die "uv.lock not found under ${APP_DIR}"
[[ -x ${PYTHON} ]]                   || die "python3 not found at ${PYTHON}"
id -u "${RUN_USER}" >/dev/null 2>&1  || die "user '${RUN_USER}' does not exist"
command -v apachectl >/dev/null      || die "apache2 is required"
[[ -f ${VHOST_FILE} ]]               || die "HTTPS vhost not found: ${VHOST_FILE}"

"${PYTHON}" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || die "python3 >= 3.10 is required"

# systemd runs with a bare PATH, so the unit needs uv by absolute path.
if [[ -z ${UV} ]]; then
    RUN_USER_HOME=$(getent passwd "${RUN_USER}" | cut -d: -f6)
    for candidate in "${RUN_USER_HOME}/.local/bin/uv" /usr/local/bin/uv /usr/bin/uv; do
        [[ -x ${candidate} ]] && { UV=${candidate}; break; }
    done
fi
[[ -n ${UV} && -x ${UV} ]] || die "uv not found; install it or pass UV=/path/to/uv"

# Built here rather than at service start: a boot must never depend on the
# network, and --frozen means the lock file is used exactly as committed.
log "Syncing dependencies with ${UV}"
sudo -u "${RUN_USER}" env -C "${APP_DIR}" "${UV}" sync --frozen \
    || die "uv sync failed"

# Refuse to steal a port that some other process already owns.
if ss -lnt "sport = :${PORT}" | grep -q LISTEN; then
    systemctl is-active --quiet "${SERVICE_NAME}" \
        || die "port ${PORT} is already in use by another process"
fi

install -d -o "${RUN_USER}" -g "${RUN_USER}" -m 0700 "${DATA_DIR}"

# --- systemd unit -----------------------------------------------------------

log "Installing ${UNIT_FILE} (runs as ${RUN_USER} from ${APP_DIR})"
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=101 Books Go problem reader
After=network.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=PYTHONUNBUFFERED=1
ExecStart=${UV} run --frozen --no-sync python -m reader.server --host 127.0.0.1 --port ${PORT} --base-path ${BASE_PATH} --data-dir ${DATA_DIR}
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
# The checkout lives in \$HOME, so the home directory has to stay visible;
# only the progress directory is writable. --no-sync keeps uv from wanting to
# write to .venv or its cache at start-up.
ProtectSystem=strict
ProtectHome=false
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null
systemctl restart "${SERVICE_NAME}"

# Startup scans 108 booklets and takes roughly ten seconds on a cold cache.
log "Waiting for http://127.0.0.1:${PORT}${BASE_PATH}/healthz"
for attempt in $(seq 1 60); do
    if curl -fsS -m 5 -o /dev/null "http://127.0.0.1:${PORT}${BASE_PATH}/healthz"; then
        echo "healthy after ${attempt}s"
        break
    fi
    systemctl is-active --quiet "${SERVICE_NAME}" \
        || { journalctl -u "${SERVICE_NAME}" -n 40 --no-pager; die "service failed to start"; }
    sleep 1
    [[ ${attempt} -lt 60 ]] || { journalctl -u "${SERVICE_NAME}" -n 40 --no-pager; die "healthz never answered"; }
done

# --- apache -----------------------------------------------------------------

log "Configuring Apache"
a2enmod -q proxy proxy_http

# Included explicitly by the vhost below, so it is deliberately not a2enconf'd
# (that would apply the proxy rules to every virtual host on this server).
cat > "${PROXY_CONF}" <<EOF
# Managed by deploy/deploy.sh of the 101books Go reader. Do not edit by hand.
RedirectMatch 308 ^${BASE_PATH}\$ ${BASE_PATH}/

ProxyRequests Off
ProxyPass        ${BASE_PATH}/ http://127.0.0.1:${PORT}${BASE_PATH}/
ProxyPassReverse ${BASE_PATH}/ http://127.0.0.1:${PORT}${BASE_PATH}/

# The reader does not authenticate its display names; uncomment to gate it.
#<Location ${BASE_PATH}/>
#    AuthType Basic
#    AuthName "Go reader"
#    AuthUserFile /etc/apache2/tsumego.htpasswd
#    Require valid-user
#</Location>
EOF

if grep -qF "Include ${PROXY_CONF}" "${VHOST_FILE}"; then
    echo "vhost already includes ${PROXY_CONF}"
else
    backup="${VHOST_FILE}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -a "${VHOST_FILE}" "${backup}"
    echo "backed up vhost to ${backup}"

    # Insert the include just before the *:443 block closes; the *:80 block in
    # the same file only redirects to HTTPS and must stay untouched.
    awk -v line="    Include ${PROXY_CONF}" '
        /<VirtualHost \*:443>/ { inside = 1 }
        inside && /<\/VirtualHost>/ && !done { print line; done = 1; inside = 0 }
        { print }
        END { if (!done) exit 3 }
    ' "${backup}" > "${VHOST_FILE}" \
        || { cp -a "${backup}" "${VHOST_FILE}"; die "no <VirtualHost *:443> block found in ${VHOST_FILE}"; }
    echo "added Include to the *:443 vhost"
fi

apachectl configtest || die "apache configtest failed; restore the .bak file above"
systemctl reload apache2

# --- verify -----------------------------------------------------------------

log "Verifying https://${DOMAIN}${BASE_PATH}/"
curl -fsS -m 15 -o /dev/null "https://${DOMAIN}${BASE_PATH}/healthz" \
    || die "public healthz failed (DNS/Cloudflare/TLS?); the local service is fine"
curl -fsS -m 15 -o /dev/null "https://${DOMAIN}${BASE_PATH}/" \
    || die "public index failed"

log "Done"
cat <<EOF

  Reader:   https://${DOMAIN}${BASE_PATH}/
  Service:  systemctl status ${SERVICE_NAME}
  Logs:     journalctl -u ${SERVICE_NAME} -f
  Code:     ${APP_DIR} (commit $(sudo -u "${RUN_USER}" git -C "${APP_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown))
  Data:     ${DATA_DIR}/users  -- back this up, it holds all progress
  Deps:     ${APP_DIR}/.venv (uv sync --frozen from uv.lock)

  After changing the code:         sudo systemctl restart ${SERVICE_NAME}
  After changing the dependencies: sudo ./deploy/deploy.sh

EOF
