import fs from 'node:fs';
import path from 'node:path';
import { getOcrHomeDir } from '../cli/paths.js';
import { renameWithRetry } from '../utils/atomic-write.js';
import type { ProjectItem, ProjectsFile } from './types.js';

/** Path to `<ocrHome>/projects.json`. */
export function projectsFilePath(): string {
  return path.join(getOcrHomeDir(), 'projects.json');
}

/** Read the projects file, returning an empty set when missing or malformed. */
export function readProjects(): ProjectsFile {
  const filePath = projectsFilePath();
  if (!fs.existsSync(filePath)) {
    return { version: 1, activeId: null, projects: [] };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    // A transient lock (AV/indexer) must fail the read, never become an empty registry: every
    // mutation writes this file back whole, so an empty baseline would erase it.
    throw new Error(`cannot read ${path.basename(filePath)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
    const list = Array.isArray(parsed.projects) ? parsed.projects : [];
    const normalized: ProjectItem[] = [];

    for (const item of list) {
      if (
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.path === 'string'
      ) {
        normalized.push({
          id: item.id,
          name: item.name.trim(),
          path: path.normalize(item.path.trim()),
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
        });
      }
    }

    const activeId =
      typeof parsed.activeId === 'string' && normalized.some((p) => p.id === parsed.activeId)
        ? parsed.activeId
        : normalized[0]?.id ?? null;

    return {
      version: 1,
      activeId,
      projects: normalized,
    };
  } catch {
    // Unparsable bytes: keep them aside so the next write starts a new file instead of eating them.
    try {
      const aside = `${filePath}.corrupt-${Date.now()}`;
      fs.renameSync(filePath, aside);
      console.error(`[projects] ${path.basename(filePath)} is not valid JSON; kept as ${path.basename(aside)}`);
    } catch {
      // A rename that fails leaves the original untouched — still not a reason to overwrite it.
      throw new Error(`${path.basename(filePath)} is not usable and could not be set aside`);
    }
    return { version: 1, activeId: null, projects: [] };
  }
}

/** Atomically write the projects file. */
export function writeProjects(file: ProjectsFile): void {
  const filePath = projectsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), 'utf-8');
  // The house retry: a Windows AV/indexer handle on the just-written tmp file makes a bare rename
  // fail intermittently, and this persist surfaces as a user-visible project operation.
  renameWithRetry(tmpPath, filePath);
}

/** List all projects with the active ID. */
export function listProjects(): ProjectsFile {
  return readProjects();
}

/** Look up a project by its unique id. */
export function getProject(id: string): ProjectItem | null {
  const file = readProjects();
  return file.projects.find((p) => p.id === id) ?? null;
}

/** Validate that a path is a valid existing directory. */
export function validateProjectPath(rawPath: string): { ok: true; resolved: string } | { ok: false; message: string } {
  if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) {
    return { ok: false, message: 'path must be a non-empty string' };
  }
  const resolved = path.resolve(rawPath.trim());
  if (!fs.existsSync(resolved)) {
    return { ok: false, message: `directory does not exist: ${resolved}` };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, message: `path is not a directory: ${resolved}` };
    }
  } catch (e) {
    return { ok: false, message: `failed to inspect path: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, resolved };
}

/** Add a new project. */
export function addProject(input: { name: string; path: string }): { ok: true; project: ProjectItem } | { ok: false; message: string } {
  const name = input.name?.trim();
  if (!name) {
    return { ok: false, message: 'name is required' };
  }
  const pathCheck = validateProjectPath(input.path);
  if (!pathCheck.ok) {
    return { ok: false, message: pathCheck.message };
  }

  const file = readProjects();
  if (file.projects.some((p) => path.resolve(p.path) === pathCheck.resolved)) {
    return { ok: false, message: `a project with path '${pathCheck.resolved}' already exists` };
  }

  const now = new Date().toISOString();
  const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const project: ProjectItem = {
    id,
    name,
    path: pathCheck.resolved,
    createdAt: now,
    updatedAt: now,
  };

  file.projects.push(project);
  if (!file.activeId) {
    file.activeId = id;
  }
  writeProjects(file);

  return { ok: true, project };
}

/** Update an existing project's name or path. */
export function updateProject(
  id: string,
  input: { name?: string; path?: string }
): { ok: true; project: ProjectItem } | { ok: false; message: string } {
  const file = readProjects();
  const index = file.projects.findIndex((p) => p.id === id);
  if (index === -1) {
    return { ok: false, message: `project '${id}' not found` };
  }

  const existing = file.projects[index]!;
  let updatedPath = existing.path;
  if (input.path !== undefined) {
    const pathCheck = validateProjectPath(input.path);
    if (!pathCheck.ok) {
      return { ok: false, message: pathCheck.message };
    }
    const duplicate = file.projects.find((p) => p.id !== id && path.resolve(p.path) === pathCheck.resolved);
    if (duplicate) {
      return { ok: false, message: `another project with path '${pathCheck.resolved}' already exists` };
    }
    updatedPath = pathCheck.resolved;
  }

  const updatedName = input.name !== undefined ? input.name.trim() : existing.name;
  if (!updatedName) {
    return { ok: false, message: 'name cannot be empty' };
  }

  const updated: ProjectItem = {
    ...existing,
    name: updatedName,
    path: updatedPath,
    updatedAt: new Date().toISOString(),
  };

  file.projects[index] = updated;
  writeProjects(file);
  return { ok: true, project: updated };
}

/** Delete a project by ID. */
export function deleteProject(id: string): { ok: true } | { ok: false; message: string } {
  const file = readProjects();
  const initialCount = file.projects.length;
  file.projects = file.projects.filter((p) => p.id !== id);

  if (file.projects.length === initialCount) {
    return { ok: false, message: `project '${id}' not found` };
  }

  if (file.activeId === id) {
    file.activeId = file.projects[0]?.id ?? null;
  }

  writeProjects(file);
  return { ok: true };
}

/** Set the active project ID. */
export function setActiveProject(id: string | null): { ok: true; activeId: string | null } | { ok: false; message: string } {
  const file = readProjects();
  if (id !== null && !file.projects.some((p) => p.id === id)) {
    return { ok: false, message: `project '${id}' not found` };
  }

  file.activeId = id;
  writeProjects(file);
  return { ok: true, activeId: id };
}

