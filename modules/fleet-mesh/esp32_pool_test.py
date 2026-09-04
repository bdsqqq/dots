import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import esp32_pool
from esp32_pool import (
    ConfigurationError,
    FLEET_STATE_OFFSET,
    FLEET_STATE_SIZE,
    load_configuration,
    prepare_device,
    qemu_arguments,
)


class Esp32PoolTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.firmware = self.root / "base.bin"
        self.firmware.write_bytes(b"\xff" * 4096)
        self.public = self.root / "public.json"
        self.public.write_text(
            json.dumps(
                {
                    "version": 1,
                    "fleet": "home",
                    "authority": {"id": "admin", "publicKey": "public"},
                    "roster": [],
                    "peers": [],
                    "contactIntervalMs": 2000,
                    "contactTimeoutMs": 1000,
                }
            )
        )
        self.identity = self.root / "identity.json"
        self.identity.write_text(
            json.dumps(
                {
                    "id": "sim-1",
                    "signingPublicKey": "signing-public",
                    "encryptionPublicKey": "encryption-public",
                    "signingPrivateKey": "signing-private",
                    "encryptionPrivateKey": "encryption-private",
                }
            )
        )

    def tearDown(self):
        self.temporary.cleanup()

    def configuration(self, **overrides):
        value = {
            "version": 1,
            "firmwareImage": str(self.firmware),
            "qemu": "/qemu-system-xtensa",
            "stateDirectory": str(self.root / "state"),
            "configOffset": 1024,
            "configSize": 2048,
            "devices": [
                {
                    "id": "sim-1",
                    "hostPort": 43201,
                    "publicConfigurationPath": str(self.public),
                    "identityPath": str(self.identity),
                }
            ],
        }
        value.update(overrides)
        path = self.root / "pool.json"
        path.write_text(json.dumps(value))
        return load_configuration(path)

    def test_prepares_independent_flash_with_framed_private_configuration(self):
        configuration = self.configuration()
        device = configuration.devices[0]
        flash = prepare_device(configuration, device)
        contents = flash.read_bytes()
        length = struct.unpack("<I", contents[1024:1028])[0]
        provisioned = json.loads(contents[1028 : 1028 + length])
        self.assertEqual(provisioned["identity"]["id"], "sim-1")
        self.assertEqual(provisioned["fleet"], "home")
        self.assertEqual(
            contents[1028 + length : 1024 + 2048], b"\xff" * (2044 - length)
        )
        self.assertEqual(flash.stat().st_mode & 0o777, 0o600)

    def test_firmware_upgrade_preserves_the_exact_fleet_state_partition(self):
        image_size = 0x260000
        self.firmware.write_bytes(b"\xaa" * image_size)
        configuration = self.configuration(
            configOffset=0x250000,
            configSize=0x10000,
        )
        device = configuration.devices[0]
        flash = prepare_device(configuration, device)
        preserved = bytes(index % 251 for index in range(FLEET_STATE_SIZE))
        with flash.open("r+b") as destination:
            destination.seek(FLEET_STATE_OFFSET)
            destination.write(preserved)

        self.firmware.write_bytes(b"\xbb" * image_size)
        upgraded = prepare_device(configuration, device).read_bytes()
        self.assertEqual(upgraded[:16], b"\xbb" * 16)
        self.assertEqual(
            upgraded[FLEET_STATE_OFFSET : FLEET_STATE_OFFSET + FLEET_STATE_SIZE],
            preserved,
        )

    def test_interrupted_upgrade_cannot_confuse_a_later_rollback(self):
        image_size = 0x260000
        original = b"\xaa" * image_size
        self.firmware.write_bytes(original)
        configuration = self.configuration(
            configOffset=0x250000,
            configSize=0x10000,
        )
        device = configuration.devices[0]
        flash = prepare_device(configuration, device)
        preserved = b"\x5a" * FLEET_STATE_SIZE
        with flash.open("r+b") as destination:
            destination.seek(FLEET_STATE_OFFSET)
            destination.write(preserved)

        self.firmware.write_bytes(b"\xbb" * image_size)
        replace_marker = esp32_pool._replace_marker
        calls = 0

        def interrupt_final_marker(marker, value):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("simulated power loss")
            replace_marker(marker, value)

        with mock.patch.object(
            esp32_pool,
            "_replace_marker",
            side_effect=interrupt_final_marker,
        ):
            with self.assertRaisesRegex(RuntimeError, "simulated power loss"):
                prepare_device(configuration, device)

        marker = flash.parent / "firmware.sha256"
        self.assertEqual(marker.read_text().strip(), "updating")
        self.assertEqual(flash.read_bytes()[:16], b"\xbb" * 16)

        self.firmware.write_bytes(original)
        rolled_back = prepare_device(configuration, device).read_bytes()
        self.assertEqual(rolled_back[:16], b"\xaa" * 16)
        self.assertEqual(
            rolled_back[
                FLEET_STATE_OFFSET : FLEET_STATE_OFFSET + FLEET_STATE_SIZE
            ],
            preserved,
        )

    def test_qemu_is_s3_with_openeth_and_loopback_forward(self):
        configuration = self.configuration()
        device = configuration.devices[0]
        arguments = qemu_arguments(configuration, device, self.root / "flash.bin")
        self.assertIn("-nographic", arguments)
        self.assertIn("esp32s3", arguments)
        self.assertIn("user,model=open_eth,hostfwd=tcp:127.0.0.1:43201-:80", arguments)
        self.assertNotIn("-m", arguments)
        self.assertNotIn("-display", arguments)

    def test_rejects_duplicate_ports(self):
        first = {
            "id": "sim-1",
            "hostPort": 43201,
            "publicConfigurationPath": str(self.public),
            "identityPath": str(self.identity),
        }
        duplicate = {
            "id": "sim-2",
            "hostPort": 43201,
            "publicConfigurationPath": str(self.public),
            "identityPath": str(self.identity),
        }
        with self.assertRaisesRegex(ConfigurationError, "duplicate host port"):
            self.configuration(devices=[first, duplicate])


if __name__ == "__main__":
    unittest.main()
