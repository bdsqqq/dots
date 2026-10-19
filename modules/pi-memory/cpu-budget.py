#!/usr/bin/env python3
"""Bound background CPU bandwidth, not work lifetime or retained data.

Darwin has no launchd CPUQuota equivalent. Short process-group scheduling slices
include spawned helpers, keep shutdown cooperative, and never accumulate idle
credit into a later full-speed burst. Linux uses systemd's native cgroup quota.
"""
import argparse
import ctypes
import os
import signal
import subprocess
import sys
import time


class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64)
        for name in (
            "user", "system", "idle", "interrupt", "pageins", "wired",
            "resident", "footprint", "start", "exit", "child_user",
            "child_system", "child_idle", "child_interrupt", "child_pageins",
            "child_elapsed", "disk_read", "disk_write",
        )
    ]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


class Accounting:
    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self.lib.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        system.mach_timebase_info.argtypes = [ctypes.POINTER(Timebase)]
        timebase = Timebase()
        if system.mach_timebase_info(ctypes.byref(timebase)) != 0 or not timebase.denom:
            raise RuntimeError("CPU timebase unavailable")
        self.seconds_per_tick = timebase.numer / timebase.denom / 1e9

    def sample(self, root):
        pending = [root]
        seen = set()
        total = 0.0
        while pending:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            usage = Usage()
            status = self.lib.proc_pid_rusage(pid, 2, ctypes.byref(usage))
            if status != 0 and pid == root:
                raise OSError(ctypes.get_errno(), "CPU accounting unavailable")
            if status == 0:
                # Reaped helpers belong to their parent's child counters; live
                # helpers are visited below. This also counts short-lived fsyncs.
                total += (usage.user + usage.system + usage.child_user + usage.child_system) * self.seconds_per_tick
            children = (ctypes.c_int * 4096)()
            size = self.lib.proc_listchildpids(pid, children, ctypes.sizeof(children))
            if size > 0:
                pending.extend(children[:min(size, 4096)])
        return total


def supervise(command, percent):
    accounting = Accounting()  # Fail before spawning if accounting is unavailable.
    child = None
    stopped = False
    stopping = False

    def send(sig):
        if child is None:
            return
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass

    def shutdown(_sig, _frame):
        nonlocal stopping
        stopping = True
        send(signal.SIGTERM)
        send(signal.SIGCONT)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    child = subprocess.Popen(command, start_new_session=True)
    if stopping:
        shutdown(None, None)
    rate = percent / 100.0
    interval = 0.02
    tokens = 0.0
    previous_time = time.monotonic()
    previous_cpu = 0.0
    try:
        while child.poll() is None:
            now = time.monotonic()
            try:
                cpu = accounting.sample(child.pid)
            except OSError:
                if child.poll() is not None:
                    break
                raise
            tokens = min(rate * interval, tokens + (now - previous_time) * rate - max(0, cpu - previous_cpu))
            previous_time, previous_cpu = now, cpu
            if tokens < 0 and not stopped:
                send(signal.SIGSTOP)
                stopped = True
            elif tokens >= 0 and stopped:
                send(signal.SIGCONT)
                stopped = False
            time.sleep(interval)
        return child.returncode
    finally:
        # A controller failure must not leave a frozen child or uncapped orphan.
        if child.poll() is None:
            send(signal.SIGTERM)
            send(signal.SIGCONT)
            # Retain a conservative wall-time duty cycle if accounting itself
            # failed. Shutdown must not turn a CPU-bound child into an uncapped
            # orphan; no force-kill deadline is imposed on durable publication.
            while child.poll() is None:
                send(signal.SIGCONT)
                time.sleep(interval * rate)
                send(signal.SIGSTOP)
                time.sleep(interval * (1 - rate))
            send(signal.SIGCONT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--percent", type=float, default=5)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if sys.platform != "darwin" or not 0 < args.percent <= 100 or not command:
        parser.error("requires Darwin, 0 < percent <= 100, and a command")
    return supervise(command, args.percent)


if __name__ == "__main__":
    sys.exit(main())
