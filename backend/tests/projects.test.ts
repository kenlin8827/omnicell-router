import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fastify from 'fastify';
import {
  readProjects,
  addProject,
  updateProject,
  deleteProject,
  setActiveProject,
  getProject,
} from '../src/projects/store.js';
import { registerProjectRoutes } from '../src/routes/projects.js';

describe('Project Management Store & API', () => {
  let tmpDir: string;
  let fakeProjectDir1: string;
  let fakeProjectDir2: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-proj-test-'));
    fakeProjectDir1 = path.join(tmpDir, 'project-alpha');
    fakeProjectDir2 = path.join(tmpDir, 'project-beta');
    fs.mkdirSync(fakeProjectDir1, { recursive: true });
    fs.mkdirSync(fakeProjectDir2, { recursive: true });

    prevHome = process.env.OCR_HOME;
    process.env.OCR_HOME = path.join(tmpDir, '.ocr');
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.OCR_HOME;
    } else {
      process.env.OCR_HOME = prevHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts with an empty project list', () => {
    const data = readProjects();
    expect(data.version).toBe(1);
    expect(data.activeId).toBeNull();
    expect(data.projects).toEqual([]);
  });

  it('adds a project and sets activeId for the first project', () => {
    const res = addProject({ name: 'Alpha', path: fakeProjectDir1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.project.name).toBe('Alpha');
    expect(path.resolve(res.project.path)).toBe(path.resolve(fakeProjectDir1));

    const data = readProjects();
    expect(data.projects.length).toBe(1);
    expect(data.activeId).toBe(res.project.id);
  });

  it('refuses invalid paths or non-existent directories', () => {
    const bogus = path.join(tmpDir, 'no-such-dir');
    const res = addProject({ name: 'Bogus', path: bogus });
    expect(res.ok).toBe(false);

    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello', 'utf-8');
    const fileRes = addProject({ name: 'File', path: filePath });
    expect(fileRes.ok).toBe(false);
  });

  it('refuses duplicate project paths', () => {
    addProject({ name: 'Alpha', path: fakeProjectDir1 });
    const duplicate = addProject({ name: 'Alpha 2', path: fakeProjectDir1 });
    expect(duplicate.ok).toBe(false);
  });

  it('updates project name and path', () => {
    const added = addProject({ name: 'Alpha', path: fakeProjectDir1 });
    if (!added.ok) throw new Error('add failed');

    const updated = updateProject(added.project.id, {
      name: 'Alpha Renamed',
      path: fakeProjectDir2,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    expect(updated.project.name).toBe('Alpha Renamed');
    expect(path.resolve(updated.project.path)).toBe(path.resolve(fakeProjectDir2));

    const check = getProject(added.project.id);
    expect(check?.name).toBe('Alpha Renamed');
  });

  it('deletes a project and updates activeId', () => {
    const p1 = addProject({ name: 'Alpha', path: fakeProjectDir1 });
    const p2 = addProject({ name: 'Beta', path: fakeProjectDir2 });
    if (!p1.ok || !p2.ok) throw new Error('add failed');

    expect(readProjects().activeId).toBe(p1.project.id);

    const del = deleteProject(p1.project.id);
    expect(del.ok).toBe(true);

    const data = readProjects();
    expect(data.projects.length).toBe(1);
    expect(data.activeId).toBe(p2.project.id);
  });

  it('exposes REST endpoints for projects', async () => {
    const app = fastify({ logger: false });
    registerProjectRoutes(app);

    // List empty
    const listRes1 = await app.inject({ method: 'GET', url: '/api/admin/projects' });
    expect(listRes1.statusCode).toBe(200);
    expect(listRes1.json()).toEqual({ status: 'ok', activeId: null, projects: [] });

    // Validate path
    const valRes = await app.inject({
      method: 'POST',
      url: '/api/admin/projects/validate-path',
      payload: { path: fakeProjectDir1 },
    });
    expect(valRes.statusCode).toBe(200);
    expect(valRes.json().status).toBe('ok');

    // Create
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/admin/projects',
      payload: { name: 'Alpha', path: fakeProjectDir1 },
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json() as { status: string; project: { id: string; name: string } };
    expect(created.status).toBe('ok');
    expect(created.project.name).toBe('Alpha');

    // Set active
    const activeRes = await app.inject({
      method: 'POST',
      url: '/api/admin/projects/active',
      payload: { id: created.project.id },
    });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().activeId).toBe(created.project.id);

    // Delete
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/admin/projects/${created.project.id}`,
    });
    expect(delRes.statusCode).toBe(200);
  });
});

