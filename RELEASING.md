# Releasing

Releases are built only from version tags on `master`. The release workflow
runs the full quality gate, publishes a multi-architecture image to GHCR, and
creates a GitHub release containing an installable npm tarball, an SPDX SBOM,
and SHA-256 checksums.

Both the tarball and container receive GitHub artifact provenance attestations.
The container also embeds max-level BuildKit provenance and an SBOM attestation.
The workflow uses only the short-lived `GITHUB_TOKEN`; no package-registry token
or signing key is stored in the repository. Repository-level immutable releases
are enabled, so a published release, its assets, and its tag cannot be changed
or deleted.

## Prepare a release

1. Update `version` in `package.json`; the CLI reads it directly from the package
   metadata.
2. Merge the version change into `master` after CI, CodeQL, and dependency
   review pass.
3. Create and push a signed tag from that exact `master` commit:

   ```bash
   git switch master
   git pull --ff-only
   git tag -s v0.3.1 -m "v0.3.1"
   git push origin v0.3.1
   ```

The workflow rejects a tag whose name differs from the package version or whose
commit is not contained in `master`. A GitHub release is created only after the
package and container jobs succeed.

## Verify a release

Download and verify the tarball:

```bash
gh release download v0.3.1 --repo rootlyhq/rootly-datadog-notification-migrator
sha256sum --check SHA256SUMS
gh attestation verify rootly-datadog-notification-migrator-0.3.1.tgz \
  --repo rootlyhq/rootly-datadog-notification-migrator
```

Verify the container provenance:

```bash
gh attestation verify \
  oci://ghcr.io/rootlyhq/rootly-datadog-notification-migrator:0.3.1 \
  --repo rootlyhq/rootly-datadog-notification-migrator
```

The npm registry is intentionally not part of this workflow. npm trusted
publishing currently requires a GitHub-hosted runner, which conflicts with this
repository's requirement that every job run on Blacksmith. The attested npm
tarball remains installable directly from each GitHub release without a
long-lived npm token.
