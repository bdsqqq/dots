#!/usr/bin/env python3

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from huggingface_hub import HfApi


PROTOCOL_VERSION = 1


def encoded_json(value):
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def read_json(path):
    return json.loads(Path(path).read_text())


def digest_json(value):
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def write_private(path, value):
    destination = Path(path)
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    parent_mode = stat.S_IMODE(destination.parent.stat().st_mode)
    if parent_mode & 0o077:
        raise SystemExit(f"output directory must be private (0700): {destination.parent}")
    temporary = destination.with_suffix(f"{destination.suffix}.tmp")
    temporary.write_text(encoded_json(value))
    temporary.chmod(0o600)
    temporary.replace(destination)


def catalog(path):
    connection = sqlite3.connect(f"file:{Path(path).resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def validated_queries(value):
    queries = value.get("queries")
    if not isinstance(queries, list) or not queries:
        raise SystemExit("query file must contain a non-empty queries array")
    identifiers = set()
    for query in queries:
        identifier = query.get("id")
        text = query.get("text")
        relevant = query.get("relevantAssetIds", [])
        if not isinstance(identifier, str) or not identifier.strip() or identifier in identifiers:
            raise SystemExit("query IDs must be unique, non-empty strings")
        if not isinstance(text, str) or not text.strip():
            raise SystemExit(f"query {identifier!r} has empty text")
        if not isinstance(relevant, list) or any(not isinstance(item, int) for item in relevant):
            raise SystemExit(f"query {identifier!r} has invalid relevantAssetIds")
        identifiers.add(identifier)
    return queries


def sample_assets(rows, queries, limit, seed):
    by_id = {int(row["asset_id"]): row for row in rows}
    required = {
        asset_id
        for query in queries
        for asset_id in query.get("relevantAssetIds", [])
    }
    unknown = sorted(required - set(by_id))
    if unknown:
        raise SystemExit(f"judgments reference unavailable image assets: {unknown[:10]}")

    def key(row):
        return hashlib.sha256(f"{seed}\0{row['asset_id']}".encode()).digest()

    by_year = {}
    for row in rows:
        year = str(row["media_date"])[:4]
        by_year.setdefault(year, []).append(row)
    landmarks = {
        int(min(year_rows, key=key)["asset_id"])
        for year_rows in by_year.values()
    }
    included = required | landmarks
    if len(included) > limit:
        raise SystemExit(f"limit {limit} cannot include all judged assets and {len(landmarks)} date strata")
    remainder = sorted(
        (row for row in rows if int(row["asset_id"]) not in included),
        key=key,
    )
    included.update(int(row["asset_id"]) for row in remainder[:limit - len(included)])
    return sorted(included)


def prepare(args):
    if args.limit <= 0:
        raise SystemExit("--limit must be positive")
    queries = validated_queries(read_json(args.queries))
    with catalog(args.catalog) as connection:
        rows = connection.execute("""
            SELECT assets.id AS asset_id, min(locations.media_date) AS media_date
            FROM assets
            JOIN locations ON locations.asset_id = assets.id
            WHERE locations.state = 'present' AND locations.media_type = 'image'
            GROUP BY assets.id
        """).fetchall()
    if len(rows) < args.limit:
        raise SystemExit(f"catalog has only {len(rows)} present image assets")
    suite = {
        "schemaVersion": 1,
        "name": args.name,
        "seed": args.seed,
        "assetIds": sample_assets(rows, queries, args.limit, args.seed),
        "queries": queries,
    }
    write_private(args.output, suite)
    print(encoded_json({
        "output": str(Path(args.output).resolve()),
        "suiteDigest": digest_json(suite),
        "assets": len(suite["assetIds"]),
        "queries": len(suite["queries"]),
        "judgedQueries": sum(bool(query.get("relevantAssetIds")) for query in suite["queries"]),
    }), end="")


def directory_digest(path):
    digest = hashlib.sha256()
    for child in sorted(Path(path).rglob("*")):
        if child.is_file():
            digest.update(str(child.relative_to(path)).encode())
            with child.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
    return digest.hexdigest()


def resolved_revision(model, requested, offline):
    path = Path(model)
    if path.is_dir():
        return f"sha256:{directory_digest(path)}"
    if offline:
        if not re.fullmatch(r"[0-9a-f]{40}", requested):
            raise SystemExit("--offline requires a 40-character commit SHA in --revision")
        return requested
    revision = HfApi().model_info(model, revision=requested).sha
    if not revision or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise SystemExit("Hugging Face did not resolve the model to an immutable commit SHA")
    return revision


def decoded_vector(value):
    if value["encoding"] != "f32le-base64":
        raise ValueError("worker returned an unsupported vector encoding")
    dimensions = value.get("dimensions")
    if not isinstance(dimensions, int) or dimensions <= 0:
        raise ValueError("worker returned invalid vector dimensions")
    try:
        decoded = base64.b64decode(value["data"], validate=True)
    except (binascii.Error, ValueError, TypeError) as error:
        raise ValueError("worker returned invalid vector base64") from error
    vector = np.frombuffer(decoded, dtype="<f4").copy()
    if vector.shape != (dimensions,) or not np.isfinite(vector).all():
        raise ValueError("worker returned an invalid vector")
    return vector


def response_vectors(response, requested_tokens, allow_failures):
    expected = set(requested_tokens)
    if len(expected) != len(requested_tokens):
        raise ValueError("request tokens must be unique")
    items = response.get("items")
    failures = response.get("failures", [])
    if not isinstance(items, list) or not isinstance(failures, list):
        raise ValueError("worker returned invalid item collections")
    success_tokens = [item.get("token") for item in items]
    failure_tokens = [item.get("token") for item in failures]
    if len(set(success_tokens)) != len(success_tokens) or len(set(failure_tokens)) != len(failure_tokens):
        raise ValueError("worker returned duplicate tokens")
    success = set(success_tokens)
    failed = set(failure_tokens)
    if success & failed:
        raise ValueError("worker returned a token as both success and failure")
    if not allow_failures and failed:
        raise ValueError("worker failed a required item")
    if success | failed != expected:
        raise ValueError("worker response does not partition the requested tokens")
    return {item["token"]: decoded_vector(item["vector"]) for item in items}, failures


class Worker:
    def __init__(self, args, revision):
        command = [
            sys.executable,
            args.worker,
            "--model", args.model,
            "--device", args.device,
        ]
        if not Path(args.model).is_dir():
            command.extend(["--revision", revision])
        if args.offline:
            command.append("--offline")
        environment = os.environ.copy()
        environment["PYTHONNOUSERSITE"] = "1"
        environment.pop("PYTORCH_ENABLE_MPS_FALLBACK", None)
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            env=environment,
        )
        self.sequence = 0

    def request(self, operation, items=None):
        self.sequence += 1
        message = {"protocol": PROTOCOL_VERSION, "id": f"r{self.sequence}", "op": operation}
        if items is not None:
            message["items"] = items
        try:
            self.process.stdin.write(json.dumps(message) + "\n")
            self.process.stdin.flush()
        except BrokenPipeError as error:
            raise RuntimeError(f"worker exited before {operation} (status {self.process.poll()})") from error
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f"worker exited before replying to {operation} (status {self.process.poll()})")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"worker returned invalid JSON for {operation}") from error
        if response.get("id") != message["id"] or response.get("protocol") != PROTOCOL_VERSION:
            raise RuntimeError("worker protocol mismatch")
        if not response.get("ok"):
            raise RuntimeError(response.get("error", "worker request failed"))
        return response

    def close(self):
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.process.stdout:
            self.process.stdout.close()


