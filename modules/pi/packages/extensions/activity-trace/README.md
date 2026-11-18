# activity traces

`pi.activity-span.v1` custom entries explain elapsed time without duplicating native messages or entering model context. execution parents are span IDs, not JSONL `parentId`; sibling durations overlap and must not be summed. child sessions are links, never an invented cross-process span tree.

generation timing includes turn setup through normalized assistant completion. first output means normalized text/thinking, not provider first-token latency. provider attempts/headers, nested model requests, retry-delay reasons, and background warming remain unobserved: current hooks cannot correlate them safely. UI waits expose only the SDK's combined window.

completed operations only: abrupt exit can lose open spans. each activity allows 2,048 spans and 128 active spans, with dropped counts on its root; failed journal appends do not fail inference. native parent-chain protection lives in the managed SDK patch, so extension reload alone cannot supply it. no raw payloads, errors, prompt titles, or filesystem paths are copied.
