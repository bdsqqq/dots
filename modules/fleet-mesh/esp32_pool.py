#!/usr/bin/env python3
"""supervise isolated esp32-s3 qemu guests without implementing their protocol."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FLEET_STATE_OFFSET = 0x210000
FLEET_STATE_SIZE = 0x40000


class ConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class Device:
    id: str
    host_port: int
    public_configuration_path: Path
    identity_path: Path


@dataclass(frozen=True)
class PoolConfiguration:
    firmware_image: Path
    qemu: Path
    state_directory: Path
    config_offset: int
    config_size: int
    devices: tuple[Device, ...]


def _exact_object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ConfigurationError(f"{label} must contain exactly {sorted(keys)}")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigurationError(f"{label} must be a non-empty string")
    return value


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ConfigurationError(
            f"{label} must be an integer from {minimum} through {maximum}"
        )
    return value


def load_configuration(path: Path) -> PoolConfiguration:
    raw = _exact_object(
        json.loads(path.read_text()),
        {
            "version",
            "firmwareImage",
            "qemu",
            "stateDirectory",
            "configOffset",
            "configSize",
            "devices",
        },
        "pool configuration",
    )
    if raw["version"] != 1:
        raise ConfigurationError("pool configuration version must be 1")
    if not isinstance(raw["devices"], list) or not raw["devices"]:
        raise ConfigurationError("devices must be a non-empty array")

    devices: list[Device] = []
    ids: set[str] = set()
    ports: set[int] = set()
    for index, candidate in enumerate(raw["devices"]):
        device = _exact_object(
            candidate,
            {"id", "hostPort", "publicConfigurationPath", "identityPath"},
            f"devices[{index}]",
        )
        device_id = _string(device["id"], f"devices[{index}].id")
        port = _integer(device["hostPort"], f"devices[{index}].hostPort", 1, 65535)
        if device_id in ids:
            raise ConfigurationError(f"duplicate device id {device_id}")
        if port in ports:
            raise ConfigurationError(f"duplicate host port {port}")
        ids.add(device_id)
        ports.add(port)
        devices.append(
            Device(
                id=device_id,
                host_port=port,
                public_configuration_path=Path(
                    _string(
                        device["publicConfigurationPath"],
                        f"devices[{index}].publicConfigurationPath",
                    )
                ),
                identity_path=Path(
                    _string(device["identityPath"], f"devices[{index}].identityPath")
                ),
            )
        )

    return PoolConfiguration(
        firmware_image=Path(_string(raw["firmwareImage"], "firmwareImage")),
        qemu=Path(_string(raw["qemu"], "qemu")),
        state_directory=Path(_string(raw["stateDirectory"], "stateDirectory")),
        config_offset=_integer(raw["configOffset"], "configOffset", 0, 2**32 - 1),
        config_size=_integer(raw["configSize"], "configSize", 8, 2**32 - 1),
        devices=tuple(devices),
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _replace_marker(marker: Path, value: str) -> None:
    temporary = marker.with_name(f"{marker.name}.tmp")
    with temporary.open("w") as destination:
        destination.write(f"{value}\n")
        destination.flush()
        os.fsync(destination.fileno())
    os.chmod(temporary, 0o600)
    temporary.replace(marker)
    _fsync_directory(marker.parent)


def _load_guest_configuration(device: Device) -> bytes:
    public = _exact_object(
        json.loads(device.public_configuration_path.read_text()),
        {
            "version",
            "fleet",
            "authority",
            "roster",
            "peers",
            "contactIntervalMs",
            "contactTimeoutMs",
        },
        f"{device.id} public configuration",
    )
    identity = _exact_object(
        json.loads(device.identity_path.read_text()),
        {
            "id",
            "signingPublicKey",
            "encryptionPublicKey",
            "signingPrivateKey",
            "encryptionPrivateKey",
        },
        f"{device.id} identity",
    )
    if identity["id"] != device.id:
        raise ConfigurationError(f"{device.id} identity id does not match")
    guest = {**public, "identity": identity}
    return json.dumps(guest, separators=(",", ":"), ensure_ascii=False).encode()


def prepare_device(configuration: PoolConfiguration, device: Device) -> Path:
    device_directory = configuration.state_directory / device.id
    device_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(device_directory, 0o700)
    flash = device_directory / "flash.bin"
    marker = device_directory / "firmware.sha256"
    expected_hash = _sha256(configuration.firmware_image)
    actual_marker = marker.read_text().strip() if marker.exists() else ""

    if flash.exists():
        if actual_marker != expected_hash:
            state_end = FLEET_STATE_OFFSET + FLEET_STATE_SIZE
            if (
                flash.stat().st_size < state_end
                or configuration.firmware_image.stat().st_size < state_end
            ):
                raise ConfigurationError(
                    f"{device.id} firmware image cannot preserve fleet_state"
                )
            with flash.open("rb") as previous:
                previous.seek(FLEET_STATE_OFFSET)
                fleet_state = previous.read(FLEET_STATE_SIZE)
            _replace_marker(marker, "updating")
            temporary = device_directory / "flash.bin.tmp"
            shutil.copyfile(configuration.firmware_image, temporary)
            os.chmod(temporary, 0o600)
            with temporary.open("r+b") as destination:
                destination.seek(FLEET_STATE_OFFSET)
                destination.write(fleet_state)
                destination.flush()
                os.fsync(destination.fileno())
            temporary.replace(flash)
            _fsync_directory(device_directory)
    else:
        temporary = device_directory / "flash.bin.tmp"
        shutil.copyfile(configuration.firmware_image, temporary)
        os.chmod(temporary, 0o600)
        with temporary.open("r+b") as destination:
            destination.flush()
            os.fsync(destination.fileno())
        temporary.replace(flash)
        _fsync_directory(device_directory)

    payload = _load_guest_configuration(device)
    framed = struct.pack("<I", len(payload)) + payload
    if len(framed) > configuration.config_size:
        raise ConfigurationError(
            f"{device.id} configuration exceeds its {configuration.config_size}-byte partition"
        )
    if configuration.config_offset + configuration.config_size > flash.stat().st_size:
        raise ConfigurationError(
            f"{device.id} configuration partition exceeds flash image"
        )
    with flash.open("r+b") as destination:
        destination.seek(configuration.config_offset)
        destination.write(framed)
        destination.write(b"\xff" * (configuration.config_size - len(framed)))
        destination.flush()
        os.fsync(destination.fileno())
    if actual_marker != expected_hash:
        _replace_marker(marker, expected_hash)
    return flash


def qemu_arguments(
    configuration: PoolConfiguration, device: Device, flash: Path
) -> list[str]:
    return [
        str(configuration.qemu),
        "-nographic",
        "-machine",
        "esp32s3",
        "-drive",
        f"file={flash},if=mtd,format=raw",
        "-nic",
        f"user,model=open_eth,hostfwd=tcp:127.0.0.1:{device.host_port}-:80",
    ]


def run(configuration: PoolConfiguration) -> int:
    configuration.state_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(configuration.state_directory, 0o700)
    processes: dict[str, subprocess.Popen[bytes]] = {}
    logs: list[Any] = []
    stopping = False

    def request_stop(_signal: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        for device in configuration.devices:
            flash = prepare_device(configuration, device)
            log = (configuration.state_directory / device.id / "qemu.log").open(
                "ab", buffering=0
            )
            logs.append(log)
            processes[device.id] = subprocess.Popen(
                qemu_arguments(configuration, device, flash),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        status_path = configuration.state_directory / "status.json"
        status_path.write_text(
            json.dumps(
                {
                    "kind": "fleet.esp32-pool-status",
                    "version": 1,
                    "devices": [
                        {
                            "id": device.id,
                            "hostPort": device.host_port,
                            "pid": processes[device.id].pid,
                        }
                        for device in configuration.devices
                    ],
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        os.chmod(status_path, 0o600)
        while not stopping:
            exited = [
                (device_id, process.returncode)
                for device_id, process in processes.items()
                if process.poll() is not None
            ]
            if exited:
                print(f"esp32 qemu guest exited: {exited}", file=sys.stderr)
                return 1
            time.sleep(0.2)
        return 0
    finally:
        for process in processes.values():
            if process.poll() is None:
                process.terminate()
        deadline = time.monotonic() + 5
        for process in processes.values():
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for log in logs:
            log.close()
        (configuration.state_directory / "status.json").unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="supervise an esp32-s3 qemu fleet pool"
    )
    parser.add_argument("--config", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        return run(load_configuration(arguments.config))
    except (ConfigurationError, OSError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
