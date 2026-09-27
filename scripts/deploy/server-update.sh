#!/usr/bin/env bash
#
# Update the Chat2API production container from a Docker Hub image.
#
# Run this ON THE SERVER. The image is built and pushed from a developer
# machine with scripts/deploy/build-push.ps1; this script only pulls and
# recreates, so the server never needs the source tree.
#
#   bash server-update.sh skatef/chat2api:<tag>
#
# Design rules:
#   * The data volume is never modified. It is only backed up, read-only.
#   * The outgoing container is kept, stopped and renamed, so a rollback is a
#     rename rather than a rebuild.
#   * A failed health check rolls back automatically.
#   * The stop timeout is explicit. A managed-tool Codex turn can legitimately
#     run for many minutes; Docker's 10s default SIGTERM grace severs it.
#
set -Eeuo pipefail

IMAGE="${1:-}"
CHAT2API_DIR="${CHAT2API_DIR:-/opt/chat2api}"
DATA_DIR="$CHAT2API_DIR/data"
ENV_FILE="$CHAT2API_DIR/env.chat2api"
CONTAINER="${CHAT2API_CONTAINER:-chat2api}"
ROLLBACK="${CHAT2API_ROLLBACK_CONTAINER:-chat2api-rollback}"
NETWORK="${CHAT2API_NETWORK:-chat2api_default}"
PORT="${CHAT2API_PORT:-8080}"
# Must be >= CHAT2API_SHUTDOWN_DRAIN_TIMEOUT_MS (540000 = 9m) in the env file,
# otherwise Docker SIGKILLs the process while it is still draining.
STOP_TIMEOUT="${CHAT2API_STOP_TIMEOUT:-600}"
BACKUP_KEEP="${CHAT2API_BACKUP_KEEP:-10}"
READY_TIMEOUT="${CHAT2API_READY_TIMEOUT:-180}"
# The live check must not eat the whole readiness budget.
LIVE_CHECK_TIMEOUT="${CHAT2API_LIVE_CHECK_TIMEOUT:-150}"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$IMAGE" ] || die "usage: $0 <image:tag>   (e.g. skatef/chat2api:8cab84a)"

PREVIOUS_IMAGE=""
PREVIOUS_ID=""

# ---------------------------------------------------------------- preflight --
log "Preflight"

command -v docker >/dev/null 2>&1 || die "docker is not installed on this host"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE
This container was started with --env-file. Without it the new container comes
up with no CHAT2API_STORAGE_ENCRYPTION_KEY, every stored credential reads back
as ciphertext, and the whole pool looks like an upstream risk-control outage."

[ -d "$DATA_DIR" ] || die "data directory not found: $DATA_DIR"

# A missing encryption key is indistinguishable from a risk-control verdict from
# the outside, so refuse to guess: the env file must actually carry a key.
if grep -qE '^CHAT2API_STORAGE_ENCRYPTION_KEY=.+' "$ENV_FILE"; then
  log "Encryption key present in $ENV_FILE"
else
  die "CHAT2API_STORAGE_ENCRYPTION_KEY is empty in $ENV_FILE
Do not continue. A missing/unmatched key makes decryptData() return the
ciphertext unchanged, hasQwenAiWebSessionCookie() false for every account, and
every request fails with 403 qwen_ai_token_refresh_gated."
fi

if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  log "Network $NETWORK present"
else
  warn "network $NETWORK missing, creating it"
  docker network create "$NETWORK" >/dev/null
fi

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  PREVIOUS_IMAGE="$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
  PREVIOUS_ID="$(docker inspect "$CONTAINER" --format '{{.Id}}')"
  log "Running container: $CONTAINER ($PREVIOUS_IMAGE, ${PREVIOUS_ID:0:12})"
else
  log "No running container named $CONTAINER, this will be a first deploy"
fi

# ------------------------------------------------------------------- backup --
# Read-only on the volume: copy data.json aside so a bad deploy can be undone
# even if the app rewrote it during startup.
if [ -f "$DATA_DIR/data.json" ]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP="$DATA_DIR/data.json.bak.deploy-$STAMP"
  cp -p "$DATA_DIR/data.json" "$BACKUP"
  log "Store backed up to $BACKUP"
  # Keep the newest N so the directory cannot grow without bound.
  ls -1t "$DATA_DIR"/data.json.bak.deploy-* 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r old; do
    rm -f "$old"
  done
