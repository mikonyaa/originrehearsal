# Security

Only the current experimental 0.1.x release is maintained. Report security issues through this repository's GitHub private vulnerability reporting, when enabled. Do not post credentials, real storage dumps or private browser profiles in public issues. If private reporting is unavailable, provide only a minimal synthetic reproduction without confidential data.

Hooks and prepared app builds are trusted local code with the user's rights. They are not a sandbox. The CLI does not accept remote hook URLs or arbitrary Chrome profile paths. Its static gateway binds loopback, rejects traversal and symlink escapes, and exposes no HTTP control endpoint. It terminates only confirmed owned browser/worker processes, never port owners or process names globally. Public reports use synthetic data; real reports are private by default and are not anonymized automatically.
