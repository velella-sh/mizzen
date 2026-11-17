# API contract check fixture

A minimal site for the API contract check. `docs/widgets.md` connects a function parameter and an
interface member to `src/widget.ts`; both claims are clean today. `test/api-contract-check.test.ts`
runs the drift comparison on this fixture and on a changed claim, so the checked contract has a
baseline before the rest of the epic builds on it.

The fixture is read-only like every other fixture. A new case gets a new page or source file here,
not an edit to this one.
