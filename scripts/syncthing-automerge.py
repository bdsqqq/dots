# This script automatically handles Syncthing conflicts on text files by applying a
# git three-way merge between the previously synced version and each divergent version.
# https://gist.github.com/solarkraft/26fe291a3de075ae8d96e1ada928fb7d

# It depends on the watchdog package and git.

# For automatic dependency installation when running with ´uv run --script syncthing-automerge.py´:
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "watchdog",
# ]
# ///

# This code is MIT Licensed:

# Copyright 2024 solarkraft

# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:

# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.

# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import os
import time
import re
import subprocess
from watchdog.observers import Observer as FileSystemObserver
from watchdog.events import FileSystemEventHandler


def get_relative_path(path):
    return os.path.relpath(path)


def merge_files(original, backup, conflict):
    command = ["git", "merge-file", "--union", original, backup, conflict]
    print("Performing three way merge with git command:")
    print(" ".join(command))
    exitcode = subprocess.call(command, cwd=os.getcwd())
    if exitcode != 0:
        raise RuntimeError("Git command failed!")


def merge_if_applicable(src_path):
    """Perform a three way merge on and remove a given possible syncthing conflict file if:
    - It is an actual conflict file (determined by naming scheme)
    - The associated canonical file exists ("real" file path)
    - A backup file in .stversions exists
    """

    if not os.path.isfile(src_path):
        # print(src_path, "is not a file")
        return

    candidate_file_path = get_relative_path(src_path)

    match = re.search(
        # . is converted to %2F when a conflict file is opened in Logseq
        "^(.*?)(?:\\.|%2F)sync-conflict-([0-9]{8})-([0-9]{6})-(.{7})\\.?(.*)$",
        candidate_file_path,
    )

    if match is None:
        # The file is not a syncthing conflict file
        # print(candidate_file_path, "is not a conflict file")
        return

    conflict_file_path = candidate_file_path

    print()  # Make run easier to recognize
    print("Conflict file found:", conflict_file_path)

    # print(x.groups())

    conflict_file_name = match.group(1)
    conflict_file_date = match.group(2)
    conflict_file_time = match.group(3)
    conflict_file_id = match.group(4)
    conflict_file_extension = match.group(5)
    # print(conflict_file_path, conflict_file_date, conflict_file_time, conflict_file_id, conflict_file_extension)

    # HACK: Give Syncthing some time to move the tmpfile (.syncthing.MyFileName) to its real location
    time.sleep(0.1)

    original_file_path = conflict_file_name + "." + conflict_file_extension
    if not os.path.isfile(original_file_path):
        print("... but original file", original_file_path, "doesn't exist")
        print("(could be a syncthing tmpfile)")

        # Here we may be too early to leave before Syncthing has moved its timpfile to the real location
        # .syncthing.Testseite.md.tmp
        # print("... what about the Syncthing tempfile?")
        # p = list(os.path.split(original_file_path))
        # tmpfile_name = ".syncthing." + p.pop() + ".tmp"
        # print("name:", tmpfile_name, "path:", p)
        return

    print("For original file:", original_file_path)

    backup_file_regex_string = (
        ".stversions/"
        + conflict_file_name
        + r"~([0-9]{8})-([0-9]{6})\."
        + conflict_file_extension
    )
    backup_file_regex = re.compile(backup_file_regex_string)

    backup_files = []

    for dirpath, subdirs, files in os.walk(os.getcwd() + "/.stversions/"):
        for file in files:
            candidate_path = str(os.path.join(get_relative_path(dirpath), file))
            # print("Test:", candidate)

            match = backup_file_regex.match(candidate_path)
            if match:
                backup_file_date = match.group(1)
                backup_file_time = match.group(2)
                # print("Matched:", candidate_path, backup_file_date, backup_file_time)
                backup_files.append(candidate_path)

    if len(backup_files) == 0:
        print(
            f"No backup file candidates were found by pattern {backup_file_regex_string}. There isn't enough data for a three way merge."
        )
        print("This may be due to custom versioning settings - try simple versioning.")

        # (TODO): We can still merge the 2 files here. This will increase compatiblility with other versioning schemes

        return

    # print("Backup files:", backup_files)

    # We want the latest backup file, which is the first in the list (??? maybe they are sorted differently)
    backup_file = backup_files[0]
    print("Latest backup file:", backup_file)

    merge_files(original_file_path, backup_file, conflict_file_path)

    print("Deleting conflict file")
    os.remove(os.path.join(os.getcwd(), conflict_file_path))

    print("Deconfliction done!")
    print()


class FileChangeHandler(FileSystemEventHandler):
    # To support manually "touch"ing a file to get the script to handle it
    @staticmethod
    def on_modified(event):
        # print("A file was modified (this may have been for debugging purposes)")
        merge_if_applicable(event.src_path)

    # This is how Syncthing creates the conflict files
    @staticmethod
    def on_moved(event):
        # print("A file was moved, may have been syncthing")
        # print(event) # Syncthing does some moving-around business

        merge_if_applicable(event.dest_path)


if __name__ == "__main__":
    print("Running Syncthing deconflicter")

    # timeout=10 prevents events being lost on macOS
    observer = FileSystemObserver(timeout=10)
    event_handler = FileChangeHandler()
    path = "."

    # From quickstart
    observer.schedule(event_handler, path, recursive=True)
    observer.start()

    try:
        while observer.is_alive():
            observer.join(1)
    finally:
        observer.stop()
        observer.join()
        print("Stopped Syncthing deconflicter")
