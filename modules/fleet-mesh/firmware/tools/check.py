#!/usr/bin/env python3
"""stdlib checks for the partition layout and parent v1 id vectors."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FIXTURE = ROOT.parent / "v1-conformance.json"


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def revision(value: dict[str, Any]) -> str:
    return "{" + f'"epoch":{compact(value["epoch"])},"sequence":{compact(value["sequence"])}' + "}"


def command_bytes(command: dict[str, Any], include_signature: bool) -> bytes:
    encryption = command["encryption"]
    header = command["header"]
    fields = [
        f'"authority":{compact(command["authority"])}',
        '"encryption":{' + ",".join((
            f'"authTag":{compact(encryption["authTag"])}',
            f'"ciphertext":{compact(encryption["ciphertext"])}',
            f'"ephemeralPublicKey":{compact(encryption["ephemeralPublicKey"])}',
            f'"iv":{compact(encryption["iv"])}',
        )) + "}",
        '"header":{' + ",".join((
            f'"expiresAt":{compact(header["expiresAt"])}',
            f'"fleet":{compact(header["fleet"])}',
            f'"notBefore":{compact(header["notBefore"])}',
            f'"operation":{compact(header["operation"])}',
            f'"resource":{compact(header["resource"])}',
            f'"revision":{revision(header["revision"])}',
            f'"to":{compact(header["to"])}',
            f'"version":{compact(header["version"])}',
        )) + "}",
        '"kind":"command"',
    ]
    if include_signature:
        fields.append(f'"signature":{compact(command["signature"])}')
    return ("{" + ",".join(fields) + "}").encode()


def receipt_bytes(receipt: dict[str, Any], include_signature: bool) -> bytes:
    fields = [
        f'"commandId":{compact(receipt["commandId"])}',
        '"kind":"receipt"',
        f'"node":{compact(receipt["node"])}',
        f'"reason":{compact(receipt["reason"])}',
        f'"recordedAt":{compact(receipt["recordedAt"])}',
        f'"resource":{compact(receipt["resource"])}',
        (f'"resultingRevision":{revision(receipt["resultingRevision"])}'
         if receipt["resultingRevision"] is not None else '"resultingRevision":null'),
        f'"revision":{revision(receipt["revision"])}',
    ]
    if include_signature:
        fields.append(f'"signature":{compact(receipt["signature"])}')
    fields.append(f'"status":{compact(receipt["status"])}')
    return ("{" + ",".join(fields) + "}").encode()


def main() -> int:
    fixture = json.loads(FIXTURE.read_text())
    command = fixture["command"]
    assert hashlib.sha256(command_bytes(command, True)).hexdigest() == command["id"]
    receipt = fixture["receipt"]
    assert hashlib.sha256(receipt_bytes(receipt, True)).hexdigest() == receipt["id"]
    rows = [line for line in (ROOT / "partitions.csv").read_text().splitlines()
            if line and not line.startswith("#")]
    parsed = {row.split(",", 1)[0].strip(): [cell.strip() for cell in row.split(",")]
              for row in rows}
    assert parsed["factory"][3:5] == ["0x10000", "0x200000"]
    assert parsed["fleet_state"][3:5] == ["0x210000", "0x40000"]
    assert parsed["fleet_cfg"][2:5] == ["0x40", "0x250000", "0x10000"]
    source = (ROOT / "main" / "fm_protocol.c").read_text()
    for expected in (command["id"], command["signature"], receipt["id"], receipt["signature"],
                     '{\\"count\\":7,\\"enabled\\":true}'):
        assert expected in source
    clock = (ROOT / "main" / "fm_clock.c").read_text()
    assert "esp_netif_sntp_init" in clock
    assert "esp_netif_sntp_sync_wait" in clock
    assert "fm_clock_now(protocol->clock, &now)" in source
    assert "fm_protocol_process_pending(server_protocol)" in (
        ROOT / "main" / "fm_http.c"
    ).read_text()
    print("host checks passed; guest crypto remains an ESP startup check")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
