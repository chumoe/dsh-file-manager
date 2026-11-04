# dsh-file-manager

A full workspace file manager that replaces the **Workspace Files** tab body in the DeepSeek Harness (DSH) right sidebar — browse, preview, edit, create, rename, copy, move, delete, compress, extract, upload, download, and hand files to the chat as real composer chips.

The shipped `@deepseek-ai/dsh-client-ui-sidebar-files` tab is listing-only. This bundle registers a replacement body and title into the **same slot keys at `priority: -10`**, so it wins over the shipped entry only while this bundle is enabled. Disable the bundle and the original tab returns — nothing is patched or deleted.

| | |
| --- | --- |
| Plugin id | `file-manager` |
| Package | `dsh-file-manager` |
| Host half | `index.js` (4 authenticated Fetch routes) |
| Web half | `client.js` (no Harness client imports) |
| Node | ≥ 22 |
| System tools | `zip`, `unzip`, `tar` (only for compress/extract/download-as-zip) |

## Features

**Navigation**
- One directory at a time: the list always shows the children of the current folder, so the breadcrumb and the rows can never disagree.
- Double-click, `Enter`, the chevron or a breadcrumb enters a folder; `ArrowLeft` climbs to the parent; a single click only selects and never swaps the listing under the pointer.
- Multi-select with `Ctrl`/`Cmd` and `Shift`.
- Search (the magnifier) is the one mode that spans folders: it filters across every directory already loaded, keeps each hit's ancestors visible, and renders hits as an indented tree. Rows expose `treeitem` / `aria-level` / `data-fm-path`.
- Directories sort first, then naturally and case-insensitively.
- A **jump menu** in the toolbar switches the panel to another root: the session workspaces, the home directory, Desktop / Downloads / Documents, `/tmp` and `/`. Any absolute path works, so the panel is not trapped inside one workspace.

**Preview and edit**
- Images, PDF, video, audio and text preview inline; other binaries fall back to metadata plus a download button.
- Line numbers in the gutter, which stays visible while the text scrolls.
- Syntax highlighting in both preview and editor with **no third-party dependency**: a built-in tokenizer covers C-like languages (JS/TS/JSX/Java/C/C++/Go/Rust/PHP…), Python/Ruby/Shell/Lua, YAML/TOML/INI, SQL, CSS/SCSS/Less, JSON and HTML/XML/Vue/Svelte, plus Markdown. Colours are theme aliases and follow light/dark. Files above 80 KB fall back to plain text so a huge file never stalls the panel.
- Inline editing over the highlighted layer (transparent textarea, synced scroll). `Ctrl+S` saves, `Tab` inserts two spaces, an external change raises a conflict prompt instead of silently overwriting, and files above the 2 MB text cap open read-only.
- Word and line selection behave like a plain textarea even in the highlighted preview: highlighting splits every token into its own `<span>`, so a native double click would stop at a token boundary — a double click re-selects the whole word and a triple click the whole line across spans, while blank space keeps the browser's own gap selection.

**File operations**
- New file, new folder, rename (`F2`), delete (`Del`), copy / cut / paste (`Ctrl+C` / `X` / `V`).
- Upload files and whole folders (drag and drop works too). Downloads are fetched as blobs and saved through a same-origin anchor, so they also work when the Web UI is mounted behind a gateway prefix.
- Download a file, a folder (as zip) or a multi-selection (as one zip).
- Compress to ZIP or `tar.gz`; extract ZIP / tar / `tar.gz` beside the archive. Extraction happens in a temporary directory inside the workspace and is then moved into a unique name, so a hostile archive cannot write outside the target.
- Hidden-file toggle: dot files are hidden by default and the toolbar "more" menu toggles them.

**Context menus**
- Menus on the tree, the preview and the editor. Entries that cannot apply are **omitted, never greyed out**: no selection means no copy, no text selected means no add-selected-text, an empty or unreadable clipboard means no paste, and a truncated read-only file means no cut/paste.
- Copy relative path, copy absolute path and copy file name from the tree menu; the absolute-path entry also appears on the preview and editor menus. A multi-selection copies one path per line.

**Add to chat with real chips**
- "Add to chat" produces a **real composer chip**, the same kind the `@` picker creates. The whole draft is rewritten through the draft snapshot (`{text, references}`), the only route that makes the composer rebuild chip nodes. Existing chips are preserved and their offsets shifted across the edit, so earlier picks survive.
- The caret span the composer reports is in *detect* coordinates, where a chip counts as one character, while published occurrences use *clipboard* offsets where the chip expands to its mention text. The offsets are converted before splicing, and the whole edit is re-planned at the draft end if the composer would reject the result, so a second pick can never land inside the first chip.
- The mention stays inline at the caret: no surrounding newlines, and a single separating space only when the neighbouring character is not whitespace already. "Add selection" is the one block-shaped insert (a fenced snippet), so it borrows a line break only when the draft lacks one at that edge.
- A row of chip-style markers under the tree mirrors every file/folder currently attached to the conversation, because the composer treats a chip click as "open the file" rather than "remove". Clicking a marker detaches that file: the mention span is removed (swallowing one adjacent space) and the remaining chips keep their positions.

