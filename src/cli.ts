#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { Bitacora } from './core.js';
import { operationDescriptions, operationSchemas } from './schemas.js';

type Operation = keyof typeof operationSchemas;
const groups: { title: string; operations: [Operation, string][] }[] = [
  { title: 'Projects', operations: [
    ['list_projects', 'List projects.'],
    ['create_project', 'Create a project.'],
    ['get_project', 'Show project metadata.'],
    ['update_project', 'Update project metadata.'],
  ] },
  { title: 'Work and context', operations: [
    ['get_active_context', 'Show active work, blockers and dependencies.'],
    ['create_item', 'Create a plan, phase or task.'],
    ['get_summary', 'Show a brief work-item summary.'],
    ['get_details', 'Show work-item details and relationships.'],
    ['update_item', 'Update a work item or its status.'],
    ['reopen_item', 'Reopen completed or cancelled work.'],
  ] },
  { title: 'Notes and relationships', operations: [
    ['add_note', 'Record progress, a decision, blocker or evidence.'],
    ['add_relation', 'Connect two work items.'],
    ['remove_relation', 'Remove a connection between work items.'],
  ] },
  { title: 'History and backup', operations: [
    ['list_history', 'List completed or cancelled work.'],
    ['list_changes', 'List changes and notes for a project or item.'],
    ['create_backup', 'Back up the entire database and managed files.'],
  ] },
  { title: 'Delete (irreversible)', operations: [
    ['delete_task', 'Delete a task; explicit confirmation required.'],
    ['delete_phase', 'Delete an empty phase.'],
    ['delete_plan', 'Delete an empty plan.'],
    ['delete_project', 'Delete a project and its work; explicit confirmation required.'],
  ] },
];

const usage = `Daybook — local project and work context

Usage: daybook <operation> [options] [--json]
       daybook --help
       daybook <operation> --help

Examples:
  daybook list_projects
  daybook create_project --name 'My project'
  daybook get_active_context --project-id PROJECT_ID
  daybook create_item --project-id PROJECT_ID --type task --title 'My task'
  echo '{"name":"My project"}' | daybook create_project -

Operations:
${groups.map(group => `\n  ${group.title}\n${group.operations.map(([name, description]) => `    ${name.padEnd(20)} ${description}`).join('\n')}`).join('\n')}

Use --field-name VALUE for inputs, repeating an option for array values.
Boolean confirmation uses --confirm. Use --field-name=null to clear nullable fields.
JSON input remains available as an argument or via - on stdin.
Run daybook <operation> --help for its options and JSON input schema.
Results are concise text; use --json for complete, machine-readable output.
Errors go to stderr with a nonzero exit code (also JSON with --json).
DAYBOOK_HOME (or BITACORA_HOME) selects the database; use the same path as MCP.`;

const primaryFields = ['name', 'title', 'type', 'status', 'id', 'project_id', 'version', 'description', 'text', 'message', 'path', 'document_path', 'blocker', 'current_blocker', 'dependencies'];

function formatValue(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    if (!value.length) return 'None';
    return value.map(item => `${indent}- ${formatValue(item, indent + '  ')}`).join('\n');
  }
  if (typeof value !== 'object') return String(value);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter(key => object[key] !== null && object[key] !== undefined && !(Array.isArray(object[key]) && (object[key] as unknown[]).length === 0));
  if (!keys.length) return 'None';
  const selected = primaryFields.filter(key => keys.includes(key));
  const remaining = keys.filter(key => !selected.includes(key));
  // Show all fields on small objects; for larger records keep the most useful
  // fields and make the availability of the full result explicit.
  const safetyResult = keys.some(key => ['skipped_paths', 'external_paths_not_copied', 'limitations', 'incomplete_copy', 'documents_deleted'].includes(key));
  const shown = selected.length && keys.length > 8 && !safetyResult ? selected : [...selected, ...remaining];
  const lines = shown.map(key => {
    const item = object[key];
    const label = key.replaceAll('_', ' ');
    if (item !== null && typeof item === 'object') return `${label}:\n${indent}  ${formatValue(item, indent + '  ')}`;
    return `${label}: ${formatValue(item, indent)}`;
  });
  if (shown.length < keys.length) lines.push(`… ${keys.length - shown.length} more fields (--json)`);
  return lines.join(`\n${indent}`);
}

