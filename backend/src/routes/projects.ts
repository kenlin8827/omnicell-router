import type { FastifyInstance } from 'fastify';
import {
  getProject,
  listProjects,
  addProject,
  updateProject,
  deleteProject,
  setActiveProject,
  validateProjectPath,
} from '../projects/store.js';
import { retargetProjectRoot } from '../harness/host/manifest.js';

export function registerProjectRoutes(app: FastifyInstance): void {
  // List all projects with the active ID
  app.get('/api/admin/projects', async () => {
    const data = listProjects();
    return {
      status: 'ok',
      activeId: data.activeId,
      projects: data.projects,
    };
  });

  // Validate a path without adding it
  app.post('/api/admin/projects/validate-path', async (req, reply) => {
    const body = (req.body || {}) as { path?: string };
    if (!body.path || typeof body.path !== 'string') {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'path is required' };
    }
    const check = validateProjectPath(body.path);
    if (!check.ok) {
      reply.code(400);
      return { status: 'error', code: 'invalid_path', message: check.message };
    }
    return { status: 'ok', resolved: check.resolved };
  });

  // Add a new project
  app.post('/api/admin/projects', async (req, reply) => {
    const body = (req.body || {}) as { name?: unknown; path?: unknown };
    if (typeof body.name !== 'string' || typeof body.path !== 'string' || !body.name.trim() || !body.path.trim()) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'name and path are required' };
    }

    const result = addProject({ name: body.name, path: body.path });
    if (!result.ok) {
      reply.code(400);
      return { status: 'error', code: 'failed', message: result.message };
    }

    return { status: 'ok', project: result.project };
  });

  // Update a project
  app.put('/api/admin/projects/:id', async (req, reply) => {
    const params = req.params as { id: string };
    const raw = (req.body || {}) as { name?: unknown; path?: unknown };
    if (
      (raw.name !== undefined && typeof raw.name !== 'string') ||
      (raw.path !== undefined && typeof raw.path !== 'string')
    ) {
      reply.code(400);
      return { status: 'error', code: 'bad_request', message: 'name and path must be strings' };
    }
    const body = {
      ...(raw.name !== undefined ? { name: raw.name as string } : {}),
      ...(raw.path !== undefined ? { path: raw.path as string } : {}),
    };

    const before = getProject(params.id);
    const result = updateProject(params.id, body);
    if (!result.ok) {
      reply.code(400);
      return { status: 'error', code: 'failed', message: result.message };
    }
    // A moved project keeps its tracked copies: rewrite their attribution and locations so they do
    // not read as missing after the folder was renamed.
    if (before && before.path !== result.project.path) {
      retargetProjectRoot(before.path, result.project.path);
    }

    return { status: 'ok', project: result.project };
  });

  // Delete a project. Deliberately NOT a cascade: the directory still exists, the manifest still
  // names the real copies, and uninstalling is an explicit per-artifact operation (ADR-0015 §D5).
  // Re-adding the same path picks its project-scope copies back up unchanged.
  app.delete('/api/admin/projects/:id', async (req, reply) => {
    const params = req.params as { id: string };
    const result = deleteProject(params.id);
    if (!result.ok) {
      reply.code(404);
      return { status: 'error', code: 'not_found', message: result.message };
    }

    return { status: 'ok' };
  });

  // Set the active project
  app.post('/api/admin/projects/active', async (req, reply) => {
    const body = (req.body || {}) as { id?: string | null };
    const targetId = body.id === undefined ? null : body.id;

    const result = setActiveProject(targetId);
    if (!result.ok) {
      reply.code(400);
      return { status: 'error', code: 'failed', message: result.message };
    }

    return { status: 'ok', activeId: result.activeId };
  });
}

