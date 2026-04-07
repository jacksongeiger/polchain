export const ADMIN_API = import.meta.env.VITE_ADMIN_API ?? "http://localhost:3001";
export const PROVE_SERVER = import.meta.env.VITE_PROVE_SERVER ?? "http://localhost:5001";

// ---------------------------------------------------------------------------
// Runtime contract address resolution
//
// The single source of truth for deployed addresses lives in
// server/addresses.json on the admin server. The frontend fetches it via
// GET /api/addresses on every page load (and again on CALL_EXCEPTION) so
// the UI auto-recovers when TaskManager is redeployed without a refresh.
//
// localStorage is used as a last-resort fallback if the admin server is
// unreachable on initial load.
// ---------------------------------------------------------------------------

const ADDRESS_CACHE_KEY = "polchain_addresses_v1";

/**
 * Fetch live addresses from the admin server. On success, caches to
 * localStorage. On failure, falls back to the cached value. Returns null
 * if both the API and the cache are unavailable.
 */
export async function fetchAddresses() {
  try {
    const r = await fetch(`${ADMIN_API}/api/addresses`, {
      signal: AbortSignal.timeout(5000),
      cache:  "no-store",
    });
    if (r.ok) {
      const data = await r.json();
      if (data && data.TaskManagerAdvanced && data.TaskManagerBasic) {
        try { localStorage.setItem(ADDRESS_CACHE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
        return data;
      }
    }
  } catch { /* fall through to cache */ }

  try {
    const cached = localStorage.getItem(ADDRESS_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch { /* ignore */ }

  return null;
}

/** Pick the right TaskManager from a fetched addresses object based on mode. */
export function pickTaskManager(addresses, mode) {
  if (!addresses) return null;
  return mode === "basic" ? addresses.TaskManagerBasic : addresses.TaskManagerAdvanced;
}
