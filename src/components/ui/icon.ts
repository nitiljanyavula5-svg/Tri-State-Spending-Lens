import type { ComponentType } from 'react';

/**
 * Structural icon type. Declared locally rather than importing `LucideIcon`
 * so the UI primitives do not depend on one icon library's export surface.
 */
export type IconComponent = ComponentType<{
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}>;
