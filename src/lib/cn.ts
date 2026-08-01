/** Joins class names, dropping falsy values. Deliberately tiny — no runtime dependency. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
