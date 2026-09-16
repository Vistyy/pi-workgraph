# Releasing Pi Workgraph

This repository-only guide owns the contributor release procedure. It is not part of the installed package.

## Prepare

1. Update the version in `package.json`.
2. Update both versioned installation examples in `README.md`.
3. Commit the release change and push it.

## Publish

Push the matching `v<version>` tag.

GitHub Actions verifies the tag, installs and packs with pnpm, and publishes the verified tarball through npm trusted publishing. The npm CLI is only the OIDC publication transport; pnpm owns installation and packing.
