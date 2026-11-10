#!/usr/bin/env bash
set -euo pipefail
release_id="${1:?release id required}"
if [[ ! "$release_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ || "$release_id" == *..* ]]; then exit 2; fi
release_root="/opt/hongthreads/releases/$release_id"
previous_release=""
if test -L /opt/hongthreads/current; then previous_release="$(readlink -f /opt/hongthreads/current)"; fi
rollback() {
  result=$?
  if [[ "$result" != 0 && -n "$previous_release" ]]; then
    ln -sfn "$previous_release" /opt/hongthreads/current
    sudo systemctl restart hongthreads-gateway.service hongthreads-web.service || true
    echo "Release health check failed; restored previous HongThreads release." >&2
  fi
  exit "$result"
}
mkdir -p "$release_root"
tar -xzf "/opt/hongthreads/releases/hongthreads-$release_id.tgz" -C "$release_root"
if test -L /opt/hongthreads/current; then
  readlink -f /opt/hongthreads/current > /opt/hongthreads/previous-release
fi
ln -sfn "$release_root" /opt/hongthreads/current
trap rollback EXIT
sudo install -m 0644 "$release_root/deploy/systemd/hongthreads-gateway.service" /etc/systemd/system/hongthreads-gateway.service
sudo install -m 0644 "$release_root/deploy/systemd/hongthreads-web.service" /etc/systemd/system/hongthreads-web.service
sudo systemctl daemon-reload
sudo systemctl enable hongthreads-gateway.service hongthreads-web.service
sudo systemctl restart hongthreads-gateway.service hongthreads-web.service
for attempt in $(seq 1 40); do
  if curl -fsS --max-time 2 http://127.0.0.1:9251/healthz >/dev/null; then break; fi
  sleep 0.5
done
curl -fsS --max-time 5 http://127.0.0.1:9251/healthz | /opt/hongthreads/node24/bin/node -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>{const h=JSON.parse(s);if(!h.ready||h.storage!=="supabase"||!h.vertex)process.exit(1);console.log(JSON.stringify(h));});'
curl -fsS --max-time 10 http://127.0.0.1:9251/workspace/connect >/dev/null
sudo systemctl is-active hongthreads-gateway.service hongthreads-web.service
trap - EXIT
