declare module "*adapter.mjs" {
  export const hostFiles: string[];
  export function adaptSources(files: Record<string, string>): Record<string, string>;
}
