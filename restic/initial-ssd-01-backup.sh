#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_FENFE="/Volumes/ssd-01/fenfe"
readonly SOURCE_IGOR="/Volumes/ssd-01/igor"
readonly SECRET_FILE="/Users/bdsqqq/commonplace/01_files/nix/restic/secrets.yaml"
readonly SOPS_KEY_FILE="/Users/bdsqqq/.config/sops/age/keys.txt"
readonly SSH_KEY="/Users/bdsqqq/.ssh/id_ed25519"
readonly REPOSITORY="sftp:u646875@u646875.your-storagebox.de:/home/restic/ssd-01"
# Performance note (2026-08-14): snapshot bc3be5bb added only 3.465 GiB
# after deduplication, but its SFTP upload took 3h40m (~2.25 Mbps) while the
# Mac measured 29.1 Mbps upstream and local hashing/copying ran at tens of
# MB/s. The bottleneck is therefore between restic's SFTP transport and the
# Hetzner Storage Box, not the source SSD. Before the next large upload,
# benchmark a direct SFTP transfer and test sftp.connections above its default
# of 5; do not mistake restic's logical snapshot byte count for uploaded bytes.
readonly SFTP_COMMAND="ssh -p 23 -o BatchMode=yes -o IdentitiesOnly=yes -i ${SSH_KEY} u646875@u646875.your-storagebox.de -s sftp"

export RESTIC_PASSWORD_COMMAND="/usr/bin/env SOPS_AGE_KEY_FILE=${SOPS_KEY_FILE} /etc/profiles/per-user/bdsqqq/bin/sops --decrypt --extract '[\"restic_ssd_01_password\"]' ${SECRET_FILE}"

stage="preflight"
finished=false

notify_failure() {
  local exit_code=$?
  if [[ "${finished}" == "true" ]]; then
    return
  fi

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

osascript -e 'display notification "The SSD is encrypted, uploaded, and verified on Hetzner." with title "backup complete ✨" sound name "Glass"'
