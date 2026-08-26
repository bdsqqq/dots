#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from collections import Counter
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
ECAPA_REPOSITORY = "speechbrain/spkrec-ecapa-voxceleb"
ECAPA_REVISION = "0f99f2d0ebe89ac095bcc5903c4dd8f72b367286"
ECAPA_REQUIRED_FILES = (
    "classifier.ckpt",
    "embedding_model.ckpt",
    "hyperparams.yaml",
    "label_encoder.txt",
    "mean_var_norm_emb.ckpt",
)
ECAPA_FILE_HASHES = {
    "classifier.ckpt": "fd9e3634fe68bd0a427c95e354c0c677374f62b3f434e45b78599950d860d535",
    "embedding_model.ckpt": "0575cb64845e6b9a10db9bcb74d5ac32b326b8dc90352671d345e2ee3d0126a2",
    "hyperparams.yaml": "6f78854fa04ba59e761437b76a2575d3aba5e5016de3e9b69f0c9a5077fb1a41",
    "label_encoder.txt": "e13c3a167bb4112685670ee896d20e2b565af16b3a4ceeaa8689fa4d22adb8b9",
    "mean_var_norm_emb.ckpt": "cd70225b05b37be64fc5a95e24395d804231d43f74b2e1e5a513db7b69b34c33",
}
MODEL_SPECS = {
    "whisper": {
        "filename": "ggml-large-v3-turbo.bin",
        "url": (
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/"
            "5359861c739e955e79d9a303bcbc70fb988958b1/"
            "ggml-large-v3-turbo.bin"
        ),
        "sha256": "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    },
    "vad": {
        "filename": "ggml-silero-v6.2.0.bin",
        "url": (
            "https://huggingface.co/ggml-org/whisper-vad/resolve/"
            "9ffd54a1e1ee413ddf265af9913beaf518d1639b/"
            "ggml-silero-v6.2.0.bin"
        ),
        "sha256": "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    },
}


def configured_path(environment_name: str, fallback: str) -> Path:
    return Path(os.environ.get(environment_name, fallback)).expanduser().resolve()


def model_directory() -> Path:
    return configured_path(
        "DARWIN_TRANSCRIPTION_MODEL_DIR",
        "~/Library/Caches/darwin-transcription/models",
    )


def profile_directory() -> Path:
    return configured_path(
        "DARWIN_TRANSCRIPTION_PROFILE_DIR",
        "~/commonplace/01_files/_utilities/speaker-profiles",
    )


def default_profile_specs() -> list[str]:
    raw = os.environ.get("DARWIN_TRANSCRIPTION_DEFAULT_PROFILES_JSON", "[]")
    try:
        values = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "DARWIN_TRANSCRIPTION_DEFAULT_PROFILES_JSON is invalid"
        ) from error
    if not isinstance(values, list) or not all(
        isinstance(value, str) for value in values
    ):
        raise RuntimeError(
            "DARWIN_TRANSCRIPTION_DEFAULT_PROFILES_JSON must be a string array"
        )
    return values


def output_directory() -> Path:
    return configured_path(
        "DARWIN_TRANSCRIPTION_OUTPUT_DIR",
        "~/commonplace/02_temp/darwin-transcription",
    )


def state_directory() -> Path:
    return configured_path(
        "DARWIN_TRANSCRIPTION_STATE_DIR",
        "~/Library/Application Support/darwin-transcription",
    )


def whisper_binary() -> str:
    return os.environ.get("DARWIN_TRANSCRIPTION_WHISPER_CLI", "whisper-cli")


def run(
    command: list[str],
    *,
    stdout: Any = subprocess.PIPE,
    stderr: Any = subprocess.PIPE,
    text: bool = True,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        check=True,
        stdout=stdout,
        stderr=stderr,
        text=text,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(value)
    os.replace(temporary, path)


def atomic_json(path: Path, value: Any) -> None:
    atomic_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    return (
        f"{milliseconds // 3_600_000:02d}:"
        f"{milliseconds // 60_000 % 60:02d}:"
        f"{milliseconds // 1000 % 60:02d}."
        f"{milliseconds % 1000:03d}"
    )


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w ]", "", text.lower())).strip()


def safe_identifier(value: str) -> str:
    result = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip(".-")
    if not result:
        raise ValueError(f"invalid recording identifier: {value!r}")
    return result


def float_at_least_one(value: str) -> float:
    result = float(value)
    if result < 1.0:
        raise argparse.ArgumentTypeError("value must be at least 1.0")
    return result


def positive_integer(value: str) -> int:
    result = int(value)
    if result < 1:
        raise argparse.ArgumentTypeError("value must be at least one")
    return result


def source_identity(source: Path) -> dict[str, Any]:
    stat = source.stat()
    return {
        "path": str(source),
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "sha256": sha256_file(source),
    }


def assert_source_unchanged(source: Path, before: dict[str, Any]) -> None:
    after = source.stat()
    if after.st_size != before["size"] or after.st_mtime_ns != before["mtime_ns"]:
        raise RuntimeError(f"source changed while transcription was running: {source}")


def ffprobe(source: Path) -> dict[str, Any]:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(source),
        ]
    )
    return json.loads(result.stdout)


