#!/usr/bin/env python3
"""Validate the repository's owner-local credential convention."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml


ROOT_CREDENTIAL_FILES = ("secrets.yaml", ".axiom.toml", "cookies.txt")
MODULE_BINARY_CREDENTIALS = (
    Path("modules/media-cookies/cookies.txt"),
    Path("modules/o11y/.axiom.toml"),
)


def fail(message: str) -> None:
    print(f"credential ownership: {message}", file=sys.stderr)
    raise SystemExit(1)


def encrypted_keys(path: Path) -> set[str]:
    try:
        document = yaml.safe_load(path.read_text())
    except (OSError, yaml.YAMLError) as error:
        fail(f"cannot parse {path}: {error}")

    if not isinstance(document, dict) or "sops" not in document:
        fail(f"{path} is not a sops yaml mapping")

    keys = set(document) - {"sops"}
    if not keys:
        fail(f"{path} has no encrypted keys")
    return keys


def check_module_credentials(root: Path) -> None:
    owners: dict[str, Path] = {}
    for secret_file in sorted((root / "modules").glob("**/secrets.yaml")):
        credential_file = secret_file.with_name("credential.nix")
        if not credential_file.is_file():
            fail(f"{secret_file.relative_to(root)} has no adjacent credential.nix")

        declaration = credential_file.read_text()
        if "sopsFile = ./secrets.yaml;" not in declaration:
            fail(f"{credential_file.relative_to(root)} does not own its adjacent secrets.yaml")

        for key in encrypted_keys(secret_file):
            if key not in declaration:
                fail(f"{key} is encrypted in {secret_file.relative_to(root)} but not declared by its owner")
            previous = owners.get(key)
            if previous is not None:
                fail(
                    f"{key} has multiple owners: "
                    f"{previous.relative_to(root)} and {credential_file.relative_to(root)}"
                )
            owners[key] = credential_file

    for relative_secret_file in MODULE_BINARY_CREDENTIALS:
        secret_file = root / relative_secret_file
        credential_file = secret_file.with_name("credential.nix")
        declaration = credential_file.read_text()
        expected_reference = f"sopsFile = ./{secret_file.name};"
        if expected_reference not in declaration:
            fail(
                f"{credential_file.relative_to(root)} does not own "
                f"{secret_file.relative_to(root)}"
            )


def check_root_retirement(root: Path) -> None:
    for name in ROOT_CREDENTIAL_FILES:
        if (root / name).exists():
            fail(f"retired root credential file still exists: {name}")

    stale_reference = "../../secrets.yaml"
    nix_files = [
        root / "flake.nix",
        *(root / "hosts").glob("**/*.nix"),
        *(root / "modules").glob("**/*.nix"),
    ]
    for nix_file in sorted(nix_files):
        if ".sync-conflict-" in nix_file.name:
            continue
        if stale_reference in nix_file.read_text():
            fail(f"{nix_file.relative_to(root)} still references root secrets.yaml")


def check_cloudflare_ci(root: Path) -> None:
    secret_file = root / "cloudflare/secrets.yaml"
    wrapper = root / "cloudflare/tofu-with-secrets"
    if encrypted_keys(secret_file) != {"cloudflare_family_emails"}:
        fail("cloudflare/secrets.yaml must own only cloudflare_family_emails")
    if "cloudflare_family_emails" not in wrapper.read_text():
        fail("cloudflare/tofu-with-secrets does not consume its owned credential")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()

    check_root_retirement(root)
    check_module_credentials(root)
    check_cloudflare_ci(root)
    print("credential ownership: ok")


if __name__ == "__main__":
    main()
