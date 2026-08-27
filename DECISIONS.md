# Confirmed Decisions

## 2026-08-20 sync repair and replay boundaries

- Only the exact current warehouse revision may repair a damaged Outbox payload, and only while pending or dead.
- Delivered and superseded payloads are immutable and cannot be replayed through the protected current-version operation.
- Repair audit stores a classified reason plus old/new SHA-256 values, never damaged payload bytes.
- Media Worker tests use optional file-operation injection and a single-poll export; production defaults remain the real filesystem and long-running polling loop.

## Deployment approval gate

- Effective from 2026-08-16.
- Before every production deployment, prepare and show a local or isolated preview to the user.
- Do not change production until the user explicitly confirms that the preview is approved for deployment.
- A request to implement, inspect, or preview is not deployment approval.
- If the deployed result differs from the approved preview, stop further production changes, diagnose the mismatch, and present a corrected preview before redeploying.
