import { useEffect } from 'react';

const SITE_NAME = 'Tri-State Spending Lens';

/**
 * Sets the document title for a route.
 *
 * Titles are static route names only. privacy-model.md §2 forbids personal
 * transaction data from appearing in page titles, so nothing derived from a
 * user's data may ever be passed here.
 */
export function useDocumentTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
  }, [title]);
}
