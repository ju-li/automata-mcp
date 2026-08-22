import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * `@/lib/utils` is pinned by components.json — shadcn-vue components import
 * `cn` from here. Do not move it.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