## Install

Requires DSH `>= 0.2.1-rc.5` and Node `>= 22`.

**From a local directory** (a checkout or an unpacked release):

```
dsh plugin add /absolute/path/to/dsh-file-manager
```

or through the plugin manager tool:

```
plugin_manager  action: install_bundle  target: /absolute/path/to/dsh-file-manager
```

**From GitHub** — clone first, then add the directory; the bundle is not published to a registry, so the archive path is the install path:

```
git clone https://github.com/OWNER/dsh-file-manager.git
dsh plugin add "$PWD/dsh-file-manager"
```

Restart the Web UI (or let HMR pick it up) and open the right sidebar → **Workspace Files**. Remove or disable `dsh-file-manager` in the plugin list to restore the shipped tab.

## Configuration

None. There are no settings: the panel inherits the session's workspace directory from the Host.

Server-side limits:

| Limit | Value |
| --- | --- |
| JSON request body | 32 MB |
| Text file editable in the panel | 32 MB |
| Directory entries returned | 20000 (reported as `truncated`) |
| Upload | 8 GB |

These are guard rails against accidentally freezing the panel, not a security boundary — all of them are generous on purpose.

## Safety model

- **Local-first by design.** DSH normally runs on the operator's own machine and these routes already inherit the Host's login-cookie, Host and Origin checks, so the panel is deliberately permissive: any existing absolute directory can be opened as the root, which is what makes it usable for a checkout, a download folder or a log directory outside the session workspace. `~` expands to the home directory, and the toolbar menu offers jump targets (workspaces, home, Desktop, Downloads, `/tmp`, `/`).
- Everything below that root is still confined: every relative path is normalised (empty, `.` and `..` components are rejected, backslashes normalised, a leading `/` stripped), and a path may never leave the root you are looking at.
- Symlink escapes are rejected: the nearest existing ancestor of the target is `realpath`-ed and must stay inside the root.
- Uploads get unique names; writes are temp-file + atomic rename and compare the base mtime to surface external modification as `409 conflict`.
- Extraction goes to a temporary directory inside the workspace and only then moves entries to a unique destination name.
- Text/HTML/JS downloads are forced to `text/plain` + `nosniff` with `CSP: sandbox`; only known image/PDF/audio/video types are served inline.
- "Add to chat" only ever rewrites the current session's composer draft (text plus chip references). It never submits, never uploads files and never touches another session.
- All routes are registered through `ctx.connection.fetch.register`, so they inherit the Host's login-cookie, Origin and Host checks.

## Layout

```
dsh-file-manager/
├── index.js          # host half: 4 authenticated Fetch routes
├── client.js         # web half: panel, editor, highlighter, menus, composer chips
├── cordis.patch.yml  # inserts the host plugin row
├── locale/en.json    # meta.title / meta.description shown in the plugin list
├── locale/zh.json
├── icon.svg          # plugin icon
├── LICENSE
├── README.md
└── package.json
```

Routes registered by `index.js`:

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/fm/op` | POST | list, read, write, mkdir, rename, copy, move, delete, compress, extract, roots |
| `/api/fm/upload` | POST (streaming) | upload one file into a directory |
| `/api/fm/download` | GET | stream a file, or zip and stream a directory |
| `/api/fm/zip` | POST | return a multi-selection as one zip |

The panel's user-facing strings live in the `zh` and `en` tables inside `client.js`; server error messages are English plus a stable `code`, and the client translates known codes so a Chinese UI never shows a raw English sentence.

## Development

There is no build step: `client.js` is a plain `window.__ModuleLoader__.load({ id, factory })` module that imports only `react`. It must not import Harness client packages, and it styles exclusively with `--dsw-alias-*` theme tokens (theme variables are defined on `body`, not `:root`; dark mode is `body[data-ds-dark-theme]`).

Checks before a release:

```
node --check index.js
node --check client.js
node -e "JSON.parse(require('fs').readFileSync('package.json'))"
node -e "JSON.parse(require('fs').readFileSync('locale/en.json'))"
```

Behaviour is covered by host-route and render-harness scripts (a fake `ctx` for the four routes; a fake React with per-fiber hooks for the panel). There is no bundled test runner in the repository yet — the scripts are kept outside the package on purpose, because `files` would otherwise ship them to users.

## Licence

MIT — see [LICENSE](LICENSE).
