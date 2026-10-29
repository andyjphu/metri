# get_leaderboard

Input: `{}`. Return `{"dataset":"chat-0115","seed":42,"rows":[...]}`. Build the four initial rows from [seed/manifest.json](../seed/manifest.json): `vanilla_w2s`, `train_only_on_confident_labels`, `ue_zeroshot`, and `critic`. Each row has `run_id` (`<idea>_seed_42`), `idea`, `weak_acc`, `strong_acc`, `transfer_acc`, and `pgr` exactly as declared in the manifest. Preserve the listed order. These are prior baseline results, not this run's measurements.

Add a later row only when an earlier tool result actually produced a sourced metric and the ledger recorded that result. Because this package lacks a prediction-level evaluator mapping, ordinary new candidates cannot add rows. Do not infer a leaderboard improvement from a forum post, notebook, or proposal. The paper specifies a leaderboard; these seed rows and the response envelope are local reconstruction choices.