fi

# --------------------------------------------------------------------- pull --
log "Pulling $IMAGE"
docker pull "$IMAGE"

NEW_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
log "Pulled image id ${NEW_ID:0:12}"

if [ -n "$PREVIOUS_ID" ] && [ "$PREVIOUS_ID" = "$NEW_ID" ]; then
  log "Identical to the running image, nothing to do"
  exit 0
fi

# ------------------------------------------------------- stop and hand over --
if [ -n "$PREVIOUS_ID" ]; then
  log "Stopping $CONTAINER (drain timeout ${STOP_TIMEOUT}s)"
  # A long generation must be allowed to finish. Do not shorten this to "fast".
  docker stop -t "$STOP_TIMEOUT" "$CONTAINER" >/dev/null

  if docker inspect "$ROLLBACK" >/dev/null 2>&1; then
    log "Removing the previous rollback container $ROLLBACK"
    docker rm -f "$ROLLBACK" >/dev/null
  fi
  docker rename "$CONTAINER" "$ROLLBACK"
  log "Previous container preserved as $ROLLBACK"
fi

# ------------------------------------------------------------------ recreate --
log "Starting $CONTAINER from $IMAGE"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --stop-timeout "$STOP_TIMEOUT" \
  -p "$PORT:$PORT" \
  -v "$DATA_DIR:/data" \
  --env-file "$ENV_FILE" \
  "$IMAGE" >/dev/null

# ------------------------------------------------------------------- verify --
rollback() {
  warn "Rolling back to $ROLLBACK"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker inspect "$ROLLBACK" >/dev/null 2>&1; then
    docker rename "$ROLLBACK" "$CONTAINER"
    docker start "$CONTAINER" >/dev/null
    warn "Restored $CONTAINER ($PREVIOUS_IMAGE)"
  else
    warn "No rollback container available. Start $PREVIOUS_IMAGE by hand."
  fi
}

log "Waiting for the HTTP listener (timeout ${READY_TIMEOUT}s)"
deadline=$(( $(date +%s) + READY_TIMEOUT ))
listener_ok=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
    warn "container exited during startup; last log lines:"
    docker logs --tail 40 "$CONTAINER" >&2 || true
    rollback
    die "container did not stay up"
  fi
  if curl -fsS -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    listener_ok=1
    break
  fi
  sleep 3
done
[ "$listener_ok" = 1 ] || { warn "no healthy listener"; docker logs --tail 40 "$CONTAINER" >&2 || true; rollback; die "health check timed out"; }
log "Listener healthy"

# The single cheapest credential diagnostic. ready=0 pending=N means the stored
# credentials could not be decrypted, which looks exactly like upstream risk
# control from the outside. See docs/diag-2026-09-25-qwen-egress.md.
log "Checking credential readability"
REPAIR_LINE=""
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  REPAIR_LINE="$(docker logs "$CONTAINER" 2>&1 | grep -m1 'Session Repair\] started' || true)"
  [ -n "$REPAIR_LINE" ] && break
  sleep 3
done
if [ -n "$REPAIR_LINE" ]; then
  log "$REPAIR_LINE"
  ready="$(sed -n 's/.*ready=\([0-9]*\).*/\1/p' <<<"$REPAIR_LINE")"
  pending="$(sed -n 's/.*pending=\([0-9]*\).*/\1/p' <<<"$REPAIR_LINE")"
  if [ "${ready:-0}" = "0" ] && [ "${pending:-0}" -gt 0 ]; then
    docker logs --tail 40 "$CONTAINER" >&2 || true
    rollback
    die "ready=0 pending=$pending: the stored credentials did not decrypt.
The encryption key does not match the one the data was written with. Fix the
key, or set CHAT2API_CREDENTIAL_SELF_CHECK=off for a plaintext store."
  fi
else
  warn "no 'Session Repair] started' line yet (no Qwen accounts, or it is still starting)"
fi

