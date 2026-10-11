# Contributing

Use Node 24.21.0 and the committed lockfile. Follow README's explicit build/test commands. Test real cold-control and retained-profile good/bad paths; never weaken an expected application value to hide a failing migration, replace the lifecycle with JSON restore, skip failing tests, or bypass unsupported evidence.

Add focused tests for meaningful behavior changes. Browser expectations should come from an independent fixture specification, not the production evaluator. Use only owned isolated profiles and synthetic data; never attach ordinary Chrome profiles, production credentials or another run's resources. Keep report values escaped and read-only probes nonmutating. Describe the problem, resulting behavior and validation in contributions. Changing published code requires a new version and exact-commit release verification.
