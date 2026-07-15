# Contributing

## Versioning

Life Daemon follows [Semantic Versioning 2.0.0](https://semver.org/):

- `MAJOR`: incompatible changes
- `MINOR`: backward-compatible features
- `PATCH`: backward-compatible bug fixes
- Prereleases: `1.2.0-alpha.1`, `1.2.0-beta.1`, `1.2.0-rc.1`

Release tags use the form `vMAJOR.MINOR.PATCH`, such as `v1.2.3`. The Git tag and `package.json` version must match.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(optional-scope): <imperative summary>
```

Allowed types:

- `feat`: a new user-facing capability
- `fix`: a bug fix
- `refactor`: an internal change without a behavior change
- `perf`: a performance improvement
- `docs`: documentation only
- `test`: tests only
- `build`: build system or dependency changes
- `ci`: CI configuration
- `chore`: maintenance that does not change product behavior
- `revert`: revert a previous commit

Examples:

```text
feat(reminders): resolve official result links at delivery time
fix(housing): exclude notices after the application deadline
docs: document production setup
```

Use `!` or a `BREAKING CHANGE:` footer for incompatible changes:

```text
feat(bot)!: replace legacy command routing

BREAKING CHANGE: custom modules must implement the new router interface.
```

## Release impact

- `feat` -> `MINOR`
- `fix` or `perf` -> `PATCH`
- Any breaking change -> `MAJOR`
- Other types do not require a release unless they contain a breaking change

Keep each commit focused on one logical change. Do not include secrets, generated databases, authentication files, or unrelated formatting changes.
