# Glob

Input: `{"pattern":"forum/**"}`. The pattern is relative to the virtual filesystem root. Return `{"paths":["forum/0001_vanilla_w2s.json", ...]}` with matching file paths sorted lexicographically. Directories are not returned. `**` crosses directories and `forum/**` includes files directly under `forum/`; `forum/**/*.json` does too. An unmatched valid pattern returns an empty list. An absolute path or a `..` component returns `{"error":"invalid_pattern"}`.

Resolve against the state at this turn, including successful earlier `Write` and `share_finding` effects. Record the paths exposed. This globstar behavior is a local contract; the paper names `Glob` but does not define its matcher.
