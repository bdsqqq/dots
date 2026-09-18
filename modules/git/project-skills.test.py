"""Exercise the projection against real, isolated Git repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("project-skills.sh")


class ProjectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1",
                        GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")
        self.env.pop("GIT_INDEX_FILE", None)
        self.source = self.root / "dots"
        self.destination = self.root / "destination"
        for repo in (self.source, self.destination):
            self.git(self.root, "init", "-b", "main", str(repo))
            self.git(repo, "config", "user.name", "Test")
            self.git(repo, "config", "user.email", "test@example.invalid")
        self.write(self.destination, "work-only/SKILL.md", "keep me")
        self.write(self.destination, "shared/SKILL.md", "old")
        self.write(self.destination, "shared/reference.md", "obsolete")
        self.commit(self.destination)
        self.remote = self.root / "remote.git"
        self.git(self.root, "clone", "--bare", str(self.destination), str(self.remote))
        self.git(self.source, "remote", "add", "work", str(self.remote))
        self.write(self.source, "modules/agents/skills/shared/SKILL.md", "new")
        self.write(self.source, "modules/agents/skills/added/SKILL.md", "added")
        self.commit(self.source)

    def git(self, repo, *args, check=True):
        return subprocess.run(["git", "-C", str(repo), *args], env=self.env,
                              text=True, capture_output=True, check=check).stdout.strip()

    def write(self, repo, name, text):
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, repo):
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-m", "fixture")

    def project(self, ref="HEAD", check=True, signer=""):
        return subprocess.run(["bash", str(SCRIPT), str(self.source), ref, "work", "", signer],
                              env=self.env, text=True, capture_output=True, check=check)

    def test_signs_projection_when_a_signer_is_supplied(self):
        key = self.root / "key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)], check=True)
        signer = self.root / "sign"
        signer.write_text(f'''#!/usr/bin/env bash
args=()
for arg in "$@"; do
  if [[ "$arg" == amp-managed ]]; then arg='{key}'; fi
  args+=("$arg")
done
exec ssh-keygen "${{args[@]}}"
''')
        signer.chmod(0o755)
        self.project(signer=str(signer))
        self.assertIn("gpgsig -----BEGIN SSH SIGNATURE-----", self.git(self.remote, "cat-file", "-p", "main"))

    def test_signing_failure_does_not_publish(self):
        before = self.git(self.remote, "rev-parse", "main")
        self.assertNotEqual(self.project(check=False, signer="/usr/bin/false").returncode, 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), before)

    def test_overlay_preserves_unrelated_and_worktree_and_is_idempotent(self):
        before = self.git(self.remote, "rev-parse", "main")
        self.write(self.source, "modules/agents/skills/shared/SKILL.md", "uncommitted")
        index = (self.source / ".git/index").read_bytes()
        self.project()
        self.assertEqual(self.git(self.remote, "show", "main:shared/SKILL.md"), "new")
        self.assertEqual(self.git(self.remote, "show", "main:work-only/SKILL.md"), "keep me")
        self.assertEqual(self.git(self.remote, "show", "main:added/SKILL.md"), "added")
        self.assertNotIn("reference.md", self.git(self.remote, "ls-tree", "-r", "--name-only", "main"))
        self.assertEqual(self.git(self.remote, "rev-parse", "main^"), before)
        self.assertEqual((self.source / ".git/index").read_bytes(), index)
        self.assertEqual((self.source / "modules/agents/skills/shared/SKILL.md").read_text(), "uncommitted")
        after = self.git(self.remote, "rev-parse", "main")
        self.project()
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), after)

    def test_removed_source_skill_is_not_pruned(self):
        self.project()
        self.git(self.source, "rm", "modules/agents/skills/added/SKILL.md")
        self.commit(self.source)
        self.project()
        self.assertEqual(self.git(self.remote, "show", "main:added/SKILL.md"), "added")

    def test_invalid_source_does_not_publish(self):
        before = self.git(self.remote, "rev-parse", "main")
        self.assertNotEqual(self.project("missing", check=False).returncode, 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), before)

    def test_concurrent_destination_update_is_rejected(self):
        # Advance the destination immediately before the projection push.
        hook = self.source / ".git/hooks/pre-push"
        hook.write_text(f'''#!/bin/sh
git --git-dir='{self.remote}' update-ref refs/heads/main "$RACING_COMMIT"
''')
        hook.chmod(0o755)
        old = self.git(self.remote, "rev-parse", "main")
        tree = self.git(self.remote, "rev-parse", "main^{tree}")
        racing = self.git(self.destination, "commit-tree", tree, "-p", old, "-m", "concurrent")
        self.git(self.destination, "push", str(self.remote), f"{racing}:refs/heads/racing")
        self.env["RACING_COMMIT"] = racing
        self.assertNotEqual(self.project(check=False).returncode, 0)
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), racing)


if __name__ == "__main__":
    unittest.main()
