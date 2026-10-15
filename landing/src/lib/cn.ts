import { type ClassValue, clsx } from "clsx";

/** Joins class names. Callers add classes; they never need to override one. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
