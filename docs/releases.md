# Releases

The two images built from this repo are published to GHCR when `main` is merged
into `prod`:

| Image | Built from |
|---|---|
| `ghcr.io/ju-li/automata-mcp-web` | `apps/web/Dockerfile` |
| `ghcr.io/ju-li/automata-mcp-telegram-bridge` | `apps/telegram-bridge/Dockerfile` |

Each release is tagged `X.Y.Z`, `X.Y`, `X`, `latest` and `sha-<commit>`, for
`linux/amd64`. **Point a service or a template at the major tag (`:1`), not
`:latest`.** The web service migrates its schema at boot and migrations only go
forward, so a major release reaching a deployment on its next restart is not
something to opt into by accident.

The version lives in one place — `"version"` in the root `package.json` — and is
always three-part. To cut a release:

1. Bump `"version"` on `main`, through an ordinary PR.
2. Open a PR from `main` into `prod`. The `release-check` workflow refuses it
   unless the version is `X.Y.Z`, is not already released and is above the
   latest release, and it builds both images to prove they still build.
3. Merge it with **Create a merge commit** — never squash, or `prod` stops being
   an ancestor of `main` and every later release PR shows old commits again.
   The `release` workflow then pushes both images and only after that creates
   the `vX.Y.Z` git tag and the GitHub Release, so a tag always means its images
   exist.

One-time setup on GitHub, which no workflow can do for you:

- Create the `prod` branch from `main`, and protect it: require a pull request
  and the `release-check` jobs (`version`, `build`).
- After the first release, open each package under the repository's
  **Packages** and set its visibility to **Public**. GHCR creates packages
  private, and Railway — or anyone deploying a template — cannot pull a private
  image without credentials.
