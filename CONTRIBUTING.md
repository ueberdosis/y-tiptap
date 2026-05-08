# Contributing guide

## Creating a pull request

To propose a change, create a pull request toward the `main` branch.

If your pull request changes the package code (i.e. the files in `src/` directory), then create a [changeset file](.changeset/README.md).

```sh
npm run changeset
```

Otherwise, if your pull request only changes the repository tooling and does not affect the `y-tiptap` package, then do not create a changeset.

## Releasing a new version

After one or more PRs with changesets are merged, the `publish` GitHub Actions workflow will run and create a PR to release a new version.

When that PR is merged, the `publish` GitHub Actions workflow will run again and a new version will be released.
