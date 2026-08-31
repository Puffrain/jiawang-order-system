# Historical production scripts

Files in this directory are preserved only as audit evidence from the 2026-08-18 deployment. They contain obsolete image tags, backup paths and one-off container names.

Do not execute them. Current releases must use, in order:

1. `production-deploy-prepare.sh`
2. `production-deploy-backup.sh`
3. `production-deploy-cutover.sh`
4. `production-finalize.sh`

Each current release requires immutable image references, a verified backup and explicit owner approval.
