import { useEffect, useState } from 'react';

/**
 * Whether the viewport is too narrow for a chart to be drawn.
 *
 * The charts themselves disappear below 360px in CSS — `hidden
 * min-[360px]:block` — because a chart that narrow is unreadable. That leaves
 * the exact table as the only presentation of the figures at that width, which
 * is what both chart regions say they rely on.
 *
 * CSS knows the viewport and React does not, so the disclosure holding that
 * table had no way to know it had become the presentation rather than an
 * alternative to one, and stayed shut. The result was a width at which the page
 * showed a heading, a sentence, and nothing else — the chart hidden as
 * unreadable and the table hidden behind a control. Reading the same breakpoint
 * into state is what keeps the two halves of the substitution in agreement.
 *
 * `BREAKPOINT` is the `min-[360px]` utility restated once here. It is duplicated
 * from a Tailwind class either way; naming it at least makes the duplication
 * visible, and `chartComponents.test.tsx` pins the behaviour rather than the
 * number.
 *
 * Defaults to *not* hidden when `matchMedia` is unavailable, which keeps the
 * disclosure closed by default — the pre-existing behaviour — in any
 * environment that cannot report the width.
 */
const BREAKPOINT = '(max-width: 359.98px)';

export function useChartsHidden(): boolean {
  const [hidden, setHidden] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(BREAKPOINT).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(BREAKPOINT);
    const update = () => setHidden(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return hidden;
}