def source_duration(probe: dict[str, Any]) -> float:
    candidates = [probe.get("format", {}).get("duration")]
    candidates.extend(stream.get("duration") for stream in probe.get("streams", []))
    durations = [float(value) for value in candidates if value not in (None, "N/A")]
    if not durations:
        raise RuntimeError("ffprobe did not report an audio duration")
    return max(durations)


def convert_audio(source: Path, destination: Path, stream_index: int | None) -> None:
    command = ["ffmpeg", "-y", "-v", "error", "-i", str(source)]
    if stream_index is not None:
        command.extend(["-map", f"0:{stream_index}"])
    command.extend(
        [
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(destination),
        ]
    )
    run(command)


def model_path(kind: str) -> Path:
    return model_directory() / MODEL_SPECS[kind]["filename"]


def ecapa_path() -> Path:
    return model_directory() / f"ecapa-{ECAPA_REVISION}"


def ecapa_marker_path() -> Path:
    return ecapa_path() / ".darwin-transcription-revision"


def verify_models(*, raise_on_error: bool = True) -> dict[str, Any]:
    result: dict[str, Any] = {}
    errors = []
    for kind, specification in MODEL_SPECS.items():
        path = model_path(kind)
        actual = sha256_file(path) if path.is_file() else None
        valid = actual == specification["sha256"]
        result[kind] = {
            "path": str(path),
            "exists": path.is_file(),
            "sha256": actual,
            "expected_sha256": specification["sha256"],
            "valid": valid,
        }
        if not valid:
            errors.append(f"{kind} model is missing or has the wrong hash: {path}")

    ecapa_files = {}
    for name in ECAPA_REQUIRED_FILES:
        path = ecapa_path() / name
        actual = sha256_file(path) if path.is_file() else None
        ecapa_files[name] = {
            "sha256": actual,
            "expected_sha256": ECAPA_FILE_HASHES[name],
            "valid": actual == ECAPA_FILE_HASHES[name],
        }
    invalid_ecapa = [
        name for name, status in ecapa_files.items() if not status["valid"]
    ]
    marker = ecapa_marker_path().read_text().strip() if ecapa_marker_path().is_file() else None
    ecapa_valid = marker == ECAPA_REVISION and not invalid_ecapa
    result["ecapa"] = {
        "path": str(ecapa_path()),
        "revision": marker,
        "expected_revision": ECAPA_REVISION,
        "files": ecapa_files,
        "invalid_files": invalid_ecapa,
        "valid": ecapa_valid,
    }
    if not ecapa_valid:
        errors.append(f"ECAPA snapshot is incomplete or unpinned: {ecapa_path()}")

    result["valid"] = not errors
    if errors and raise_on_error:
        raise RuntimeError("\n".join(errors))
    return result


