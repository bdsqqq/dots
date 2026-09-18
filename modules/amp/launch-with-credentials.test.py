"""Exercise launcher credential precedence using synthetic values only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("launch-with-credentials.sh")
VARIABLES = ("AMP_API_KEY", "AXIOM_TOKEN", "AXIOM_ORG_ID")


class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if k not in VARIABLES}
        self.files = []
        for name, value in zip(VARIABLES, ("personal-amp", "personal-axiom", "personal-org")):
            path = self.root / name
            path.write_text(value + "\n")
            self.files.append(str(path))
        self.probe = self.root / "amp"
        self.probe.write_text(f"#!{sys.executable}\n" +
                             "import json, os, sys\n" +
                             f"print(json.dumps({{'env': {{k: os.environ.get(k) for k in {VARIABLES!r}}}, 'args': sys.argv[1:]}}))\n")
        self.probe.chmod(0o755)

    def run_launcher(self, files=None):
        return subprocess.run(["bash", str(SCRIPT), str(self.probe),
                               *(self.files if files is None else files), "argument with spaces"],
                              env=self.env, capture_output=True, text=True)

    def result(self, files=None):
        result = self.run_launcher(files)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("personal-axiom", result.stderr)
        return json.loads(result.stdout), result.stderr

    def test_loads_sops_pair_and_preserves_arguments(self):
        data, stderr = self.result()
        self.assertEqual(data["env"], dict(zip(VARIABLES, ("personal-amp", "personal-axiom", "personal-org"))))
        self.assertEqual(data["args"], ["argument with spaces"])
        self.assertEqual(stderr, "")

    def test_preserves_work_amp_and_explicit_axiom_pair(self):
        overrides = dict(zip(VARIABLES, ("work-amp", "chosen-axiom", "chosen-org")))
        self.env.update(overrides)
        data, stderr = self.result()
        self.assertEqual(data["env"], overrides)
        self.assertEqual(stderr, "")

    def test_never_mixes_a_partial_override(self):
        for name in ("AXIOM_TOKEN", "AXIOM_ORG_ID"):
            with self.subTest(name=name):
                self.env.pop("AXIOM_TOKEN", None)
                self.env.pop("AXIOM_ORG_ID", None)
                self.env[name] = "explicit"
                data, stderr = self.result()
                self.assertEqual(data["env"][name], "explicit")
                other = "AXIOM_ORG_ID" if name == "AXIOM_TOKEN" else "AXIOM_TOKEN"
                self.assertIsNone(data["env"][other])
                self.assertIn("refusing to mix", stderr)

    def test_missing_sops_file_leaves_both_axiom_variables_unset(self):
        Path(self.files[2]).unlink()
        data, stderr = self.result()
        self.assertIsNone(data["env"]["AXIOM_TOKEN"])
        self.assertIsNone(data["env"]["AXIOM_ORG_ID"])
        self.assertIn("unavailable", stderr)

    def test_empty_sops_file_leaves_both_axiom_variables_unset(self):
        Path(self.files[2]).write_text("")
        data, stderr = self.result()
        self.assertIsNone(data["env"]["AXIOM_TOKEN"])
        self.assertIsNone(data["env"]["AXIOM_ORG_ID"])
        self.assertIn("empty", stderr)

    def test_no_configured_credentials_preserves_login_based_auth(self):
        data, stderr = self.result(["", "", ""])
        self.assertEqual(data["env"], dict.fromkeys(VARIABLES))
        self.assertEqual(stderr, "")

    def test_missing_amp_secret_fails_unless_environment_overrides_it(self):
        Path(self.files[0]).unlink()
        self.assertNotEqual(self.run_launcher().returncode, 0)
        self.env["AMP_API_KEY"] = "work-amp"
        data, _ = self.result()
        self.assertEqual(data["env"]["AMP_API_KEY"], "work-amp")


if __name__ == "__main__":
    unittest.main()
