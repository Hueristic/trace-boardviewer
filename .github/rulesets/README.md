# Repository rulesets (import files)

GitHub keeps rulesets in the repository settings, not in the repository, so these two files change nothing by themselves.
They are the exact settings the project wants, ready to import: Settings, Rules, Rulesets, New ruleset, Import a ruleset.

- `protect-main.json`: nothing reaches the default branch except through a pull request; the branch cannot be deleted or
  force-pushed; review threads must be resolved. Nobody bypasses it, including the owner.
- `protect-release-tags.json`: tags `v*` cannot be created, moved or deleted except by a repository admin (the owner).
  CI cannot rewrite a release tag, and no other contributor can create one that starts the release workflow.

The release workflow creates a DRAFT release (`gh release create --draft`) when a `v*` tag is pushed. For a stable tag
(`vMAJOR.MINOR.PATCH`) the workflow then publishes it automatically, as `github-actions[bot]`, but only when every job is green
(Windows, portable isolation, macOS and Linux) and every uploaded asset matches its `.sha256` file after the upload. Any failure
leaves the draft for manual review; a partial release is never published. A pre-release tag (with a suffix such as `-rc.1`) always
stays a draft. The update check inside the app asks GitHub for the latest PUBLISHED release, so a draft is invisible to every user
until it is published.

Rulesets on a private repository need a paid GitHub plan; on a public repository they are free. If GitHub refuses to
enforce them while the repository is private, import them when it is made public.
