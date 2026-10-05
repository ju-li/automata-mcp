#!/usr/bin/env bash
# Reads the release version from the root package.json and refuses one that
# cannot be released: not X.Y.Z, already tagged, or not above the latest tag.
#
# Run by release-check.yml on every PR into prod, so a bad version cannot merge,
# and again by release.yml on the push, in case something reached prod without
# that PR. Prints the version and, under Actions, writes it to $GITHUB_OUTPUT.
set -euo pipefail

version=$(node -p "require('./package.json').version ?? ''")

fail() {
  echo "::error file=package.json::$1"
  exit 1
}

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "package.json \"version\" is \"$version\"; a release needs three-part X.Y.Z (e.g. 1.2.0)."
fi

# Tags straight from the remote: a shallow checkout carries none.
tags=$(git ls-remote --tags --refs origin 'v*' | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)

if grep -qx "v$version" <<<"$tags"; then
  fail "v$version is already released. Bump \"version\" in package.json on main."
fi

latest=$(sort -V <<<"$tags" | tail -n 1)
if [[ -n $latest ]] && [[ $(printf '%s\n%s\n' "$latest" "v$version" | sort -V | tail -n 1) != "v$version" ]]; then
  fail "v$version is not above the latest release, $latest. Bump \"version\" in package.json on main."
fi

echo "Release version: $version (latest released: ${latest:-none})"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "version=$version" >> "$GITHUB_OUTPUT"; fi
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then echo "Release version **v$version** (latest released: ${latest:-none})" >> "$GITHUB_STEP_SUMMARY"; fi
