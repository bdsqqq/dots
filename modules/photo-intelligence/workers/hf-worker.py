#!/usr/bin/env python3

import argparse
import base64
import json
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image
from pillow_heif import register_heif_opener
from transformers import AutoModel, AutoProcessor


PROTOCOL_VERSION = 1


def parse_args():
    parser = argparse.ArgumentParser(description="Private image-text embedding worker")
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision")
    parser.add_argument("--device", choices=["mps", "cpu"], default="mps")
    parser.add_argument("--offline", action="store_true")
    return parser.parse_args()


def pooled(output):
    if torch.is_tensor(output):
        return output
    if getattr(output, "pooler_output", None) is not None:
        return output.pooler_output
    raise TypeError(f"unsupported feature output: {type(output).__name__}")


def encoded_vector(vector):
    value = np.asarray(vector, dtype="<f4")
    return {
        "encoding": "f32le-base64",
        "dimensions": int(value.shape[0]),
        "data": base64.b64encode(value.tobytes()).decode("ascii"),
    }


class Encoder:
    def __init__(self, args):
        if args.device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS is unavailable in this PyTorch build")
        if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1":
            raise RuntimeError("CPU fallback must be disabled for comparable benchmarks")

        self.device = torch.device(args.device)
        load_options = {
            "local_files_only": args.offline,
            "trust_remote_code": False,
        }
        if args.revision:
            load_options["revision"] = args.revision
        self.processor = AutoProcessor.from_pretrained(args.model, **load_options)
        self.model = AutoModel.from_pretrained(args.model, **load_options).eval().to(self.device)
        for method in ("get_image_features", "get_text_features"):
            if not hasattr(self.model, method):
                raise TypeError(f"{type(self.model).__name__} lacks {method}")
        self.descriptor = {
            "protocol": PROTOCOL_VERSION,
            "model": args.model,
            "revision": args.revision,
            "device": args.device,
            "torch": torch.__version__,
            "mpsBuilt": torch.backends.mps.is_built(),
            "mpsAvailable": torch.backends.mps.is_available(),
            "cpuFallback": False,
            "dtype": "float32",
            "normalized": True,
        }

    def move(self, batch):
        return {
            key: value.to(self.device) if torch.is_tensor(value) else value
            for key, value in batch.items()
        }

    @staticmethod
    def embeddings(output):
        return F.normalize(pooled(output).float(), dim=-1).cpu().numpy()

    @torch.inference_mode()
    def encode_images(self, images):
        batch = self.move(self.processor(images=images, return_tensors="pt"))
        output = self.model.get_image_features(**batch)
        if self.device.type == "mps":
            torch.mps.synchronize()
        return self.embeddings(output)

    @torch.inference_mode()
    def encode_texts(self, texts):
        batch = self.move(self.processor(
            text=texts,
            padding="max_length",
            truncation=True,
            return_tensors="pt",
        ))
        output = self.model.get_text_features(**batch)
        if self.device.type == "mps":
            torch.mps.synchronize()
        return self.embeddings(output)


def open_image(path):
    with Image.open(Path(path)) as image:
        image.load()
        return image.convert("RGB")


def response(request_id, **value):
    print(json.dumps({"protocol": PROTOCOL_VERSION, "id": request_id, **value}), flush=True)


def main():
    args = parse_args()
    register_heif_opener()
    encoder = Encoder(args)

    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("id")
        try:
            if request.get("protocol") != PROTOCOL_VERSION:
                raise ValueError("unsupported protocol version")
            operation = request.get("op")
            if operation == "describe":
                response(request_id, ok=True, descriptor=encoder.descriptor)
                continue
            if operation == "embed_text":
                items = request.get("items", [])
                vectors = encoder.encode_texts([item["text"] for item in items])
                response(request_id, ok=True, items=[
                    {"token": item["token"], "vector": encoded_vector(vector)}
                    for item, vector in zip(items, vectors, strict=True)
                ])
                continue
            if operation == "embed_image":
                valid = []
                failures = []
                try:
                    for item in request.get("items", []):
                        try:
                            valid.append((item, open_image(item["path"])))
                        except Exception as error:
                            failures.append({"token": item.get("token"), "error": str(error)[:1000]})
                    vectors = encoder.encode_images([image for _, image in valid]) if valid else []
                finally:
                    for _, image in valid:
                        image.close()
                response(request_id, ok=True, items=[
                    {"token": item["token"], "vector": encoded_vector(vector)}
                    for (item, _), vector in zip(valid, vectors, strict=True)
                ], failures=failures)
                continue
            raise ValueError(f"unsupported operation: {operation}")
        except Exception as error:
            response(request_id, ok=False, error=str(error)[:2000])


if __name__ == "__main__":
    main()
