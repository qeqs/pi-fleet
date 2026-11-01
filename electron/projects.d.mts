export function readProjects(file: string): string[];
export function rememberProject(file: string, dir: string): string[];
export function needsTrust(file: string, dir: string, exists?: (p: string) => boolean): boolean;
export function startingProject(file: string, exists?: (dir: string) => boolean): string | null;
