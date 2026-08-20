import { useEffect, useState } from 'react';

/**
 * Whether the viewer has asked for reduced motion.
 *
 * Recharts animates on mount by default. That animation is decorative — every
 * datum is also in the fallback table — so honouring the preference costs
 * nothing, and ignoring it would make the one moving thing on the page the one
 * thing a motion-sensitive reader cannot avoid.
 *
 * Defaults to reduced when `matchMedia` is unavailable: a still chart is never
 * the wrong answer, and an environment that cannot report the preference is
 * exactly where guessing "animate" would be least defensible.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}
