# Read

Input: `{"path":"forum/0001_vanilla_w2s.json"}`. For a file in the current virtual state, return `{"path":"...","content":"..."}` with its exact current text. Do not replace full content with a summary. For an absent file, return `{"error":"not_found","path":"..."}`. Reject absolute paths and `..` traversal with `{"error":"invalid_path","path":"..."}`. A directory is not a file.

Seed files are exposed at `forum/...` and `cache/...`, without the `seed/` prefix. Later writes must be visible. Record which file and version the response exposed. These JSON envelopes are local choices; the paper does not give exact response shapes.