def download_file(url: str, destination: Path, expected_sha256: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256_file(destination) == expected_sha256:
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    run(
        [
            "curl",
            "--location",
            "--fail",
            "--retry",
            "3",
            "--continue-at",
            "-",
            "--output",
            str(partial),
            url,
        ]
    )
    actual = sha256_file(partial)
    if actual != expected_sha256:
        raise RuntimeError(
            f"download hash mismatch for {destination.name}: "
            f"expected {expected_sha256}, got {actual}"
        )
    os.replace(partial, destination)


def fetch_models() -> dict[str, Any]:
    model_directory().mkdir(parents=True, exist_ok=True, mode=0o700)
    for kind, specification in MODEL_SPECS.items():
        download_file(
            specification["url"],
            model_path(kind),
            specification["sha256"],
        )

    from huggingface_hub import snapshot_download

    ecapa_path().mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshot_download(
        repo_id=ECAPA_REPOSITORY,
        revision=ECAPA_REVISION,
        local_dir=str(ecapa_path()),
        allow_patterns=list(ECAPA_REQUIRED_FILES),
    )
    atomic_text(ecapa_marker_path(), ECAPA_REVISION + "\n")
    return verify_models()


def command_version(command: list[str], pattern: str) -> str | None:
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except FileNotFoundError:
        return None
    match = re.search(pattern, result.stdout)
    lines = result.stdout.strip().splitlines()
    return match.group(1) if match else (lines[-1] if lines else None)


def doctor() -> int:
    executables = {
        name: shutil.which(name)
        for name in ("curl", "ffmpeg", "ffprobe")
    }
    whisper = whisper_binary()
    executables["whisper-cli"] = (
        whisper if Path(whisper).is_file() else shutil.which(whisper)
    )
    imports = {}
    for name in ("numpy", "torch", "torchaudio", "speechbrain", "huggingface_hub"):
        try:
            __import__(name)
            imports[name] = True
        except Exception as error:
            imports[name] = f"{type(error).__name__}: {error}"
    models = verify_models(raise_on_error=False)
    whisper_cpp_version = (
        command_version(
            [whisper, "--version"],
            r"whisper\.cpp version:\s*([0-9.]+)",
        )
        if executables["whisper-cli"]
        else None
    )
    report = {
        "schema_version": SCHEMA_VERSION,
        "host": platform.node(),
        "machine": platform.machine(),
        "executables": executables,
        "versions": {
            "whisper_cpp": whisper_cpp_version,
            "ffmpeg": (
                command_version(["ffmpeg", "-version"], r"ffmpeg version\s+(\S+)")
                if executables["ffmpeg"]
                else None
            ),
        },
        "python_imports": imports,
        "models": models,
        "directories": {
            "state": str(state_directory()),
            "models": str(model_directory()),
            "profiles": str(profile_directory()),
            "outputs": str(output_directory()),
        },
    }
    report["ready"] = (
        all(executables.values())
        and all(value is True for value in imports.values())
        and models["valid"]
        and supported_whisper_version(whisper_cpp_version)
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ready"] else 1


def whisper_version() -> str:
    version = command_version(
        [whisper_binary(), "--version"],
        r"whisper\.cpp version:\s*([0-9.]+)",
    )
    if not version:
        raise RuntimeError("could not determine whisper.cpp version")
    if not supported_whisper_version(version):
        raise RuntimeError(f"whisper.cpp 1.9 or newer is required, found {version}")
    return version


def supported_whisper_version(version: str | None) -> bool:
    if not version:
        return False
    try:
        major_minor = tuple(int(part) for part in version.split(".")[:2])
    except ValueError:
        return False
    return major_minor >= (1, 9)


def runtime_identity(whisper_cpp_version: str, *, include_ecapa: bool) -> dict[str, Any]:
    ffmpeg = Path(shutil.which("ffmpeg") or "").resolve()
    ffprobe = Path(shutil.which("ffprobe") or "").resolve()
    configured_whisper = whisper_binary()
    binary = Path(
        configured_whisper
        if Path(configured_whisper).is_absolute()
        else (shutil.which(configured_whisper) or configured_whisper)
    ).resolve()
    for name, path in (
        ("ffmpeg", ffmpeg),
        ("ffprobe", ffprobe),
        ("whisper.cpp", binary),
    ):
        if not path.is_file():
            raise RuntimeError(f"{name} binary is missing: {path}")
    identity = {
        "pipeline_sha256": sha256_file(Path(__file__).resolve()),
        "python": platform.python_version(),
        "python_executable": str(Path(sys.executable).resolve()),
        "ffmpeg": command_version(["ffmpeg", "-version"], r"ffmpeg version\s+(\S+)"),
        "ffmpeg_binary": str(ffmpeg),
        "ffprobe_binary": str(ffprobe),
        "whisper_cpp": whisper_cpp_version,
        "whisper_binary": str(binary),
        "whisper_binary_sha256": sha256_file(binary),
    }
    if include_ecapa:
        import speechbrain
        import torch
        import torchaudio

        identity["speechbrain"] = package_version("speechbrain")
        identity["speechbrain_module"] = str(Path(speechbrain.__file__).resolve())
        identity["torch"] = package_version("torch")
        identity["torch_module"] = str(Path(torch.__file__).resolve())
        identity["torchaudio"] = package_version("torchaudio")
        identity["torchaudio_module"] = str(Path(torchaudio.__file__).resolve())
    return identity


def run_whisper(
    wav: Path,
    raw_directory: Path,
    unit_name: str,
    language: str,
) -> tuple[list[dict[str, Any]], list[str]]:
    raw_directory.mkdir(parents=True, exist_ok=True)
    output_prefix = raw_directory / unit_name
    stdout_path = raw_directory / f"{unit_name}.stdout.log"
    stderr_path = raw_directory / f"{unit_name}.stderr.log"
    command = [
        whisper_binary(),
        "--model",
        str(model_path("whisper")),
        "--language",
        language,
        "--max-context",
        "0",
        "--no-fallback",
        "--output-json-full",
        "--output-file",
        str(output_prefix),
        "--vad",
        "--vad-model",
        str(model_path("vad")),
        "--vad-threshold",
        "0.5",
        "--vad-min-speech-duration-ms",
        "250",
        "--vad-min-silence-duration-ms",
        "650",
        "--vad-max-speech-duration-s",
        "30",
        "--vad-speech-pad-ms",
        "250",
        str(wav),
    ]
    with stdout_path.open("w") as stdout, stderr_path.open("w") as stderr:
        run(command, stdout=stdout, stderr=stderr)
    json_path = Path(f"{output_prefix}.json")
    if not json_path.is_file():
        raise RuntimeError(f"whisper.cpp did not produce JSON: {json_path}")
    data = json.loads(json_path.read_text())
    segments = []
    for item in data.get("transcription", []):
        text = " ".join(item.get("text", "").split())
        if not text:
            continue
        offsets = item.get("offsets", {})
        start = float(offsets["from"]) / 1000
        end = float(offsets["to"]) / 1000
        probabilities = [
            float(token["p"])
            for token in item.get("tokens", [])
            if token.get("p") is not None
            and not str(token.get("text", "")).startswith("[_")
        ]
        segments.append(
            {
                "start": start,
                "end": end,
                "text": text,
                "mean_token_probability": (
                    sum(probabilities) / len(probabilities)
                    if probabilities
                    else None
                ),
            }
        )
    return segments, command


def load_wav(path: Path):
    import numpy
    import torch

    with wave.open(str(path), "rb") as audio:
        if (
            audio.getnchannels() != 1
            or audio.getframerate() != 16000
            or audio.getsampwidth() != 2
        ):
            raise RuntimeError(f"expected mono 16 kHz signed 16-bit WAV: {path}")
        samples = numpy.frombuffer(
            audio.readframes(audio.getnframes()),
            dtype=numpy.int16,
        ).copy()
    return torch.from_numpy(samples).float() / 32768.0


def load_ecapa():
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import FetchConfig, LocalStrategy

    return EncoderClassifier.from_hparams(
        source=str(ecapa_path()),
        savedir=str(ecapa_path()),
        run_opts={"device": "cpu"},
        overrides={"pretrained_path": str(ecapa_path())},
        local_strategy=LocalStrategy.NO_LINK,
        fetch_config=FetchConfig(allow_network=False),
    )


def embed_samples(model: Any, samples: Any, *, maximum_chunks: int | None = None):
    import torch
    import torch.nn.functional as functional

    chunk_size = 3 * 16000
    if len(samples) < 16000:
        raise RuntimeError("speaker embedding audio must be at least one second")
    starts = [
        start
        for start in range(0, len(samples), chunk_size)
        if len(samples) - start >= 16000
    ]
    if maximum_chunks is not None and maximum_chunks < 1:
        raise ValueError("maximum chunks must be at least one")
    if maximum_chunks and len(starts) > maximum_chunks:
        if maximum_chunks == 1:
            starts = [starts[len(starts) // 2]]
        else:
            step = (len(starts) - 1) / (maximum_chunks - 1)
            indexes = sorted(
                {round(index * step) for index in range(maximum_chunks)}
            )
            starts = [starts[index] for index in indexes]
    embeddings = []
    weights = []
    for start in starts:
        chunk = samples[start : start + chunk_size]
        if float(torch.sqrt(torch.mean(chunk * chunk))) < 0.005:
            continue
        with torch.no_grad():
            embedding = model.encode_batch(
                chunk.unsqueeze(0),
                wav_lens=torch.tensor([1.0]),
            ).squeeze()
        embeddings.append(functional.normalize(embedding, dim=0))
        weights.append(len(chunk) / 16000)
    if not embeddings:
        raise RuntimeError("audio has no enrollment-quality speech windows")
    stacked = torch.stack(embeddings)
    weight_tensor = torch.tensor(weights, dtype=stacked.dtype)
    centroid = (stacked * weight_tensor[:, None]).sum(0) / weight_tensor.sum()
    return (
        functional.normalize(centroid, dim=0),
        len(embeddings),
        sum(weights),
    )


def parse_profile_spec(specification: str) -> tuple[str | None, Path]:
    if "=" in specification:
        alias, value = specification.split("=", 1)
        return safe_identifier(alias), Path(value).expanduser().resolve()
    return None, Path(specification).expanduser().resolve()


def load_profiles(
    specifications: list[str],
    *,
    require_multiple: bool = True,
) -> dict[str, dict[str, Any]]:
    profiles = {}
    for specification in specifications:
        alias, path = parse_profile_spec(specification)
        data = json.loads(path.read_text())
        name = alias or data.get("name")
        if not name:
            raise RuntimeError(f"profile has no name: {path}")
        name = safe_identifier(name)
        if data.get("kind") != "speechbrain-ecapa-voxceleb-centroid":
            raise RuntimeError(f"unsupported profile kind: {path}")
        if (
            data.get("schema_version") == SCHEMA_VERSION
            and data.get("model_revision") == ECAPA_REVISION
            and data.get("embedding_dimension") == 192
        ):
            compatibility = "pinned"
        elif (
            data.get("schema_version") is None
            and data.get("model_revision") is None
            and data.get("files")
            and all(
                isinstance(item, dict) and item.get("embedding_dim") == 192
                for item in data["files"]
            )
        ):
            compatibility = "legacy-unpinned"
        else:
            raise RuntimeError(
                f"profile schema/model is incompatible with pinned ECAPA: {path}"
            )
        centroid = data.get("centroid")
        if not isinstance(centroid, list) or len(centroid) != 192:
            raise RuntimeError(f"profile centroid must contain 192 numbers: {path}")
        if not all(
            isinstance(value, (int, float)) and math.isfinite(value)
            for value in centroid
        ):
            raise RuntimeError(f"profile centroid contains non-finite values: {path}")
        norm = math.sqrt(sum(float(value) ** 2 for value in centroid))
        if abs(norm - 1.0) > 0.02:
            raise RuntimeError(f"profile centroid is not normalized: {path}")
        if name in profiles:
            raise RuntimeError(f"duplicate profile name: {name}")
        profile_sha256 = sha256_file(path)
        if any(
            profile["sha256"] == profile_sha256
            for profile in profiles.values()
        ):
            raise RuntimeError(f"profile file is listed more than once: {path}")
        profiles[name] = {
            "path": str(path),
            "sha256": profile_sha256,
            "centroid": [float(value) for value in centroid],
            "model_revision": data.get("model_revision"),
            "compatibility": compatibility,
        }
    if require_multiple and len(profiles) < 2:
        raise RuntimeError("mono speaker assignment requires at least two profiles")
    return profiles


def assign_speakers(
    wav: Path,
    segments: list[dict[str, Any]],
    profiles: dict[str, dict[str, Any]],
    margin_threshold: float,
    similarity_threshold: float,
    minimum_duration: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    import torch
    import torch.nn.functional as functional

    profile_vectors = {
        name: functional.normalize(
            torch.tensor(profile["centroid"], dtype=torch.float32),
            dim=0,
        )
        for name, profile in profiles.items()
    }
    audio = load_wav(wav)
    model = load_ecapa()
    assigned = []
    for segment in segments:
        start = max(0, round(segment["start"] * 16000))
        end = min(len(audio), round(segment["end"] * 16000))
        duration = (end - start) / 16000
        if duration < minimum_duration:
            assigned.append(
                {
                    **segment,
                    "speaker": None,
                    "speaker_candidate": None,
                    "speaker_margin": None,
                    "speaker_similarities": {},
                    "assignment_reason": "segment-too-short",
                }
            )
            continue
        embedding, _, _ = embed_samples(model, audio[start:end])
        similarities = {
            name: float(torch.dot(embedding, vector))
            for name, vector in profile_vectors.items()
        }
        ranked = sorted(similarities, key=similarities.get, reverse=True)
        candidate = ranked[0]
        margin = similarities[ranked[0]] - similarities[ranked[1]]
        speaker = candidate
        reason = "confirmed"
        if similarities[candidate] < similarity_threshold:
            speaker = None
            reason = "low-similarity"
        elif margin < margin_threshold:
            speaker = None
            reason = "low-margin"
        assigned.append(
            {
                **segment,
                "speaker": speaker,
                "speaker_candidate": candidate,
                "speaker_margin": margin,
                "speaker_similarities": similarities,
                "assignment_reason": reason,
            }
        )
    del model
    del audio
    return assigned, {
        name: {
            key: value
            for key, value in profile.items()
            if key != "centroid"
        }
        for name, profile in profiles.items()
    }


def parse_track_specs(
    specifications: list[str],
    probe: dict[str, Any],
) -> list[tuple[str, int]]:
    streams = {int(stream["index"]): stream for stream in probe.get("streams", [])}
    result = []
    names = set()
    indexes = set()
    for specification in specifications:
        if "=" not in specification:
            raise ValueError(f"track must use name=ffprobe-index syntax: {specification}")
        name, raw_index = specification.split("=", 1)
        name = safe_identifier(name)
        index = int(raw_index)
        if name in names:
            raise ValueError(f"duplicate track name: {name}")
        if index in indexes:
            raise ValueError(f"duplicate track index: {index}")
        stream = streams.get(index)
        if not stream or stream.get("codec_type") != "audio":
            raise ValueError(f"stream {index} is missing or is not audio")
        start_time = stream.get("start_time")
        if start_time not in (None, "N/A") and abs(float(start_time)) > 0.05:
            raise ValueError(
                f"stream {index} starts at {start_time}s; timeline alignment is unsupported"
            )
        names.add(name)
        indexes.add(index)
        result.append((name, index))
    if not result:
        raise ValueError("at least one track is required")
    return result


def segment_qc(
    segments: list[dict[str, Any]],
    duration: float,
    *,
    mode: str,
) -> dict[str, Any]:
    timestamp_ordered = all(
        left["start"] <= right["start"]
        for left, right in zip(segments, segments[1:])
    )
    ordered = sorted(segments, key=lambda item: (item["start"], item["end"]))
    out_of_bounds = [
        item
        for item in ordered
        if item["start"] < 0
        or item["end"] < item["start"]
        or item["end"] > duration + 0.5
    ]
    long_gaps = []
    for left, right in zip(ordered, ordered[1:]):
        gap = right["start"] - left["end"]
        if gap > 30:
            long_gaps.append(
                {
                    "start": left["end"],
                    "end": right["start"],
                    "seconds": gap,
                }
            )
    duplicates = []
    repeated_words = []
    for left, right in zip(ordered, ordered[1:]):
        left_text = normalize_text(left["text"])
        right_text = normalize_text(right["text"])
        if left_text and len(left_text) > 20 and left_text == right_text:
            duplicates.append({"left": left, "right": right})
    for item in ordered:
        words = normalize_text(item["text"]).split()
        if any(len(list(group)) >= 5 for _, group in itertools.groupby(words)):
            repeated_words.append(item)

    unknown = [item for item in ordered if item.get("speaker") is None]
    low_margin = [
        item
        for item in ordered
        if item.get("assignment_reason") == "low-margin"
    ]
    low_similarity = [
        item
        for item in ordered
        if item.get("assignment_reason") == "low-similarity"
    ]
    cross_track_duplicates = []
    if mode == "tracks":
        for left, right in itertools.combinations(ordered, 2):
            if left.get("speaker") == right.get("speaker"):
                continue
            if right["start"] > left["end"] + 1:
                continue
            text = normalize_text(left["text"])
            if text and len(text) > 20 and text == normalize_text(right["text"]):
                cross_track_duplicates.append({"left": left, "right": right})

    unknown_ratio = len(unknown) / len(ordered) if ordered else 1.0
    segment_seconds = sum(
        max(0.0, item["end"] - item["start"]) for item in ordered
    )
    unknown_seconds = sum(
        max(0.0, item["end"] - item["start"]) for item in unknown
    )
    unknown_duration_ratio = (
        unknown_seconds / segment_seconds if segment_seconds > 0 else 1.0
    )
    low_confidence = [
        item
        for item in ordered
        if item.get("mean_token_probability") is not None
        and item["mean_token_probability"] < 0.30
    ]
    missing_confidence = [
        item
        for item in ordered
        if item.get("mean_token_probability") is None
    ]
    low_confidence_seconds = sum(
        max(0.0, item["end"] - item["start"]) for item in low_confidence
    )
    missing_confidence_seconds = sum(
        max(0.0, item["end"] - item["start"]) for item in missing_confidence
    )
    low_confidence_duration_ratio = (
        low_confidence_seconds / segment_seconds if segment_seconds > 0 else 1.0
    )
    missing_confidence_duration_ratio = (
        missing_confidence_seconds / segment_seconds
        if segment_seconds > 0
        else 1.0
    )
    leading_gap = ordered[0]["start"] if ordered else duration
    trailing_gap = max(0.0, duration - ordered[-1]["end"]) if ordered else duration
    timeline_span_ratio = (
        (ordered[-1]["end"] - ordered[0]["start"]) / duration
        if ordered and duration > 0
        else 0.0
    )
    merged_ranges = []
    for item in ordered:
        if merged_ranges and item["start"] <= merged_ranges[-1][1]:
            merged_ranges[-1][1] = max(merged_ranges[-1][1], item["end"])
        else:
            merged_ranges.append([item["start"], item["end"]])
    detected_speech_seconds = sum(end - start for start, end in merged_ranges)
    detected_speech_ratio = (
        detected_speech_seconds / duration if duration > 0 else 0.0
    )
    edge_gap_limit = max(5.0, duration * 0.10)
    quality_risk = (
        not ordered
        or not timestamp_ordered
        or bool(out_of_bounds)
        or bool(long_gaps)
        or bool(duplicates)
        or bool(repeated_words)
        or bool(cross_track_duplicates)
        or unknown_ratio > 0.10
        or unknown_duration_ratio > 0.10
        or low_confidence_duration_ratio > 0.05
        or missing_confidence_duration_ratio > 0.10
        or leading_gap > edge_gap_limit
        or trailing_gap > edge_gap_limit
        or (duration >= 30 and timeline_span_ratio < 0.50)
        or (duration >= 10 and detected_speech_ratio < 0.02)
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "mode": mode,
        "source_duration_seconds": duration,
        "segments": len(ordered),
        "speakers": dict(
            Counter(item.get("speaker") or "unknown" for item in ordered)
        ),
        "timestamp_ordered": timestamp_ordered,
        "leading_gap_seconds": leading_gap,
        "trailing_gap_seconds": trailing_gap,
        "timeline_span_ratio": timeline_span_ratio,
        "detected_speech_seconds": detected_speech_seconds,
        "detected_speech_ratio": detected_speech_ratio,
        "out_of_bounds": out_of_bounds,
        "gaps_over_30_seconds": long_gaps,
        "consecutive_duplicate_segments": duplicates,
        "repeated_word_runs": repeated_words,
        "cross_track_duplicate_candidates": cross_track_duplicates,
        "unknown_segments": len(unknown),
        "unknown_ratio": unknown_ratio,
        "unknown_seconds": unknown_seconds,
        "unknown_duration_ratio": unknown_duration_ratio,
        "low_margin_segments": len(low_margin),
        "low_similarity_segments": len(low_similarity),
        "low_confidence_segments": len(low_confidence),
        "low_confidence_seconds": low_confidence_seconds,
        "low_confidence_duration_ratio": low_confidence_duration_ratio,
        "missing_confidence_segments": len(missing_confidence),
        "missing_confidence_seconds": missing_confidence_seconds,
        "missing_confidence_duration_ratio": missing_confidence_duration_ratio,
        "transcript_quality_risk": quality_risk,
        "status": "needs-review" if quality_risk else "automated-qc-clear",
    }


def render_transcript(
    recording_id: str,
    source: Path,
    segments: list[dict[str, Any]],
    qc: dict[str, Any],
    provenance: dict[str, Any],
) -> str:
    ordered = sorted(segments, key=lambda item: (item["start"], item["end"]))
    turns = []
    for item in ordered:
        speaker = item.get("speaker") or "unknown"
        if (
            turns
            and turns[-1]["speaker"] == speaker
            and item["start"] <= turns[-1]["end"] + 1.5
        ):
            turns[-1]["end"] = max(turns[-1]["end"], item["end"])
            turns[-1]["text"] += " " + item["text"]
        else:
            turns.append(
                {
                    "start": item["start"],
                    "end": item["end"],
                    "speaker": speaker,
                    "text": item["text"],
                }
            )
    lines = [
        f"# transcript — {recording_id}",
        "",
        f"- source: `{source}`",
        f"- mode: {qc['mode']}",
        f"- asr: whisper.cpp {provenance['whisper_cpp_version']} / large-v3-turbo",
        "- speaker handling: "
        + (
            "known isolated tracks"
            if qc["mode"] == "tracks"
            else "closed-set ECAPA segment identification; unknown is preserved"
        ),
        f"- qc: {qc['status']}",
        "",
        "## transcript",
        "",
    ]
    for turn in turns:
        lines.extend(
            [
                f"[{timestamp(turn['start'])}–{timestamp(turn['end'])}] "
                f"**{turn['speaker']}**: {turn['text']}",
                "",
            ]
        )
    return "\n".join(lines)


def artifact_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name != "complete.json"
    }


def verify_complete(root: Path) -> bool:
    completion_path = root / "complete.json"
    if not completion_path.is_file():
        return False
    completion = json.loads(completion_path.read_text())
    return completion.get("artifacts") == artifact_hashes(root)


def transcribe(args: argparse.Namespace) -> Path:
    verify_models()
    version = whisper_version()
    runtime = runtime_identity(version, include_ecapa=args.mode == "mono")
    source = args.source.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    probe = ffprobe(source)
    duration = source_duration(probe)
    identity = source_identity(source)
    recording_id = safe_identifier(
        args.recording_id
        or (
            source.parent.name
            if source.name.startswith("output.")
            else source.stem
        )
    )
    profiles = {}
    if args.mode == "mono":
        profiles = load_profiles(args.profile)
        mode_configuration = {
            "mode": "mono",
            "profiles": {
                name: {
                    "path": profile["path"],
                    "sha256": profile["sha256"],
                    "model_revision": profile["model_revision"],
                    "compatibility": profile["compatibility"],
                }
                for name, profile in profiles.items()
            },
            "margin_threshold": args.margin_threshold,
            "similarity_threshold": args.similarity_threshold,
            "minimum_speaker_duration": args.minimum_speaker_duration,
        }
    else:
        tracks = parse_track_specs(args.track, probe)
        mode_configuration = {"mode": "tracks", "tracks": tracks}
    fingerprint = sha256_text(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "source_path": str(source),
                "source_sha256": identity["sha256"],
                "whisper_sha256": MODEL_SPECS["whisper"]["sha256"],
                "vad_sha256": MODEL_SPECS["vad"]["sha256"],
                "ecapa_revision": (
                    ECAPA_REVISION if args.mode == "mono" else None
                ),
                "language": args.language,
                "runtime": runtime,
                **mode_configuration,
            },
            sort_keys=True,
        )
    )
    root = (args.output_root or output_directory()).expanduser().resolve()
    parent = root / recording_id
    final = parent / fingerprint
    if final.exists():
        if verify_complete(final):
            print(final)
            return final
        raise RuntimeError(f"incomplete run occupies fingerprint path: {final}")
    parent.mkdir(parents=True, exist_ok=True)
    staging = parent / f".{fingerprint}.{os.getpid()}.tmp"
    if staging.exists():
        raise RuntimeError(f"staging path already exists: {staging}")
    staging.mkdir(mode=0o700)
    raw_directory = staging / "raw-asr"
    work_directory = staging / "work"
    work_directory.mkdir()

    provenance = {
        "schema_version": SCHEMA_VERSION,
        "recording_id": recording_id,
        "fingerprint": fingerprint,
        "mode": args.mode,
        "source": identity,
        "source_duration_seconds": duration,
        "language": args.language,
        "whisper_cpp_version": version,
        "runtime": runtime,
        "models": verify_models(),
        "configuration": mode_configuration,
        "commands": [],
    }
    atomic_json(staging / "run.json", provenance)

    raw_segments = []
    if args.mode == "tracks":
        for name, index in tracks:
            wav = work_directory / f"{name}.wav"
            convert_audio(source, wav, index)
            segments, command = run_whisper(
                wav,
                raw_directory,
                name,
                args.language,
            )
            provenance["commands"].append(command)
            raw_segments.extend(
                {
                    **segment,
                    "speaker": name,
                    "speaker_candidate": name,
                    "speaker_margin": None,
                    "speaker_similarities": {},
                    "assignment_reason": "known-track",
                    "unit": name,
                    "stream_index": index,
                }
                for segment in segments
            )
        segments = sorted(
            raw_segments,
            key=lambda item: (item["start"], item["end"], item["speaker"]),
        )
        profile_provenance = {}
    else:
        wav = work_directory / "mono.wav"
        convert_audio(source, wav, None)
        raw_segments, command = run_whisper(
            wav,
            raw_directory,
            "mono",
            args.language,
        )
        provenance["commands"].append(command)
        segments, profile_provenance = assign_speakers(
            wav,
            raw_segments,
            profiles,
            args.margin_threshold,
            args.similarity_threshold,
            args.minimum_speaker_duration,
        )

    if not segments:
        raise RuntimeError(f"transcription produced no segments: {source}")
    assert_source_unchanged(source, identity)
    provenance["profiles"] = profile_provenance
    atomic_json(staging / "run.json", provenance)
    atomic_json(staging / "segments.raw.json", raw_segments)
    atomic_json(staging / "segments.json", segments)
    qc = segment_qc(segments, duration, mode=args.mode)
    legacy_profiles = [
        name
        for name, profile in profiles.items()
        if profile["compatibility"] != "pinned"
    ]
    qc["legacy_profile_risk"] = legacy_profiles
    if legacy_profiles:
        qc["transcript_quality_risk"] = True
        qc["status"] = "needs-review"
    atomic_json(staging / "qc.json", qc)
    atomic_text(
        staging / "transcript.md",
        render_transcript(
            recording_id,
            source,
            segments,
            qc,
            provenance,
        ),
    )
    shutil.rmtree(work_directory)
    completion = {
        "schema_version": SCHEMA_VERSION,
        "recording_id": recording_id,
        "fingerprint": fingerprint,
        "source_sha256": identity["sha256"],
        "qc_status": qc["status"],
        "artifacts": artifact_hashes(staging),
    }
    atomic_json(staging / "complete.json", completion)
    os.replace(staging, final)
    print(final)
    return final


def enroll_profile(args: argparse.Namespace) -> Path:
    verify_models()
    name = safe_identifier(args.name)
    destination = (
        args.output.expanduser().resolve()
        if args.output
        else profile_directory() / f"{name}.ecapa.json"
    )
    sources_resolved = [source.expanduser().resolve() for source in args.audio]
    if destination in sources_resolved:
        raise RuntimeError("profile output must not replace enrollment audio")
    if destination.exists() and not args.force:
        raise RuntimeError(
            f"profile already exists; pass --force to replace it: {destination}"
        )
    model = load_ecapa()
    embeddings = []
    embedding_weights = []
    sources = []
    with tempfile.TemporaryDirectory(
        prefix="darwin-transcription-enroll-",
        dir=state_directory(),
    ) as temporary:
        temporary_root = Path(temporary)
        for index, source in enumerate(sources_resolved):
            if not source.is_file():
                raise FileNotFoundError(source)
            wav = temporary_root / f"{index}.wav"
            convert_audio(source, wav, None)
            audio = load_wav(wav)
            embedding, chunks, accepted_seconds = embed_samples(
                model,
                audio,
                maximum_chunks=args.maximum_chunks,
            )
            embeddings.append(embedding)
            embedding_weights.append(accepted_seconds)
            sources.append(
                {
                    "path": str(source),
                    "sha256": sha256_file(source),
                    "duration_seconds": len(audio) / 16000,
                    "embedding_windows": chunks,
                    "accepted_speech_seconds": accepted_seconds,
                }
            )

    import torch
    import torch.nn.functional as functional

    stacked = torch.stack(embeddings)
    weights = torch.tensor(embedding_weights, dtype=stacked.dtype)
    centroid = functional.normalize(
        (stacked * weights[:, None]).sum(0) / weights.sum(),
        dim=0,
    )
    profile = {
        "schema_version": SCHEMA_VERSION,
        "name": name,
        "kind": "speechbrain-ecapa-voxceleb-centroid",
        "model_repository": ECAPA_REPOSITORY,
        "model_revision": ECAPA_REVISION,
        "embedding_dimension": len(centroid),
        "language": args.language,
        "source_note": args.source_note,
        "sources": sources,
        "centroid": centroid.tolist(),
    }
    atomic_json(destination, profile)
    print(destination)
    return destination


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="darwin-transcription")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("doctor")

    models = commands.add_parser("models")
    model_commands = models.add_subparsers(dest="model_command", required=True)
    model_commands.add_parser("fetch")
    model_commands.add_parser("verify")

    profile = commands.add_parser("profile")
    profile_commands = profile.add_subparsers(
        dest="profile_command",
        required=True,
    )
    enroll = profile_commands.add_parser("enroll")
    enroll.add_argument("name")
    enroll.add_argument("audio", nargs="+", type=Path)
    enroll.add_argument("--output", type=Path)
    enroll.add_argument("--language", default="unknown")
    enroll.add_argument("--source-note", default="")
    enroll.add_argument("--maximum-chunks", type=positive_integer, default=100)
    enroll.add_argument("--force", action="store_true")

    transcription = commands.add_parser("transcribe")
    transcription_modes = transcription.add_subparsers(
        dest="mode",
        required=True,
    )
    mono = transcription_modes.add_parser("mono")
    mono.add_argument("source", type=Path)
    mono.add_argument(
        "--profile",
        action="append",
        default=default_profile_specs(),
        help="alias=profile.json; may be repeated",
    )
    mono.add_argument("--margin-threshold", type=float, default=0.08)
    mono.add_argument("--similarity-threshold", type=float, default=0.25)
    mono.add_argument(
        "--minimum-speaker-duration",
        type=float_at_least_one,
        default=1.0,
    )
    tracks = transcription_modes.add_parser("tracks")
    tracks.add_argument("source", type=Path)
    tracks.add_argument("--track", action="append", required=True)
    for mode in (mono, tracks):
        mode.add_argument("--language", default="auto")
        mode.add_argument("--recording-id")
        mode.add_argument("--output-root", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    state_directory().mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.command == "doctor":
        return doctor()
    if args.command == "models":
        result = (
            fetch_models()
            if args.model_command == "fetch"
            else verify_models(raise_on_error=False)
        )
        print(json.dumps(result, indent=2))
        return 0 if result["valid"] else 1
    if args.command == "profile":
        enroll_profile(args)
        return 0
    if args.command == "transcribe":
        transcribe(args)
        return 0
    parser.error("unhandled command")
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