function formatResult(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (Array.isArray(result.items)) {
      const items = result.items.length ? result.items.map(item => formatValue(item)).join('\n---\n') : 'No items.';
      const metadata = Object.fromEntries(Object.entries(result).filter(([key, item]) => key !== 'items' && item !== null && item !== undefined));
      return Object.keys(metadata).length ? `${items}\n---\n${formatValue(metadata)}` : items;
    }
  }
  return formatValue(value);
}

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) {
    console.log(usage);
    return;
  }
  const jsonOutput = args.includes('--json');
  const [name, ...inputs] = args.filter(arg => arg !== '--json');
  if (!name || !Object.hasOwn(operationSchemas, name)) throw new Error(`Unknown operation: ${name}`);
  const operation = name as keyof typeof operationSchemas;
  const schema = z.toJSONSchema(operationSchemas[operation]);
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  if (inputs.length === 1 && (inputs[0] === '--help' || inputs[0] === '-h')) {
    const required = new Set(schema.required ?? []);
    const options = Object.entries(properties).map(([key, property]) => `  --${key.replaceAll('_', '-')} ${key === 'confirm' ? '' : 'VALUE '}${required.has(key) ? '(required)' : '(optional)'}${property.type === 'array' ? ' (repeatable)' : ''}`).join('\n');
    console.log(`${name}: ${operationDescriptions[operation]}\n\nOptions:\n${options || '  None'}\n  --json  Output the complete result as JSON\n\nInput schema:\n${JSON.stringify(schema, null, 2)}`);
    return;
  }
  let parsed: unknown;
  if (inputs.length && !inputs[0]!.startsWith('--')) {
    if (inputs.length !== 1) throw new Error('JSON input cannot be combined with named options.');
    let json = inputs[0]!;
    if (json === '-') {
      json = '';
      for await (const chunk of process.stdin) json += chunk;
    }
    parsed = JSON.parse(json);
  } else {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < inputs.length; i++) {
      const arg = inputs[i]!;
      if (!arg.startsWith('--')) throw new Error(`Expected an option, received: ${arg}`);
      const equals = arg.indexOf('=');
      const key = arg.slice(2, equals < 0 ? undefined : equals).replaceAll('-', '_');
      const property = properties[key];
      if (!property) throw new Error(`Unknown option: --${key.replaceAll('_', '-')}`);
      const alternatives = Array.isArray(property.anyOf) ? property.anyOf as Record<string, unknown>[] : [];
      const type = property.type ?? alternatives.find(item => item.type !== 'null')?.type;
      const raw = equals >= 0 ? arg.slice(equals + 1) : (type === 'boolean' || property.const === true) && (!inputs[i + 1] || inputs[i + 1]!.startsWith('--')) ? 'true' : inputs[++i];
      if (raw === undefined || (equals < 0 && raw.startsWith('--'))) throw new Error(`Missing value for --${key.replaceAll('_', '-')}`);
      let value: unknown = raw;
      if (raw === 'null' && alternatives.some(item => item.type === 'null')) value = null;
      else if (type === 'integer' || type === 'number') {
        if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`Expected a number for --${key.replaceAll('_', '-')}`);
        value = Number(raw);
      } else if (type === 'boolean' || property.const === true) {
        if (raw !== 'true' && raw !== 'false') throw new Error(`Expected true or false for --${key.replaceAll('_', '-')}`);
        value = raw === 'true';
      }
      if (type === 'array') {
        if (!Object.hasOwn(data, key)) data[key] = [];
        (data[key] as unknown[]).push(value);
      }
      else {
        if (Object.hasOwn(data, key)) throw new Error(`Duplicate option: --${key.replaceAll('_', '-')}`);
        data[key] = value;
      }
    }
    parsed = data;
  }
  const core = new Bitacora();
  try {
    const result = await core.execute(operation, parsed);
    console.log(jsonOutput ? JSON.stringify(result, null, 2) : formatResult(result));
  } finally {
    core.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const value = error as { code?: unknown; message?: unknown; details?: unknown } | null;
    const result = {
      code: typeof value?.code === 'string' ? value.code : 'CLI_ERROR',
      message: typeof value?.message === 'string' ? value.message : 'Unexpected error',
      ...(value?.details === undefined ? {} : { details: value.details }),
    };
    console.error(process.argv.slice(2).includes('--json') ? JSON.stringify(result) : `Error (${result.code}): ${result.message}${result.details === undefined ? '' : `\n${formatValue(result.details)}`}`);
    process.exitCode = 1;
  });
}
