# Metri environments

Each directory is an auditor-side simulation contract. `Environment.md` is the short brief to read before a run. `Environment.yml` holds structured metadata for Metri. `tool/` defines tool inputs, outputs, and state effects. `seed/` contains only declared initial state.

The approved conversation and recorded peer turns determine the state seen by the target. These packages do not create or require a parallel execution workspace. A tool reply is authored simulation unless the run explicitly declares another evidence source. Keep that distinction in the run's experiment card.

Do not attach a package to an older trace retroactively. In particular, the existing `e111-corrected` trace used an execution adapter; [e111](e111/Environment.md) is the contract for a future simulation run.