def batched(values, size):
    for index in range(0, len(values), size):
        yield values[index:index + size]


def asset_locations(connection, asset_ids):
    placeholders = ",".join("?" for _ in asset_ids)
    rows = connection.execute(f"""
        SELECT locations.asset_id, locations.path, locations.media_date
        FROM locations
        WHERE locations.asset_id IN ({placeholders})
          AND locations.state = 'present' AND locations.media_type = 'image'
        ORDER BY locations.asset_id, locations.path
    """, asset_ids).fetchall()
    selected = {}
    for row in rows:
        selected.setdefault(int(row["asset_id"]), dict(row))
    return selected


def metrics_for(ranked_ids, relevant_ids):
    relevant = set(relevant_ids)
    first = next((index for index, asset_id in enumerate(ranked_ids, 1) if asset_id in relevant), None)
    return {
        "successAt10": bool(relevant.intersection(ranked_ids[:10])),
        "reciprocalRank": 0 if first is None else 1 / first,
    }


def validate_selection_suite(suite):
    asset_ids = set(suite["assetIds"])
    if not 600 <= len(asset_ids) <= 1000:
        raise SystemExit("selection runs require 600–1,000 unique assets")
    if not 20 <= len(suite["queries"]) <= 30:
        raise SystemExit("selection runs require 20–30 queries")
    for query in suite["queries"]:
        relevant = set(query.get("relevantAssetIds", []))
        if not relevant:
            raise SystemExit(f"selection query {query['id']!r} has no relevance judgments")
        if not relevant <= asset_ids:
            raise SystemExit(f"selection query {query['id']!r} references assets outside the suite")


