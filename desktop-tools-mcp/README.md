# desktop-tools-mcp

Local file and PowerShell tools for the AMC WebUI desktop build, exposed over
the Model Context Protocol (stdio).

The Electron shell launches this server and passes it the workspace folders the
user allowed. Everything inside those folders can be read and written; nothing
outside them can, even through `..` or a symlink.

## Tools

| Tool | Approval | What it does |
| --- | --- | --- |
| `list_dir` | automatic | List a directory, optionally recursing 2–4 levels |
| `read_file` | automatic | Read a UTF-8 text file, or a line range |
| `search_files` | automatic | Substring search, returns `path:line: text` |
| `write_file` | asks | Create or overwrite a file |
| `replace_in_file` | asks | Exact-string replace, unique match required |
| `run_powershell` | asks | Run a PowerShell script, returns stdout/stderr/exit code |

Reads run without a prompt because they cannot change anything. Anything that
writes to disk or runs a shell goes through the approval dialog defined in
`src/features/mcp/toolApproval.ts`. Approving a tool for the session stops
further prompts until the app restarts.

## Running it directly

```bash
node server.mjs "C:\work" "C:\Users\me\Documents"
```

Each argument is an allowed root. A root that does not exist is dropped, and if
none remain the server exits — it never falls back to the whole filesystem.

## Safety model

- **Roots are chosen by the host application, not the model.** The app decides
  them from `--workspace` at launch (default: the user's Documents folder).
- **Containment is checked twice**: once on the literal path and once after
  resolving symlinks, so a link pointing outside the workspace is rejected.
- **PowerShell runs with `-NoProfile -NonInteractive`**, so a user profile cannot
  change behaviour and a prompt cannot hang the call.
- **Timeouts kill the process tree.** On Windows `taskkill /t /f` is used because
  killing `powershell.exe` alone would leave the grandchildren running.
- **Output is capped** at 60k characters per stream; the model is told when it
  was cut instead of silently losing data.

## Why it is not available on the web build

The web build runs in Docker on a server that has none of the user's files, so
exposing these tools there would be misleading and dangerous — `run_powershell`
would execute on the host. The desktop shell injects a `desktopTools` block into
`runtime-config.js`; without it, `initDesktopToolsMcpServer()` does nothing.

## Tests

```bash
npx vitest run desktop-tools-mcp
```

Covers path traversal, symlink escape, binary-file rejection, ambiguous
replacement, and the `node_modules` skip in search.
