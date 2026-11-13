import { z } from 'zod';

export { estados, tipos } from './legacy-schemas.js';
export const states = ['pending', 'planning', 'in_progress', 'blocked', 'completed', 'cancelled'] as const;
export const itemTypes = ['plan', 'phase', 'task'] as const;
const text = z.string().trim().min(1);
const id = z.string().uuid();
const scope = { project_id: id };
const target = { ...scope, id };
const paging = { limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) };
const mutation = { request_id: text.max(200).optional() };
const version = { expected_version: z.number().int().min(1).optional() };
const confirmation = { confirm: z.literal(true).describe('Set true only after explicit user confirmation of this irreversible deletion. Never confirm automatically.') };
const fields = {
  title: text,
  description: z.string().optional(),
  document_path: text.optional(),
  plan_id: id.nullable().optional(),
  phase_id: id.nullable().optional(),
  acceptance_criteria: z.array(text).optional(),
  evidence: z.array(text).optional(),
  status: z.enum(states).optional(),
};
const filters = { type: z.enum(itemTypes).optional(), plan_id: id.optional(), phase_id: id.optional(), status: z.enum(states).optional() };
const relation = { ...target, target_id: id, type: z.enum(['depends_on', 'related', 'contributes_to']), ...version, ...mutation };

export const operationSchemas = {
  create_project: z.object({ name: text, description: z.string().optional(), repositories: z.array(text).optional(), ...mutation }).strict(),
  get_project: z.object(scope).strict(),
  list_projects: z.object(paging).strict(),
  update_project: z.object({ ...scope, name: text.optional(), description: z.string().nullable().optional(), repositories: z.array(text).optional(), ...version, ...mutation }).strict(),
  delete_project: z.object({ ...scope, ...confirmation, ...version, ...mutation }).strict(),
  delete_plan: z.object({ ...target, ...version, ...mutation }).strict(),
  delete_phase: z.object({ ...target, ...version, ...mutation }).strict(),
  delete_task: z.object({ ...target, ...confirmation, ...version, ...mutation }).strict(),
  create_item: z.object({ ...scope, type: z.enum(itemTypes), ...fields, ...mutation }).strict(),
  update_item: z.object({ ...target, type: z.enum(itemTypes).optional(), ...fields, title: text.optional(), description: z.string().nullable().optional(), document_path: text.nullable().optional(), ...version, ...mutation }).strict(),
  get_summary: z.object(target).strict(),
  get_details: z.object(target).strict(),
  get_active_context: z.object({ ...scope, ...filters, ...paging }).strict(),
  list_history: z.object({ ...scope, ...filters, ...paging }).strict(),
  list_changes: z.object({ ...scope, id: id.optional(), ...paging }).strict(),
  add_note: z.object({ ...target, type: z.enum(['progress', 'agreement', 'blocker', 'note', 'evidence']), text, reference: text.optional(), ...version, ...mutation }).strict(),
  add_relation: z.object(relation).strict(),
  remove_relation: z.object(relation).strict(),
  reopen_item: z.object({ ...target, status: z.enum(['pending', 'planning', 'in_progress', 'blocked']).default('pending'), reason: text.optional(), ...version, ...mutation }).strict(),
  create_backup: z.object({ project_id: id.optional(), destination_path: text.optional(), ...mutation }).strict(),
};

const document = ' Markdown documents are created and edited externally; only their absolute path is registered, never their contents. Title, Goal and Scope are recommended; criteria, agreements, approach, dependencies and evidence are optional.';
export const operationDescriptions: Record<keyof typeof operationSchemas, string> = {
  create_project: 'Creates a local project without modifying repositories. Returns its ID and version.',
  get_project: 'Gets project metadata by explicit project ID.',
  list_projects: 'Lists projects with pagination; does not select a global project.',
  update_project: 'Updates project metadata with optional version checking.',
  delete_project: 'Irreversibly deletes a project and cascades through all its plans, phases, tasks, annotations, relations and history. Requires prior explicit user confirmation (confirm: true); never confirm automatically. Invalidates old idempotent responses; retains only a minimal receipt for this request when request_id is supplied. Does not delete documents, .work, or any files or directories, including home/projects and external paths; the user decides their manual cleanup.',
  delete_plan: 'Irreversibly deletes a plan only if it has no phases or direct or derived tasks, including completed or cancelled children; otherwise returns HAS_CHILDREN without deleting anything. Deletes its annotations, relations and history and invalidates old idempotent responses. Does not delete documents or files; cleanup is manual.',
  delete_phase: 'Irreversibly deletes a phase only if it has no tasks in any status, including completed or cancelled tasks; otherwise returns HAS_CHILDREN without deleting anything. Deletes its annotations, relations and history and invalidates old idempotent responses. Does not delete documents or files; cleanup is manual.',
  delete_task: 'Irreversibly deletes a task, its annotations, relations and history and invalidates old idempotent responses. Requires prior explicit user confirmation (confirm: true); never confirm automatically. Does not delete documents or files; the user decides their manual cleanup.',
  create_item: 'Creates a plan, phase or task; supports standalone tasks, independent phases and direct plan tasks. Returns a summary.' + document,
  update_item: 'Updates data, parent membership or status without closing descendants. Supplied arrays replace existing arrays; null removes optional fields. Returns a summary.' + document,
  get_summary: 'Gets ID, type, title, status, version, parent membership and document path, without history.',
  get_details: 'Gets metadata, acceptance criteria, evidence, relations and dates; does not expand history or files.',
  get_active_context: 'Lists all work not completed or cancelled, regardless of parent status; includes current blockers and relevant dependencies, without history or earlier evidence.',
  list_history: 'Explicitly queries completed or cancelled work in a minimal, paginated projection.',
  list_changes: 'Lists project or item events and annotations with before/after snapshots and pagination.',
  add_note: 'Records progress, an agreement, blocker, note or evidence reference. Does not automatically change status or create files. The latest blocker remains in context until an explicit update to a status other than blocked, or reopening.',
  add_relation: 'Adds a directed relation within the same project; does not change statuses.',
  remove_relation: 'Removes a directed relation while preserving traceability.',
  reopen_item: 'Reopens only closed work, preserving its ID, evidence, relations and history; reason is optional.',
  create_backup: 'Consistently copies the entire database and managed documents in home/projects; does not copy external paths or guarantee atomicity with external edits. project_id, if provided, validates the project but does not limit the global backup.',
};
