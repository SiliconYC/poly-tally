# Native read-only Git helper and private input UI

This directory contains **code only**. Never place a PAT, private Git cache, runtime metadata or diagnostic output in this repository.

## Installation and scope

Review/copy these scripts to a private runtime location. Defaults use the OS account home (`pwd.getpwuid`), not `$HOME`, because Git runs with an isolated temporary HOME:

- Secret: `~/.local/share/poly-tally-private/github.pat`
- Nonsecret expiry/status metadata: same directory, `metadata.json`
- Git mirrors: `~/.cache/poly-tally/native-git/<repository>.git`
- Optional boolean/fixed-code diagnostics: `~/.local/state/poly-tally/helper-diagnostics.jsonl` (parent must already exist).

For an existing deployment, copy `paths.example.json` to the ignored `paths.local.json` beside both installed scripts and set absolute `patFile`, `cacheRoot`, and optionally `diagnostics`. This configuration contains paths only, never token contents. The configuration-file location is fixed: no CLI/environment arbitrary-secret-path input is accepted. Both GUI and helper use the same configured PAT path, so an existing secret does not need migration. Treat this configuration as trusted executable-level deployment configuration, keep it private, and do not commit it. Changes to this template do not replace an already running deployment; switch only after its active scan has finished. Before user input, an authorized operator must create a dedicated 0700 directory outside all repositories and synchronization folders and an **empty**, owned, 0600 regular secret file. The scripts do not create or recover a real PAT.

A Fine-grained PAT must be restricted server-side to GitHub read-only repository contents for the intended SiliconYC repositories. Only the GitHub HTTPS authentication flow may consume it. Publishing uses separate authorization.

## User input

Run `enter_pat_simple.py` with a Python providing GTK3/PyGObject (often `/usr/bin/python3`). It has two single-line entries: masked PAT, expiry, and one save-and-close button. Standard GTK right-click Paste/Ctrl+V is retained. Closing the window cancels. Never screenshot, inspect accessibility text, inspect the clipboard, or recover the token while the user enters it.

The file must still be empty at save time. The program uses `os.write` on that existing file, preserving its inode, rather than editor/GIO replacement files. It creates no secret backup, swap or temporary copy. Only the nonsecret metadata is separately written. Core dumps are disabled for this process.

A date-only `YYYY-MM-DD` sets a **conservative UTC 00:00 cutoff** on that date, potentially earlier than GitHub's actual expiry. Metadata records `datePrecision=day` and `conservativeCutoff=true`. A precise timezone-aware ISO timestamp is also supported. No extension or renewal is attempted.

## Native collection interface

```sh
python3 readonly_git.py ls-remote repository_name
python3 readonly_git.py fetch repository_name
```

- `ls-remote` prints JSON `{repository, defaultBranch, head}`.
- `fetch` prints the same JSON plus `path` to the bare mirror.
- Remote listing is **not filtered to HEAD**: a successful empty complete ref listing supports `head:null`. A nonempty listing without a valid default HEAD is rejected, not misreported as an empty repository.
- Fetch obtains the current default branch's complete history, never a shallow clone, and sets the local bare HEAD to that branch. It writes a nonsecret fetch receipt alongside the mirror.
- The collection engine decides which unchanged repositories to skip; this helper does not change statistical policies or reset history.

The credential helper accepts only HTTPS, exact `github.com`, owner `SiliconYC` and a valid repository path. Duplicate authorization fields are rejected; legitimate multi-valued Git `wwwauth[]`, `capability[]` and other unused extension fields do not cause false rejection. `store` and `erase` never persist credentials.

Git configuration and environment are isolated, hooks and redirects are disabled, mirror configuration outside a narrow allowlist is rejected. Existing platform proxy variables are passed through **without printing/persisting their values** so network routing remains available. Secrets never appear in URLs or command arguments.

## Security boundary

The wrapper exposes only `ls-remote` and `fetch`. An ordinary credential helper cannot itself prove whether a caller intends to read or push; GitHub's read-only PAT permissions remain essential. 0700/0600 and behavioral restrictions are not protection against root, the same UID deliberately retrieving credentials, platform snapshots or swap. No permanent persistence guarantee is made.

Never invoke the real helper directly, capture its credential output, run `git credential fill` against a real PAT, read the PAT file, or inspect process memory. The fake-only test below is not permission to repeat those operations with a real credential.

Diagnostics contain booleans, fixed error codes and exception class names only; not credential-protocol values, token contents or raw exception messages. Failed diagnostics are nonfatal.

## Tests and evidence

```sh
python3 test_readonly_git.py
```

23 tests passed during this recovery. All credentials are fake temporary fixtures: genuine Git credential-protocol pipe test with repeated extension fields; scope, metadata, expiry, symlink and mode rejection; no-push wrapper; proxy preservation; config rejection; empty/nonempty-HEAD distinction; direct GUI save without extra secret files and conservative expiry conversion. GTK import/compilation was checked separately. These tests do **not** prove real authentication, actual desktop paste in the recovered environment, cloud persistence or a production scan.
