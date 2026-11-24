/** Returns the value it was given. */
export function documented(value: string): string {
  return value;
}

export function parseWidget(name: string): { id: string } {
  return { id: name.trim().toLowerCase() };
}

export function orphanApi(): string {
  return "orphan";
}
