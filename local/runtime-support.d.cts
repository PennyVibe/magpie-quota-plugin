export function atLeast(value: unknown, minimum: number[]): boolean;
export function compatibleRuntime(platform: string, runtime: { node?: unknown; uv?: unknown } | null | undefined): boolean;
export function runtimeRequirement(platform: string): string;
