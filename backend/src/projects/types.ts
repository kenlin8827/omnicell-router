export interface ProjectItem {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectsFile {
  version: 1;
  activeId: string | null;
  projects: ProjectItem[];
}