def validate_descriptor(descriptor, args, revision):
    required = {
        "protocol": PROTOCOL_VERSION,
        "model": args.model,
        "device": args.device,
        "dtype": "float32",
        "normalized": True,
        "cpuFallback": False,
    }
    for key, expected in required.items():
        if descriptor.get(key) != expected:
            raise RuntimeError(f"worker descriptor has unexpected {key}")
    if not Path(args.model).is_dir() and descriptor.get("revision") != revision:
        raise RuntimeError("worker descriptor has unexpected revision")


def run(args):
    if args.batch_size <= 0 or args.top_k <= 0:
        raise SystemExit("--batch-size and --top-k must be positive")
    suite = read_json(args.suite)
    if suite.get("schemaVersion") != 1:
        raise SystemExit("unsupported benchmark suite schema")
    if not isinstance(suite.get("assetIds"), list) or not suite["assetIds"]:
        raise SystemExit("suite must contain image asset IDs")
    if any(not isinstance(asset_id, int) for asset_id in suite["assetIds"]):
        raise SystemExit("suite asset IDs must be integers")
    if len(set(suite["assetIds"])) != len(suite["assetIds"]):
        raise SystemExit("suite asset IDs must be unique")
    suite["queries"] = validated_queries(suite)
    if args.selection:
        validate_selection_suite(suite)
    suite_digest = digest_json(suite)
    revision = resolved_revision(args.model, args.revision, args.offline)
    with catalog(args.catalog) as connection:
        locations = asset_locations(connection, suite["assetIds"])
    missing = sorted(set(suite["assetIds"]) - set(locations))
    if missing:
        raise SystemExit(f"suite assets are unavailable: {missing[:10]}")

    worker = Worker(args, revision)
    started = time.perf_counter()
    try:
        descriptor = worker.request("describe")["descriptor"]
        validate_descriptor(descriptor, args, revision)
        vectors = {}
        failures = []
        image_started = time.perf_counter()
        source = Path(args.source).resolve(strict=True)
        paths = {}
        image_dimensions = None
        for asset_id, location in locations.items():
            path = Path(source, location["path"]).resolve(strict=True)
            if not path.is_relative_to(source):
                raise RuntimeError(f"catalog path escapes source root: {location['path']}")
            paths[asset_id] = path
        for batch in batched(suite["assetIds"], args.batch_size):
            items = [
                {
                    "token": str(asset_id),
                    "path": str(paths[asset_id]),
                }
                for asset_id in batch
            ]
            response = worker.request("embed_image", items)
            batch_vectors, batch_failures = response_vectors(
                response,
                [item["token"] for item in items],
                allow_failures=True,
            )
            failures.extend(batch_failures)
            for token, vector in batch_vectors.items():
                if image_dimensions is None:
                    image_dimensions = len(vector)
                elif len(vector) != image_dimensions:
                    raise RuntimeError("worker returned inconsistent image dimensions")
                vectors[int(token)] = vector
        image_seconds = time.perf_counter() - image_started
        if not vectors:
            raise RuntimeError("worker produced no image embeddings")
        if args.selection and failures:
            raise RuntimeError("selection run cannot omit image decode failures")

        asset_ids = sorted(vectors)
        matrix = np.stack([vectors[asset_id] for asset_id in asset_ids])
        query_items = [
            {"token": query["id"], "text": query["text"]}
            for query in suite["queries"]
        ]
        query_response = worker.request("embed_text", query_items)
        query_vectors, _ = response_vectors(
            query_response,
            [item["token"] for item in query_items],
            allow_failures=False,
        )
        if any(len(vector) != matrix.shape[1] for vector in query_vectors.values()):
            raise RuntimeError("worker returned incompatible image and text dimensions")
        results = []
        judged_metrics = []
        for query in suite["queries"]:
            scores = matrix @ query_vectors[query["id"]]
            order = np.argsort(-scores)
            ranked = [asset_ids[index] for index in order]
            judgment = None
            if query.get("relevantAssetIds"):
                judgment = metrics_for(ranked, query["relevantAssetIds"])
                judged_metrics.append(judgment)
            results.append({
                "id": query["id"],
                "text": query["text"],
                "metrics": judgment,
                "top": [
                    {
                        "assetId": asset_ids[index],
                        "score": float(scores[index]),
                        "path": locations[asset_ids[index]]["path"],
                        "date": locations[asset_ids[index]]["media_date"],
                    }
                    for index in order[:args.top_k]
                ],
            })
        output = {
            "schemaVersion": 1,
            "runType": "selection" if args.selection else "smoke",
            "suite": suite["name"],
            "suiteDigest": suite_digest,
            "model": args.model,
            "revision": revision,
            "descriptor": descriptor,
            "corpus": {
                "requested": len(suite["assetIds"]),
                "embedded": len(vectors),
                "failures": failures,
            },
            "timing": {
                "totalSeconds": time.perf_counter() - started,
                "imageSeconds": image_seconds,
                "imagesPerSecond": len(vectors) / image_seconds,
            },
            "metrics": {
                "judgedQueries": len(judged_metrics),
                "successAt10": None if not judged_metrics else sum(item["successAt10"] for item in judged_metrics) / len(judged_metrics),
                "meanReciprocalRank": None if not judged_metrics else sum(item["reciprocalRank"] for item in judged_metrics) / len(judged_metrics),
            },
            "queries": results,
        }
        write_private(args.output, output)
        print(encoded_json({
            "output": str(Path(args.output).resolve()),
            "revision": revision,
            "runType": output["runType"],
            "suiteDigest": suite_digest,
            **output["corpus"],
            **output["timing"],
            **output["metrics"],
        }), end="")
    finally:
        worker.close()


