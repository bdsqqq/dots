#!/usr/bin/env bash
set -eu

amp_binary="$1"
amp_key_file="$2"
axiom_token_file="$3"
axiom_org_file="$4"
shift 4

# An explicit work-account environment must win over the personal default.
if [[ -z "${AMP_API_KEY:-}" && -n "$amp_key_file" ]]; then
  AMP_API_KEY="$(<"$amp_key_file")"
  export AMP_API_KEY
fi

if [[ -n "$axiom_token_file" && -n "$axiom_org_file" ]]; then
  if [[ -z "${AXIOM_TOKEN:-}" && -z "${AXIOM_ORG_ID:-}" ]]; then
    # Load the pair together: never borrow an org for an explicitly chosen token.
    if [[ -r "$axiom_token_file" && -r "$axiom_org_file" ]]; then
      axiom_token="$(<"$axiom_token_file")"
      axiom_org="$(<"$axiom_org_file")"
      if [[ -n "$axiom_token" && -n "$axiom_org" ]]; then
        export AXIOM_TOKEN="$axiom_token" AXIOM_ORG_ID="$axiom_org"
      else
        echo "amp: Axiom SOPS credentials are empty; MCP authentication is not configured" >&2
      fi
      unset axiom_token axiom_org
    else
      echo "amp: Axiom SOPS credentials are unavailable; MCP authentication is not configured" >&2
    fi
  elif [[ -z "${AXIOM_TOKEN:-}" || -z "${AXIOM_ORG_ID:-}" ]]; then
    echo "amp: set both AXIOM_TOKEN and AXIOM_ORG_ID; refusing to mix credentials" >&2
  fi
fi

exec "$amp_binary" "$@"
