#!/usr/bin/env python3
"""validate and encode the immutable 64 KiB fleet_cfg partition image."""

from __future__ import annotations

import argparse
import base64
import json
import struct
from pathlib import Path
from typing import Any

PARTITION_SIZE = 0x10000
MAX_ID = 64
MAX_PEM = 160
MAX_URL = 192
ROOT_FIELDS = {
    "version", "fleet", "authority", "identity", "roster", "peers",
    "contactIntervalMs", "contactTimeoutMs",
}
PUBLIC_FIELDS = {"id", "signingPublicKey", "encryptionPublicKey"}
IDENTITY_FIELDS = PUBLIC_FIELDS | {"signingPrivateKey", "encryptionPrivateKey"}
SPKI_ED = bytes.fromhex("302a300506032b6570032100")
SPKI_X = bytes.fromhex("302a300506032b656e032100")
PKCS8_ED = bytes.fromhex("302e020100300506032b657004220420")
PKCS8_X = bytes.fromhex("302e020100300506032b656e04220420")


def exact(value: Any, fields: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError(f"{label} must contain exactly {sorted(fields)}")
    return value


def text(value: Any, maximum: int, label: str) -> str:
    if not isinstance(value, str) or len(value.encode("utf-8")) > maximum or "\0" in value:
        raise ValueError(f"{label} must be a UTF-8 string of at most {maximum} bytes without U+0000")
    return value


def positive_u32(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 0x7FFFFFFF:
        raise ValueError(f"{label} must be a positive signed 32-bit millisecond value")
    return value


def pem(value: Any, prefix: bytes, private: bool, label: str) -> str:
    value = text(value, MAX_PEM, label)
    kind = "PRIVATE" if private else "PUBLIC"
    begin = f"-----BEGIN {kind} KEY-----\n"
    end = f"-----END {kind} KEY-----\n"
    if not value.startswith(begin) or not value.endswith(end):
        raise ValueError(f"{label} is not canonical PEM")
    if not value.endswith("\n" + end):
        raise ValueError(f"{label} is not canonical PEM")
    body = value[len(begin):-(len(end) + 1)]
    try:
        der = base64.b64decode(body, validate=True)
    except ValueError as error:
        raise ValueError(f"{label} has invalid base64") from error
    if der[:len(prefix)] != prefix or len(der) != len(prefix) + 32:
        raise ValueError(f"{label} is not the required RFC8410 key")
    canonical = begin + base64.b64encode(der).decode("ascii") + "\n" + end
    if canonical != value:
        raise ValueError(f"{label} is not canonical one-line PEM")
    return value


def public_identity(value: Any, label: str) -> dict[str, Any]:
    item = exact(value, PUBLIC_FIELDS, label)
    text(item["id"], MAX_ID, f"{label}.id")
    pem(item["signingPublicKey"], SPKI_ED, False, f"{label}.signingPublicKey")
    pem(item["encryptionPublicKey"], SPKI_X, False, f"{label}.encryptionPublicKey")
    return item


def validate(config: Any) -> None:
    root = exact(config, ROOT_FIELDS, "config")
    if root["version"] != 1 or isinstance(root["version"], bool):
        raise ValueError("version must be 1")
    text(root["fleet"], MAX_ID, "fleet")
    authority = exact(root["authority"], {"id", "publicKey"}, "authority")
    text(authority["id"], MAX_ID, "authority.id")
    pem(authority["publicKey"], SPKI_ED, False, "authority.publicKey")
    identity = exact(root["identity"], IDENTITY_FIELDS, "identity")
    public_identity({key: identity[key] for key in PUBLIC_FIELDS}, "identity")
    pem(identity["signingPrivateKey"], PKCS8_ED, True, "identity.signingPrivateKey")
    pem(identity["encryptionPrivateKey"], PKCS8_X, True, "identity.encryptionPrivateKey")
    if not isinstance(root["roster"], list) or not 1 <= len(root["roster"]) <= 16:
        raise ValueError("roster must contain 1..16 public identities")
    roster = [public_identity(item, f"roster[{index}]") for index, item in enumerate(root["roster"])]
    ids = [item["id"] for item in roster]
    if len(set(ids)) != len(ids):
        raise ValueError("roster ids must be unique")
    local = next((item for item in roster if item["id"] == identity["id"]), None)
    if local != {key: identity[key] for key in PUBLIC_FIELDS}:
        raise ValueError("identity must exactly match its public roster entry")
    if not isinstance(root["peers"], list) or not 1 <= len(root["peers"]) <= 8:
        raise ValueError("peers must contain 1..8 explicit peers")
    peer_ids: set[str] = set()
    for index, value in enumerate(root["peers"]):
        peer = exact(value, {"id", "url"}, f"peers[{index}]")
        peer_id = text(peer["id"], MAX_ID, f"peers[{index}].id")
        url = text(peer["url"], MAX_URL, f"peers[{index}].url")
        authority_part = url.removeprefix("http://")
        if not url.startswith("http://") or not authority_part or any(c in authority_part for c in "/?#@"):
            raise ValueError(f"peers[{index}].url must be an HTTP origin without trailing slash")
        if peer_id == identity["id"] or peer_id not in ids or peer_id in peer_ids:
            raise ValueError(f"peers[{index}].id must be unique, non-local, and in roster")
        peer_ids.add(peer_id)
    positive_u32(root["contactIntervalMs"], "contactIntervalMs")
    positive_u32(root["contactTimeoutMs"], "contactTimeoutMs")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    raw = args.config.read_bytes()
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise SystemExit(f"configuration is not UTF-8: {error}")
    try:
        config = json.loads(source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        validate(config)
    except (json.JSONDecodeError, ValueError) as error:
        raise SystemExit(f"invalid configuration: {error}")
    if not raw or len(raw) > PARTITION_SIZE - 4:
        raise SystemExit("configuration does not fit fleet_cfg")
    args.output.write_bytes(struct.pack("<I", len(raw)) + raw + b"\xff" * (PARTITION_SIZE - 4 - len(raw)))
    print(f"wrote {args.output}: {len(raw)} JSON bytes, {PARTITION_SIZE} partition bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
