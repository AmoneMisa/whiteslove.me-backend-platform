// Pagination of curated custom-source catalogues. Pure helpers, kept apart from
// queueTasks.js so they can be tested without loading the scraping stack.

const CUSTOM_QUEUE_MAX_PAGES = Math.max(
  1,
  Number(process.env.CUSTOM_SOURCE_MAX_PAGES) || 20,
);

// Page 1 is the catalogue URL exactly as declared; later pages add a query
// parameter (`page` unless the source declares another one).
export function customPageUrl(sourceUrl, page, pageParam) {
  if (page <= 1) return sourceUrl;
  const url = new URL(sourceUrl);
  url.searchParams.set(String(pageParam || 'page'), String(page));
  return url.href;
}

// A catalogue whose page N repeats page N-1 ignores the page parameter (or has
// run out), so the chain stops as soon as a page brings no listing the
// previous one did not already have.
export function nextCustomPageTask(task, page, listings) {
  const keys = [...new Set(
    (listings || []).map((listing) => String(listing?.url || listing?.id || '')).filter(Boolean),
  )];
  const previous = new Set(Array.isArray(task.pageKeys) ? task.pageKeys : []);
  const maxPages = Math.min(
    CUSTOM_QUEUE_MAX_PAGES,
    Math.max(1, Math.trunc(Number(task.maxPages)) || CUSTOM_QUEUE_MAX_PAGES),
  );
  if (!keys.length || page >= maxPages) return null;
  if (page > 1 && keys.every((key) => previous.has(key))) return null;

  return {
    ...task,
    page: page + 1,
    pageKeys: keys.slice(0, 200),
  };
}
