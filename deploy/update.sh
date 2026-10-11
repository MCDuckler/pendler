#!/bin/bash
# Install the newest `server-*` release of MCDuckler/pendler: download, verify the
# sha256, unpack beside the others, switch `current`, restart, and switch back if the
# new one doesn't answer /api/health with its own version within 30 s.
# Run by pendler-update.timer; safe to run by hand. The repo is public: no token.
set -euo pipefail
REPO=${REPO:-MCDuckler/pendler}
ROOT=/opt/pendler
RELS=$ROOT/releases
HEALTH=${HEALTH:-http://172.18.0.1:8792/api/health}

mkdir -p "$RELS"
read -r tag url sha_url < <(curl -fsS -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO/releases?per_page=30" | python3 -c '
import json, sys
rels = [r for r in json.load(sys.stdin) if r["tag_name"].startswith("server-") and not r["draft"]]
if not rels: sys.exit(0)
r = max(rels, key=lambda r: r["created_at"])
a = {x["name"]: x["browser_download_url"] for x in r["assets"]}
print(r["tag_name"], a.get("pendler-server.tar.gz", "-"), a.get("pendler-server.tar.gz.sha256", "-"))
') || true
[ -n "${tag:-}" ] || { echo "no server release"; exit 0; }
prev=none; [ -L "$ROOT/current" ] && prev=$(basename "$(readlink -f "$ROOT/current")")
[ "$tag" = "$prev" ] && exit 0
[ "$url" != "-" ] && [ "$sha_url" != "-" ] || { echo "$tag: assets missing"; exit 1; }

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/s.tgz" "$url"
want=$(curl -fsSL "$sha_url" | cut -d' ' -f1)
have=$(sha256sum "$tmp/s.tgz" | cut -d' ' -f1)
[ "$want" = "$have" ] || { echo "$tag: sha256 mismatch"; exit 1; }
rm -rf "$RELS/$tag.new" && mkdir -p "$RELS/$tag.new"
tar -xzf "$tmp/s.tgz" -C "$RELS/$tag.new"
rm -rf "$RELS/$tag" && mv "$RELS/$tag.new" "$RELS/$tag"
install -m 755 "$RELS/$tag/deploy/update.sh" "$ROOT/update.sh.next"

switch() { ln -sfn "$RELS/$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; systemctl restart pendler; }
switch "$tag"
for _ in $(seq 30); do
  sleep 1
  if curl -fsS "$HEALTH" 2>/dev/null | grep -q "\"version\":\"$tag\""; then
    echo "pendler: $prev → $tag"
    mv "$ROOT/update.sh.next" "$ROOT/update.sh"   # the updater updates itself last
    ls -1dt "$RELS"/server-* | tail -n +4 | xargs -r rm -rf   # keep three
    exit 0
  fi
done
echo "pendler: $tag did not come up healthy, back to $prev" >&2
rm -f "$ROOT/update.sh.next"
[ "$prev" != none ] && switch "$prev"
exit 1