def pool(args):
    if not 1 <= len(args.reports) <= 3:
        raise SystemExit("pool accepts one to three candidate reports")
    reports = [read_json(path) for path in args.reports]
    digests = {report.get("suiteDigest") for report in reports}
    if len(digests) != 1 or None in digests:
        raise SystemExit("candidate reports do not share one suite digest")
    query_sets = [
        [(query.get("id"), query.get("text")) for query in report.get("queries", [])]
        for report in reports
    ]
    if not query_sets[0] or any(queries != query_sets[0] for queries in query_sets[1:]):
        raise SystemExit("candidate reports do not share identical queries")
    pooled = []
    for index, (identifier, text) in enumerate(query_sets[0]):
        candidates = {}
        for report in reports:
            for item in report["queries"][index].get("top", []):
                candidates[item["assetId"]] = {
                    "assetId": item["assetId"],
                    "date": item["date"],
                    "path": item["path"],
                }
        pooled.append({
            "id": identifier,
            "text": text,
            "relevantAssetIds": [],
            "candidates": sorted(candidates.values(), key=lambda item: item["assetId"]),
        })
    output = {
        "schemaVersion": 1,
        "suiteDigest": next(iter(digests)),
        "queries": pooled,
    }
    write_private(args.output, output)
    print(encoded_json({
        "output": str(Path(args.output).resolve()),
        "reports": len(reports),
        "queries": len(pooled),
        "suiteDigest": output["suiteDigest"],
    }), end="")


def capabilities(_args):
    import torch
    value = {
        "torch": torch.__version__,
        "mpsBuilt": torch.backends.mps.is_built(),
        "mpsAvailable": torch.backends.mps.is_available(),
        "cpuFallback": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1",
    }
    print(encoded_json(value), end="")
    if not value["mpsAvailable"]:
        raise SystemExit(1)


def parser():
    root = argparse.ArgumentParser(description="Reproducible private semantic-search benchmark")
    root.add_argument("--worker", required=True, help=argparse.SUPPRESS)
    commands = root.add_subparsers(dest="command", required=True)

    command = commands.add_parser("capabilities")
    command.set_defaults(function=capabilities)

    command = commands.add_parser("prepare")
    command.add_argument("--catalog", required=True)
    command.add_argument("--queries", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--name", default="semantic-v1")
    command.add_argument("--limit", type=int, default=1000)
    command.add_argument("--seed", type=int, default=20260821)
    command.set_defaults(function=prepare)

    command = commands.add_parser("run")
    command.add_argument("--catalog", required=True)
    command.add_argument("--source", required=True)
    command.add_argument("--suite", required=True)
    command.add_argument("--model", required=True)
    command.add_argument("--revision", default="main")
    command.add_argument("--output", required=True)
    command.add_argument("--device", choices=["mps", "cpu"], default="mps")
    command.add_argument("--batch-size", type=int, default=8)
    command.add_argument("--top-k", type=int, default=20)
    command.add_argument("--offline", action="store_true")
    command.add_argument("--selection", action="store_true")
    command.set_defaults(function=run)

    command = commands.add_parser("pool")
    command.add_argument("--reports", nargs="+", required=True)
    command.add_argument("--output", required=True)
    command.set_defaults(function=pool)
    return root


def main():
    args = parser().parse_args()
    args.function(args)


if __name__ == "__main__":
    main()
