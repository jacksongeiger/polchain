import { ADDRESSES as BUILD_TIME_ADDRESSES } from "./contracts";

export const ADMIN_API = import.meta.env.VITE_ADMIN_API ?? "http://localhost:3001";
export const PROVE_SERVER = import.meta.env.VITE_PROVE_SERVER ?? "http://localhost:5001";

// ---------------------------------------------------------------------------
// Contract address resolution — three-tier fallback
//
//   1. Live fetch:  GET /api/addresses on the admin server (always preferred)
//   2. localStorage cache from a prior successful fetch
//   3. Build-time bundled server/addresses.json (compiled into the JS bundle)
//
// The frontend NEVER blocks on the network — components initialize their
// addresses state synchronously with `BUILD_TIME_ADDRESSES`, then call
// `fetchAddresses()` to upgrade to live values. If the admin server is down
// the UI keeps working with the bundled values.
// ---------------------------------------------------------------------------

export { BUILD_TIME_ADDRESSES };

const ADDRESS_CACHE_KEY = "polchain_addresses_v1";

function isValid(a) {
  return a && a.TaskManagerAdvanced && a.TaskManagerBasic && a.POLToken;
}

/**
 * Fetch live addresses from the admin server. On success, caches to
 * localStorage. Falls back to the cached value, then to the build-time
 * bundled values. Always returns a usable addresses object — never null.
 */
export async function fetchAddresses() {
  try {
    const r = await fetch(`${ADMIN_API}/api/addresses`, {
      signal: AbortSignal.timeout(5000),
      cache:  "no-store",
    });
    if (r.ok) {
      const data = await r.json();
      if (isValid(data)) {
        try { localStorage.setItem(ADDRESS_CACHE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
        return data;
      }
    }
  } catch { /* fall through */ }

  try {
    const cached = localStorage.getItem(ADDRESS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (isValid(parsed)) return parsed;
    }
  } catch { /* ignore */ }

  return BUILD_TIME_ADDRESSES;
}

/** Pick the right TaskManager from a fetched addresses object based on mode. */
export function pickTaskManager(addresses, mode) {
  if (!addresses) return null;
  return mode === "basic" ? addresses.TaskManagerBasic : addresses.TaskManagerAdvanced;
}