# A 200 on /health only proves the listener is up. Send one real request so a
# green health check cannot hide a pool that cannot answer.
#
# The probe classifies its own outcome, because "the new container is wired
# wrong" and "the provider is unavailable right now" need opposite responses.
# Rolling back a good image because a third-party proxy ran out of bandwidth
# would leave production on the old build indefinitely, and a gate that has to
# be bypassed under pressure is a gate that gets bypassed.
#
#   ok       -> deploy succeeded
#   upstream -> provider capacity/risk/bandwidth; report it, keep the new image
#   broken   -> the artifact or its wiring is wrong; roll back
log "Live completion check (timeout ${LIVE_CHECK_TIMEOUT}s)"
VERDICT=$(docker exec "$CONTAINER" node -e '
const fs = require("fs")
let key = ""
try {
  const cfg = JSON.parse(fs.readFileSync("/data/data.json", "utf8")).config || {}
  const keys = cfg.apiKeys || []
  const k = keys.find(x => x.name === "11") || keys.find(x => x.enabled !== false) || keys[0]
  key = (k && (k.key || k.value)) || ""
} catch (e) { console.log("skip"); process.exit(0) }
if (!key) { console.log("skip"); process.exit(0) }

// Upstream states that are not the deployed artifact failing.
const UPSTREAM_CODES = [
  "qwen_ai_upstream_busy",
  "qwen_ai_content_verdict",
  "qwen_ai_risk_circuit_open",
  "qwen_ai_token_refresh_gated",
  "qwen_ai_webshare_bandwidth_exhausted",
  "qwen_ai_daily_quota_exhausted",
  "no_available_account",
  "CHAT_IN_PROGRESS",
]

const body = JSON.stringify({ model: "Qwen3.8-Max", messages: [{ role: "user", content: "ping" }], stream: false })
const t0 = Date.now()
fetch("http://127.0.0.1:'"$PORT"'/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
  body,
  signal: AbortSignal.timeout('"$LIVE_CHECK_TIMEOUT"' * 1000),
}).then(async r => {
  const text = await r.text()
  const ms = Date.now() - t0
  if (r.status === 200) { console.log("ok HTTP 200 in " + ms + "ms"); process.exit(0) }

  let code = ""
  try { code = JSON.parse(text)?.error?.code || "" } catch (e) { code = "" }
  const isUpstream = UPSTREAM_CODES.includes(code) || r.status === 429
  const kind = isUpstream ? "upstream" : "broken"
  console.log(kind + " HTTP " + r.status + " in " + ms + "ms" + (code ? " code=" + code : "") + " body=" + text.slice(0, 200))
  process.exit(isUpstream ? 0 : 3)
}).catch(e => {
  // The listener and credential checks already passed, so a probe that never
  // completes is the upstream being slow, not a mis-wired container.
  console.log("upstream probe did not complete: " + e.message)
  process.exit(0)
})
' 2>&1) || VERDICT="broken probe exited non-zero"

echo "    $VERDICT"

if [[ "$VERDICT" == ok* ]]; then
  log "Live completion OK"
elif [[ "$VERDICT" == upstream* || "$VERDICT" == skip* ]]; then
  warn "The new container is serving, but the provider is not answering right now."
  warn "This is an upstream condition, not a bad image, so the deploy is kept."
  warn "Verify by hand before trusting it: curl -H 'Authorization: Bearer <key>' \\"
  warn "  http://127.0.0.1:$PORT/v1/chat/completions -d '{\"model\":\"Qwen3.8-Max\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}'"
else
  warn "live completion indicates a broken deployment"
  docker logs --tail 40 "$CONTAINER" >&2 || true
  rollback
  die "post-deploy verification failed"
fi

# -------------------------------------------------------------------- report --
log "Deployed"
docker inspect "$CONTAINER" --format 'container {{.Name}}  image {{.Config.Image}}  id {{.Id}}' 2>/dev/null || true
docker images --format '{{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}' | grep -F "$IMAGE" | head -3 || true
cat <<EOF

Next:
  docker logs -f $CONTAINER
  curl -s http://127.0.0.1:$PORT/health

Rollback (the previous container is stopped but intact):
  docker rm -f $CONTAINER
  docker rename $ROLLBACK $CONTAINER && docker start $CONTAINER
EOF
