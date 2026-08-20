#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

import hjson


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def encoded(value: object) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def require_grant(policy: dict, source: str, destinations: set[str]) -> None:
    granted = set()
    for grant in policy.get("grants", []):
        if source in grant.get("src", []) and "443" in grant.get("ip", []):
            granted.update(grant.get("dst", []))
    missing = destinations - granted
    if missing:
        raise SystemExit(
            f"tailscale policy does not grant {source} access to: "
            + ", ".join(sorted(missing))
        )


def validate_policy(root: Path, services: dict, capabilities: dict) -> None:
    policy = hjson.loads((root / "tailscale/policy.hujson").read_text())
    defined_services = set(policy.get("autoApprovers", {}).get("services", {}))
    missing_services = set(services) - defined_services
    if missing_services:
        raise SystemExit(
            "tailscale policy does not auto-approve: "
            + ", ".join(sorted(missing_services))
        )

    apps = capabilities["apps"]
    owner_services = {app["service"].rsplit(":", 1)[0] for app in apps.values()}
    owner_services.add("svc:apps")
    require_grant(policy, "autogroup:owner", owner_services)

    family_services = {
        app["service"].rsplit(":", 1)[0]
        for app in apps.values()
        if app["tailnetAudience"] == "family"
    }
    require_grant(policy, "autogroup:member", family_services)

    by_trust: dict[str, set[str]] = {}
    for app in apps.values():
        if app["connectorTrust"] is not None:
            by_trust.setdefault(app["connectorTrust"], set()).add(
                app["service"].rsplit(":", 1)[0]
            )
    for trust, destinations in by_trust.items():
        require_grant(policy, capabilities["connectorTags"][trust], destinations)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--cloudflare", type=Path, required=True)
    parser.add_argument("--services", type=Path, required=True)
    parser.add_argument("--capabilities", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    catalog = read_json(args.catalog)
    cloudflare = read_json(args.cloudflare)
    services = read_json(args.services)
    capabilities = read_json(args.capabilities)
    outputs = {
        "generated/fleet-apps.json": catalog,
        "cloudflare/apps.auto.tfvars.json": {"apps": cloudflare},
        "tailscale/services.json": services,
        "tailscale/capabilities.json": capabilities,
    }

    validate_policy(args.root, services, capabilities)
    stale = []
    for relative, value in outputs.items():
        path = args.root / relative
        content = encoded(value)
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(relative)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)

    if stale:
        raise SystemExit("stale generated tailnet artifacts: " + ", ".join(stale))


if __name__ == "__main__":
    main()
