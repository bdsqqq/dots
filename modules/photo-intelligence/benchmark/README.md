# semantic search benchmark

this is a private, reproducible gate for choosing an image-text embedding model. it is deliberately separate from the production photo-intelligence closure.

the suite samples every represented year, fills the remaining slots deterministically, and always retains assets named by judgments. results contain private archive paths and must be written to a `0700` directory; result and suite files are `0600`.

```bash
state="$HOME/Library/Application Support/photo-intelligence"
install -d -m 700 "$state/benchmarks"
install -m 600 modules/photo-intelligence/benchmark/queries.example.json \
  "$state/benchmarks/queries.json"

nix run .#photo-semantic-benchmark -- prepare \
  --catalog "$state/catalog.sqlite" \
  --queries "$state/benchmarks/queries.json" \
  --output "$state/benchmarks/semantic-v1.json"

nix run .#photo-semantic-benchmark -- run \
  --catalog "$state/catalog.sqlite" \
  --source /Volumes/ssd-01/igor/photos-library-2 \
  --suite "$state/benchmarks/semantic-v1.json" \
  --model openai/clip-vit-base-patch32 \
  --output "$state/benchmarks/clip.json"
```

the first run resolves `main` to its immutable Hugging Face revision and records it. reuse that 40-character revision explicitly for later runs. every report also records a digest of the complete suite. model execution defaults to MPS and rejects implicit CPU fallback.

the example queries are only a smoke test. for model selection, write 20–30 real queries before looking at results. run the same fixed 600–1,000-asset suite against no more than three candidates, then create a model-blind pool:

```bash
nix run .#photo-semantic-benchmark -- pool \
  --reports "$state/benchmarks"/candidate-*.json \
  --output "$state/benchmarks/judgment-pool.json"
```

judge every query against that pooled set, add at least one relevant asset ID per query to a copy of the private suite, and rerun every candidate with `--selection`. selection mode rejects undersized, partially judged, or out-of-corpus suites. compare only reports with the same `suiteDigest`; this avoids favoring whichever model happened to produce the first results you inspected.

Pillow plus `pillow-heif` currently covers JPEG, PNG, WebP, TIFF, and HEIF-family images. unsupported or damaged formats are item-level failures in the report rather than silent omissions.
