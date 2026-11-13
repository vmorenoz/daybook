# Daybook

Independent local utility: TypeScript, Node.js 24+, built-in SQLite, and MCP over stdio. No dependency on OpenCode or a UI.

## Run

### Install globally from a tarball

With Node.js 24 or newer and npm, download `alba-daybook-<version>.tgz` from the [GitHub releases](https://github.com/vmorenoz/daybook/releases), then install it from the download directory (replace the example version with the downloaded version):

```sh
npm install -g ./alba-daybook-1.0.0.tgz --foreground-scripts
```

Select **OpenCode, Codex, Antigravity, and Claude Code** using the arrow keys, space to select, and Enter to confirm. Enter with no selection cancels setup. There is no second form or verbose path listing.

Setup registers the `daybook` MCP server and a lightweight global instruction **without creating configuration backups**, preserving unrelated settings. It installs neither a global CLI nor a skill. Each client starts the server automatically; no manual startup is required after reboot. Client trust and permission prompts still apply. Unselected clients are not modified.

If OpenCode has both `opencode.json` and `opencode.jsonc`, setup registers the same server in both, without deleting either file or changing unrelated settings. Antigravity uses `~/.gemini/config/mcp_config.json`.

The tarball contains the compiled server and installer; npm downloads dependencies during installation. No extraction, repository clone, or TypeScript installation is needed. Data remains separate from the installation in `DAYBOOK_HOME`, falling back to `BITACORA_HOME` or `~/.local/share/bitacora` for compatibility.

The package name is `alba-daybook` and the MCP server ID is `daybook`. `DAYBOOK_HOME` and `DAYBOOK_INSTALL_*` are the current environment variables; existing `BITACORA_*` variables remain fallback aliases. The existing data directory and `bitacora.sqlite` filename are retained for compatibility. Setup migrates old `bitacora`, `vimo-contex`, `vimo-cortex` and `alba-cortex` registrations only when it recognizes the previous runtime and the same data location; unrelated connections are preserved. No data is moved or copied. `Daybook` is the current library export; old `AlbaCortex`, `VimoCortex` and `VimoContex` aliases remain available for existing consumers.

### Global instruction

The source is [`instructions/global.md`](instructions/global.md), included in the tarball. Setup adds or updates only the block between `<!-- daybook:start -->` and `<!-- daybook:end -->`, without duplication or replacement of user instructions. A single old `vimo-cortex` or `alba-cortex` managed block is upgraded in place; mixed or ambiguous blocks are rejected. For a recognized OpenCode registration, the old instruction-file reference is replaced with the new one without deleting the old file:

| Client | Global file |
|---|---|
| OpenCode | `~/.config/opencode/instructions/daybook.md`, added to global `instructions` (respects `XDG_CONFIG_HOME`) |
| Codex | `~/.codex/AGENTS.md`, or `AGENTS.override.md` if nonempty (respects `CODEX_HOME`) |
| Antigravity | `~/.gemini/GEMINI.md` |
| Claude Code | `~/.claude/CLAUDE.md` (respects `CLAUDE_CONFIG_DIR`) |

The instruction explains when to use the MCP, resume project context, and record work without imposing a methodology. It is not a skill and is registered only for selected clients.

Before starting project work, the agent reads `project_id` from the `daybook` block in the project's `AGENTS.md`. An existing legacy `alba-cortex`/`vimo-cortex` block or `proyecto_id` key is accepted as the same binding, not a reason to create a duplicate. If neither exists, the agent offers to create a project or list existing ones for the user to select, waits for their choice, and stores the ID without replacing other instructions. English MCP calls use `project_id`.

The same block stores `work_versioning: track|ignore`. Legacy `versionar|excluir` decisions remain valid. Ask once when tracking `.work/` becomes relevant and reuse the stored answer. This policy applies to `.work/`, not the entire `AGENTS.md` file.

Documents live in each project's `.work/`: `plans/`, `decisions/`, `attachments/`, and `evidence/`. Reuse existing Spanish-named folders rather than moving or duplicating documents. Create only necessary folders and documents; configuration does not belong in `.work/`. SQLite stores absolute-path references, not duplicate document contents.

OpenCode uses an additional instruction source to avoid replacing `AGENTS.md` or disabling its Claude Code compatibility rules.

To build the tarball from source:

```sh
npm ci --ignore-scripts
npm run pack
```

The output is `releases/alba-daybook-<source-version>.tgz`, using the version in the source checkout. Use `--ignore-scripts` when preparing source code if you do not want setup to run. Without an interactive terminal, setup does not modify configurations automatically.

### Publishing releases

Users with permission to run workflows can dispatch Release, but its jobs run only for `vmorenoz` on `main` (including on reruns). It tests the selected commit, assigns `1.0.0` to the first release and increments the patch thereafter, then checks the built tarball by installing it in an isolated temporary prefix with setup disabled. The tarball package version, asset filename and `v`-prefixed tag agree. The version is injected during the build; the checked-in source version is not changed by the workflow. The tag points to the tested source commit.

The workflow serializes its own runs and does not overwrite tags or assets. If a tag was created but publication failed, or a draft or incomplete release remains, inspect and resolve it manually before retrying; the workflow deliberately stops instead of skipping it. A retry after a successful release creates the next patch release. The repository must allow the workflow token to write contents; no extra secret is required.

For unattended setup, set `DAYBOOK_INSTALL_CLIENTS=opencode,codex,antigravity,claude-code` and `DAYBOOK_INSTALL_CONFIRM=1` when running npm. `DAYBOOK_SKIP_SETUP=1` skips registration. The previous `BITACORA_*` flags are still accepted, with `DAYBOOK_*` values taking precedence. Do not use `sudo`: setup avoids configuring another user's account. Invalid files and direct symbolic links are rejected rather than overwritten.

### Run from source

```sh
git clone https://github.com/vmorenoz/daybook.git
cd daybook
npm ci --ignore-scripts
npm run build
npm start
```

The process waits for an MCP client; it is not an interactive console. Configure a compatible client with:

- Executable: absolute path to Node.js 24 or newer.
- Arguments: `["/absolute/path/to/daybook/dist/mcp.js"]`.
- Optional `DAYBOOK_HOME`: absolute data directory.

Replace the example paths if you move the module to another location or machine.

Manual startup does not register the MCP automatically. `npm test` runs short core, MCP, and installer flows without modifying personal configurations.

## Data and contracts

Data defaults to `~/.local/share/bitacora`, separate from repositories. Creating a project does not modify its repository; keep its ID in project metadata. Project-scoped operations require an explicit `project_id`.

- Item types: `plan`, `phase`, `task`. Independent phases, standalone tasks, and tasks directly under a plan are supported.
- Statuses: `pending`, `planning`, `in_progress`, `blocked`, `completed`, `cancelled`.
- Active work excludes completed and cancelled items. Closing a parent neither closes nor hides its open children.
- Mutations return a summary. Details and history are explicit queries; lists are paginated.
- `expected_version` detects conflicts; `request_id` makes retries idempotent. Reuse both when retrying the same request.
- Reopening preserves IDs, relations, and history. Completion does not require evidence.

The agent creates, reads, and edits Markdown documents. Daybook records paths, never returns their contents, and does not version external edits. When attaching a Markdown document, include Title, Objective, and Scope. Acceptance criteria, agreements and decisions, implementation approach, dependencies, and evidence are optional.

## MCP capabilities

| Group | Tools |
|---|---|
| Projects | `create_project`, `get_project`, `list_projects`, `update_project` |
| Work | `create_item`, `update_item`, `reopen_item` |
| Deletion | `delete_project`, `delete_plan`, `delete_phase`, `delete_task` |
| Tracking | `add_note`, `add_relation`, `remove_relation` |
| Queries | `get_summary`, `get_details`, `get_active_context`, `list_history`, `list_changes` |
| Backup | `create_backup` |

MCP schemas describe parameters and limits; responses include `structuredContent` for programmatic consumers and Code Mode. The MCP exposes the 20 English tool names above. Spanish operation names remain supported by the direct `execute()` API, not advertised as duplicate MCP tools.

Minimal flow: `create_project({name})` → `create_item({project_id,type:"task",title})` → `update_item({project_id,id,status:"completed"})`. Then call `list_history` or `reopen_item` using the same ID.

### Permanent deletion

| Operation | Condition |
|---|---|
| `delete_project` | Requires `confirm: true` after explicit user confirmation. Cascades through the project's records, relations, annotations, and history in SQLite. |
| `delete_plan` | Requires a plan with no phases or tasks, including direct and closed tasks. Delete the children first. |
| `delete_phase` | Requires deleting all its tasks first, including closed tasks. |
| `delete_task` | Requires `confirm: true` after explicit user confirmation. |

All receive `project_id`; plan, phase, and task deletion also receive `id`. They support `expected_version` and `request_id` like other mutations. Confirmation is a caller assertion: the agent must obtain user consent before sending it.

Deletion differs from completion or cancellation and cannot be undone with `reopen_item`. **No delete operation removes files**: `.work/` documents, other referenced files, and existing backups are untouched. The user may keep or remove them separately whenever they choose. Repositories and `AGENTS.md` are never modified automatically.

## Use without MCP

```js
import { Daybook } from './dist/index.js';

const daybook = new Daybook({ home: '/absolute/path/to/daybook-data' });
try {
  const project = await daybook.execute('create_project', { name: 'My project' });
  await daybook.execute('create_item', {
    project_id: project.id, type: 'task', title: 'First task'
  });
} finally {
  daybook.close();
}
```

## Compatibility

Existing SQLite data, IDs, stored states, file paths, environment variables, and deletion rules are unchanged. The public English API translates its fields and enum values at the boundary; it does not rewrite user text or stored data. For example, `project_id`, `status: "completed"`, and `confirm: true` map internally to the legacy fields. Existing direct Spanish calls such as `execute('crear_proyecto', {nombre: 'Example'})` retain their original response shape. Reconnect the MCP after updating to discover the English tools.

## Backups

`create_backup` copies the complete SQLite database and documents under managed `projects/`. Its scope is global even when `project_id` is supplied. It excludes external document paths and does not follow symbolic links. Pause direct document edits during backup: SQLite provides a consistent database copy, but cannot make external file edits atomic. Preserve original paths when restoring or update them explicitly.

An interruption may leave an incomplete backup directory and a pending `request_id`. Use another request ID and destination in that case. Only consider a backup complete when its operation succeeded and it contains `manifest.json`.
