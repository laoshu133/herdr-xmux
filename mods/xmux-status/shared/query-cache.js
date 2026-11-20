// Generated from lib/xmux/query-cache.js. Run node scripts/sync-common.mjs.
import { shared, setShared } from "herdr";

// Per-runtime promises coalesce concurrent reads. Small metadata results are
// also shared across mod runtimes; private API payloads stay in memory.
const values = new Map();
const flights = new Map();
const STORE = "xmux.query-metadata.v1";
const LIMIT = 96;
const MAX_SHARED = 32000;
let pause;

export function configureQueries(cx) {
  pause = (ms) => new Promise((resolve) => cx.timer.after(ms, resolve));
}

function trim() {
  while (values.size > LIMIT) values.delete(values.keys().next().value);
}

function publish(key, entry) {
  const all = shared(STORE) ?? {};
  const ordered = Object.entries({ ...all, [key]: entry }).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
  setShared(STORE, Object.fromEntries(ordered.slice(0, 48)));
}

export function peekQuery(key, ttl = Infinity) {
  const entry = values.get(key);
  return entry?.data !== undefined && Date.now() - entry.at < ttl ? entry.data : undefined;
}

export function invalidateQueries(test = () => true) {
  for (const key of values.keys()) if (test(key)) values.delete(key);
  const all = shared(STORE) ?? {};
  const kept = Object.fromEntries(Object.entries(all).filter(([key]) => !test(key)));
  if (Object.keys(all).length !== Object.keys(kept).length) setShared(STORE, kept);
  // A pending read may finish after a write. It must not repopulate the cache.
  for (const [key, flight] of flights) if (test(key)) flight.valid = false;
}

export function cachedQuery(key, ttl, load, { force = false, share = false } = {}) {
  const pending = flights.get(key);
  if (pending?.valid) return pending.promise;
  const entry = values.get(key) ?? (share ? shared(STORE)?.[key] : null);
  if (!force && entry?.data !== undefined && Date.now() - entry.at < ttl) return Promise.resolve(entry.data);
  if (!force && entry?.retryAt > Date.now()) return Promise.reject(new Error(entry.error));
  const flight = { valid: true };
  flight.promise = Promise.resolve().then(async () => {
    const owner = `${Date.now()}-${Math.random()}`;
    try {
      if (share && pause) {
        // A reloaded owner expires; another runtime can then recover the read.
        let lease = shared(STORE)?.[key];
        while (lease?.owner && lease.until > Date.now()) {
          await pause(80);
          const next = shared(STORE)?.[key];
          if (next?.data !== undefined && next.at >= (lease.started ?? 0)) return next.data;
          if (next?.retryAt > Date.now()) throw new Error(next.error);
          lease = next;
        }
      }
      if (share && flight.valid) publish(key, { ...entry, owner, started: Date.now(), until: Date.now() + 35000 });
      const data = await load();
      if (flight.valid) {
        const next = { data, at: Date.now() };
        values.delete(key);
        values.set(key, next);
        trim();
        if (share && shared(STORE)?.[key]?.owner === owner) {
          // Always release the lease, even for a result too large to share.
          publish(key, JSON.stringify(data ?? null).length < MAX_SHARED ? next : { at: 0 });
        }
      }
      return data;
    } catch (error) {
      if (flight.valid) {
        const failures = (entry?.failures ?? 0) + 1;
        const next = { ...entry, error: String(error.message ?? error), failures,
          retryAt: Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures - 1, 4)) };
        delete next.owner;
        delete next.until;
        values.set(key, next);
        trim();
        if (share && shared(STORE)?.[key]?.owner === owner) publish(key, next);
      }
      throw error;
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  });
  flights.set(key, flight);
  return flight.promise;
}

export function panelShown(node, mod) {
  if (!node || node.hidden) return false;
  if (node.content?.mod === mod) return true;
  const children = node.children ?? [];
  return node.type === "stack"
    ? panelShown(children.find((c) => c.id === node.active) ?? children[0], mod)
    : children.some((c) => panelShown(c, mod));
}

// Object insertion order must not cause duplicate CLI/API reads.
export function queryKey(value) {
  const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, stable(v[k])])) : v;
  return JSON.stringify(stable(value));
}
