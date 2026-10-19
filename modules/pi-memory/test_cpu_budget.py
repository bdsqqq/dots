import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("cpu_budget", Path(__file__).with_name("cpu-budget.py"))
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


@unittest.skipUnless(sys.platform == "darwin", "Darwin libproc integration")
class CpuBudgetTests(unittest.TestCase):
    def run_fixture(self, nested=False):
        with tempfile.TemporaryDirectory(prefix="pi-cpu-budget-") as directory:
            pidfile = Path(directory) / "pid"
            busy = "setInterval(()=>{const t=Date.now()+10;while(Date.now()<t){}},1)"
            payload = busy if not nested else "require('child_process').spawn(process.execPath,['-e'," + repr(busy) + "],{stdio:'ignore'});setInterval(()=>{},1000)"
            program = "require('fs').writeFileSync(" + repr(str(pidfile)) + ",String(process.pid));process.on('SIGTERM',()=>process.exit(0));" + payload
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("cpu-budget.py")), "--percent", "5", "--", "node", "-e", program])
            child = None
            try:
                deadline = time.monotonic() + 5
                while not pidfile.exists():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.02)
                child = int(pidfile.read_text())
                accounting = budget.Accounting()
                start = accounting.sample(process.pid)
                before = time.monotonic()
                time.sleep(3)
                elapsed = time.monotonic() - before
                consumed = accounting.sample(process.pid) - start
                self.assertGreater(consumed, 0.02, "work must actually make progress")
                self.assertLess(consumed / elapsed, 0.12, "5% budget plus sampling/startup tolerance")
                process.terminate()
                self.assertEqual(process.wait(timeout=5), 0)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child, 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                if child:
                    try:
                        os.killpg(child, signal.SIGCONT)
                        os.killpg(child, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_cpu_bound_work_and_cooperative_shutdown(self):
        self.run_fixture()

    def test_spawned_cpu_work_is_in_the_same_budget(self):
        self.run_fixture(nested=True)

    def test_control_without_governor_exceeds_the_budget(self):
        process = subprocess.Popen(["node", "-e", "while(true){}"])
        try:
            accounting = budget.Accounting()
            time.sleep(0.1)
            before = accounting.sample(process.pid)
            start = time.monotonic()
            time.sleep(0.3)
            used = accounting.sample(process.pid) - before
            self.assertGreater(used / (time.monotonic() - start), 0.35)
        finally:
            process.terminate()
            process.wait(timeout=3)

    def test_child_exit_status_is_preserved(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("cpu-budget.py")), "--percent", "5", "--", "node", "-e", "process.exit(7)"])
        self.assertEqual(result.returncode, 7)


if __name__ == "__main__":
    unittest.main()
