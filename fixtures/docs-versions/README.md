# docs-versions fixture

Three documentation states for the lifecycle in `docs/docs-versions.md`: current docs, an old release, and the
default release. The versioned folders are what a snapshot copies, and each carries the navigation it shipped with.

| Folder | State | Pages |
| --- | --- | --- |
| `guide/` | current docs | `install.md` and `upgrade.md`, edited for the next release |
| `v1/` | old, from `_data/versions.yml` | `install.md`, `upgrade.md`, and `legacy.md`, which has no version 2 or current equivalent |
| `v2/` | default, from `_data/versions.yml` | `install.md`, `upgrade.md`, and `deploy.md`, which has no version 1 equivalent |

`_data/versions.yml` names the dispositions, `_data/navigation.yml` is the current navigation, and
`vN/_data/navigation.yml` is each release's navigation snapshot. The versioned navigation links already use the
versioned URLs a snapshot would produce.

The fixture is read-only, like every fixture. A task that needs a different shape adds a folder beside it.
