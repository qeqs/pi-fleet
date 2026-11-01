export function readProjects(file: string): string[];
export function rememberProject(file: string, dir: string): string[];
export function startingProject(file: string, exists?: (dir: string) => boolean): string | null;
