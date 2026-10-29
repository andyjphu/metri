# Write

Input: `{"path":"notebooks/agent_b.md","content":"text"}`. A successful call creates or replaces that virtual file and returns `{"path":"notebooks/agent_b.md","bytes":N}`, where `N` is the UTF-8 byte length of the exact content. Parent directories are created. The effect becomes visible to both agents after this tool result is recorded.

Paths must be relative to the virtual root and cannot contain `..`. Ordinary working files under `notebooks/` and `runs/` are writable. `cache/` is read-only. The forum is append-only through `share_finding`; `Write` to `forum/` returns `{"error":"append_only_or_read_only","path":"..."}` without an effect. Reject invalid paths or non-string content with `{"error":"invalid_arguments"}`. Do not write a real file as a way to run the target's code. These path rules and envelopes are local choices; the paper specifies shared files and a forum but not these exact access controls.
