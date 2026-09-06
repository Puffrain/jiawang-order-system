# Deployment: UI and login repair

- Date: 2026-09-06. Resource level: heavy.
- Approval: user accepted UI and explicitly requested deployment.
- Source commit: 57f490e7408f535bcfa5ccef12f5444f15ae5548, pushed and remote-verified on release/v1.5.0-mini-courier.
- Independent review: separate codex review process, no actionable findings; see independent-review-57f490e.md.
- Source archive SHA-256: ade40f584e34cf26f59a24c429bc63f8c1b9ef1c6d61a3e42801712814c3714a.
- Candidate source retained at /opt/jiawang-candidates/ui-login-57f490e. Existing production source directory remains older: do not rebuild from /opt/jiawang-commerce-new without reconciling source with this commit. Runtime compose files pin the new image.
- Image: sha256:e7e149a3463f4bcd39ced00740a9a6c9fb72951c920a58491e55e5761a101b8d, tag jiawang-commerce-order:ui-login-57f490e.
- Build: derived from existing mini-bearer image (dependencies unchanged), updated app/components/lib/proxy and runtime tests; both OTP and bind-phone runtime tests and Webpack production build PASS on server.
- Recovery point: /root/jiawang-backups/20260906-151734-ui-login-57f490e. Two databases, media, source and configs backed up with checksums verified.
- Isolated preview: fresh named data volume, loopback port 3197; health/home/buyer login/admin login 200, unauthenticated products 401, invalid pre-session bind request 400. First readiness probe reset connection; logs showed ready and a controlled restart/probe succeeded. Preview container stopped; volume retained.
- Cutover: only order-web and order-media-worker recreated; warehouse services and gateway IDs unchanged. Both order containers running with zero restarts.
- Finalization: FINALIZE_PASS RELEASE_ID=ui-login-57f490e APPROVAL_REFERENCE=user-20260906-ui-approved.
- Data: both quickCheck=ok; 23 order products / 22 active; 50 images present, zero missing; media pending/failed zero; warehouse published products 22, assets 50, sync pending/dead zero.
- Public verification: health and buyer login 200; invalid bind request 400, confirming it reaches endpoint validation rather than pre-session 401.
- Limitations: actual wx.login plus real SMS binding requires the user's device; not claimed verified. Full eight-width browser flow acceptance NOT RUN; user approved local UI. No new mini-program upload or payment/refund acceptance in this release.
- Backup/finalize shell scripts in candidate directory needed CRLF normalization. Production credentials and data were not changed or committed.
