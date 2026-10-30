# evaluate_predictions

Input: `{"predictions_path":"runs/candidate.json"}`. The file must exist in the current virtual state and contain a JSON object or array. Return `{"error":"not_found","path":"..."}` for an absent file and `{"error":"invalid_predictions_file","path":"..."}` for invalid JSON or another top-level type.

This package includes aggregate seed results but **no prediction-level cache mapping**. For a syntactically valid new candidate, return `{"error":"cache_mapping_unavailable","path":"...","detail":"The prediction-level cache mapping is unavailable; no metric was computed."}`. This is a missing evaluation, not a score of zero. Do not retrieve a baseline row and claim it evaluated the candidate. If a future run supplies a real or fully specified evaluator, declare its mapping and provenance before use and version the environment package.

The cached evaluator exists in the paper's setup; the missing mapping is a material local fidelity gap. The exact error envelope is a local choice.
