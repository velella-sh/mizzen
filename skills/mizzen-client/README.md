# Mizzen client skill

Install the portable skill in a compatible agent so it registers a task, compiles a context pack,
edits with spans, verifies the proof, and hands off with evidence instead of guessing.

## Install

```bash
npx skills add velella-sh/mizzen --skill mizzen-client --yes
```

Update an existing installation:

```bash
npx skills update mizzen-client
```

## Verify an installed copy

The manifest (`skill.json`) records the skill version, the client contract versions it teaches, and
a SHA-256 over every listed file (each file name, a NUL, then its bytes, in manifest order). A client
that installs the package should check that checksum before reading the instructions; the engine's
`readSkillPackage` does it.

The skill hardcodes no project name, folder, credential, or pre-approved tool. It reads the live
capability report from the server's `initialize` answer and uses the fallbacks that report names.
