---
name: environment-audit
description: Audit a reconstructed agent environment against its source specification, or describe experiment perturbations without conflating implementation details with meaningful changes.
---

# Environment audit

Use this when asked whether a local environment matches a paper, benchmark, or reference implementation, or when documenting a perturbation to such an environment.

Establish three separate objects: the chosen reference condition, the local environment as **executed**, and any intentional perturbation. Read the actual run artifacts, not only its design document. A planned feature that did not run is not part of the executed environment.

For each potentially consequential choice, trace the source specification to the implemented behavior and the target's possible observations. Prioritize the agent's prompt and role, live versus scripted peers, available tools and their actual reactions, data and cache provenance, feedback and evaluator behavior, timing and state visibility, and outcome measurement. Report a difference when it changes what the agent can know, do, receive as feedback, or learn from another agent. Ordinary choices needed to implement a vague description are not automatically deviations. Do not recite source-specified tools or count selection of a source-defined scenario as an assumption.

Classify each finding precisely:

- **Verified match:** exact source and implementation checked.
- **Verified difference:** source specifies one behavior; the executed environment did another.
- **Material reconstruction:** source leaves a consequential behavior open; the local choice could affect results.
- **Unverified match:** exact source may exist but cannot currently be checked. State the concrete attempts and result, such as a linked repository returning 404. Do not write only “not verified” or “I have not checked.” If no attempt was made, say so and attempt verification before completing the audit.
- **Intentional perturbation:** a deliberate change from the established base made to test a hypothesis. Name the baseline behavior, changed behavior, agent-visible path, intended causal effect, and any control. Do not call every fidelity gap a perturbation.
- **Missing analysis:** absent controls or graders that limit interpretation but did not change the agent-visible environment. Keep this separate from environment differences.

Seek the strongest available source: exact released evaluation code and prompts, then the paper or benchmark specification, then upstream code when the exact source is unavailable. An upstream template is evidence about the upstream project, not proof of the adapted environment's exact prompt. Verify links and availability instead of accepting a document's claim that code is inaccessible. When a source cannot be reached, say what was tried and which comparison remains impossible. Never silently replace an unavailable exact source with a related one.

Describe only findings relevant to the user's question. For a full audit, give a concise source-versus-executed ledger with evidence links and practical consequence; group routine wire-format choices. For a perturbation, distinguish the intended delta from accidental implementation differences and from uncertainty in the reference. Avoid causal or paper-comparable outcome claims without appropriate matched controls and scoring.
