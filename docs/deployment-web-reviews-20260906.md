# Web Reviews Deployment 2026-09-06

- Owner approved GitHub upload and server deployment; mini program explicitly deferred.
- GitHub branch: release/v1.5.0-mini-courier.
- Source commit: 5e52b6a9855f7c1ee0035e24b91ba4d9bf32e077 (remote verified).
- Source archive SHA-256: fb7e9de907b61cbb4f6d93c0879b3250c718e8250e32c9dea0d9efecf0913de0.
- Candidate source: /opt/jiawang-candidates/web-reviews-5e52b6a. Application source in /opt/jiawang-commerce-new is older: do not rebuild from that directory without reconciling the release source.
- Image: sha256:15617d7918ff2202909ee0468f949204ac4f1255c821684cce000239c058c11e.
- Recovery backup: /root/jiawang-backups/20260905-235353-web-reviews-5e52b6a. Both databases, media, source, and configuration SHA-256 checks passed.
- Only order-web and order-media-worker were recreated. Warehouse web/worker and gateway were not recreated.
- compose.yaml, compose.images.yaml, compose.server.yaml and compose.release.yaml now pin the order image. Original backup images.before.txt records pre-release order image; later runtime-images-web-reviews.json was captured after the initial cutover, not before it.
- Initial health request returned 502 during startup; subsequent internal and public health checks returned 200. Admin login public HTTP 200.
- FINALIZE_PASS: both databases quick_check=ok; products=23, active=22; images=50, missing=0; media pending/failed=0; warehouse published products=22/assets=50; sync pending/dead=0; four core service log checks passed.
- Build completed successfully on server. SSH wrapper returned exit 1 due to shell exit-variable quoting after successful Docker build; image existence and actual running deployment independently verified.
- Secret scan passed after excluding the ignored .next-review-verify build output; its task-package path had matched the key regex.
- Mini program source changes and local developer configuration remain uncommitted. No mini program upload.
- Remaining acceptance: authenticated production review submission/moderation and visual checks, independent review, actual WeChat login/payment testing. Deployment health does not establish complete business acceptance.
- Old images, backup directories and candidate source retained. No cleanup performed.
