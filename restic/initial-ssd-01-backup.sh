#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_FENFE="/Volumes/ssd-01/fenfe"
readonly SOURCE_IGOR="/Volumes/ssd-01/igor"
readonly SECRET_FILE="/Users/bdsqqq/commonplace/01_files/nix/restic/secrets.yaml"
readonly SOPS_KEY_FILE="/Users/bdsqqq/.config/sops/age/keys.txt"
readonly SSH_KEY="/Users/bdsqqq/.ssh/id_ed25519"
readonly HARK="/Users/bdsqqq/commonplace/01_files/nix/user/node-pnpm/node_modules/.bin/harkctl"
readonly HARK_DEVICE="dev_DsQ9wLUj5uiOAp0d"
readonly REPOSITORY="sftp:u646875@u646875.your-storagebox.de:/home/restic/ssd-01"
readonly SFTP_COMMAND="ssh -p 23 -o BatchMode=yes -o IdentitiesOnly=yes -i ${SSH_KEY} u646875@u646875.your-storagebox.de -s sftp"

export RESTIC_PASSWORD_COMMAND="/usr/bin/env SOPS_AGE_KEY_FILE=${SOPS_KEY_FILE} /etc/profiles/per-user/bdsqqq/bin/sops --decrypt --extract '[\"restic_ssd_01_password\"]' ${SECRET_FILE}"

stage="preflight"
finished=false

notify_failure() {
  local exit_code=$?
  if [[ "${finished}" == "true" ]]; then
    return
  fi

  "${HARK}" notify \
    "The initial ssd-01 backup failed during ${stage}. Existing source files were not changed." \
    --title "backup needs attention" \
    --device "${HARK_DEVICE}" \
    --idempotency-key "ssd-01-initial-backup-20260807-failure-v2" || true
  osascript -e "display notification \"Initial SSD backup failed during ${stage}.\" with title \"backup needs attention\" sound name \"Basso\"" || true
  exit "${exit_code}"
}

trap notify_failure EXIT

restic_command() {
  nix shell "nixpkgs#restic" -c restic \
    -r "${REPOSITORY}" \
    -o "sftp.command=${SFTP_COMMAND}" \
    "$@"
}

if [[ ! -d "${SOURCE_FENFE}" || ! -d "${SOURCE_IGOR}" ]]; then
  echo "ssd-01 is not mounted with the expected source directories" >&2
  exit 1
fi

stage="repository unlock"
restic_command unlock

stage="upload"
restic_command backup \
  "${SOURCE_FENFE}" \
  "${SOURCE_IGOR}" \
  --host "mbp-m2" \
  --tag "ssd-01" \
  --exclude "._*" \
  --verbose=1

stage="repository verification"
restic_command check --read-data-subset=5%

stage="snapshot verification"
restic_command stats latest --mode raw-data

finished=true
trap - EXIT

"${HARK}" notify \
  "ssd-01 is encrypted, uploaded, and verified on Hetzner. The family photo archive is now off-site." \
  --title "backup complete ✨" \
  --device "${HARK_DEVICE}" \
  --idempotency-key "ssd-01-initial-backup-20260807-success-v2"
osascript -e 'display notification "The SSD is encrypted, uploaded, and verified on Hetzner." with title "backup complete ✨" sound name "Glass"'
