const WISP_API    = Deno.env.get("WISP_API_URL") ?? "https://wisp.place";
const HYDRANT_BIN = Deno.env.get("HYDRANT_BIN") ?? "hydrant";
const PORT        = parseInt(Deno.env.get("PORT") ?? "8080");
const KV_PATH     = Deno.env.get("KV_PATH") ?? "random-wisp-place.kv";
const CURSOR      = Deno.env.get("CURSOR");

const getFreePort = () => {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
};

const HYDRANT_PORT = getFreePort();
const HYDRANT_URL  = `http://localhost:${HYDRANT_PORT}`;

const FS_COLLECTION = "place.wisp.fs";

type SiteValue = {
  fallbackUrl: string;
  domains: string[];
  lastScanned: number;
};

type HydrantRecord  = {
  readonly type: "record";
  readonly id: number;
  readonly record: {
    readonly did: string;
    readonly collection: string;
    readonly rkey: string;
    readonly action: "create" | "update" | "delete";
  };
};

type HydrantEvent = HydrantRecord | { readonly type: "identity" | "account" };

const siteKey  = (did: string, siteName: string) => ["sites", did, siteName] as const;
const cursorKey = ()                             => ["cursor"] as const;

const fallbackUrl = (did: string, siteName: string): string =>
  `https://sites.wisp.place/${did}/${siteName}`;

const resolveUrl = (site: SiteValue): string => {
  if (site.domains.length > 0) {
    return `https://${site.domains[Math.floor(Math.random() * site.domains.length)]}/`;
  }
  return site.fallbackUrl;
};

const kv = await Deno.openKv(KV_PATH);

if (CURSOR) await kv.set(cursorKey(), parseInt(CURSOR));

const allSiteEntries = async (): Promise<Map<Deno.KvKey, SiteValue>> => {
  const map = new Map<Deno.KvKey, SiteValue>();
  for await (const entry of kv.list<SiteValue>({ prefix: ["sites"] })) {
    map.set(entry.key, entry.value);
  }
  return map;
};

const fetchSiteDomains = async (did: string, rkey: string): Promise<string[]> => {
  const url = new URL(`${WISP_API}/xrpc/place.wisp.v2.site.getDomains`);
  url.searchParams.set("did", did);
  url.searchParams.set("rkey", rkey);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return [];
    const data = await res.json() as { domains: Array<{ domain: string; kind: string; verified: boolean }> };
    return data.domains
      .filter((d) => d.verified)
      .map((d) => d.domain);
  } catch {
    return [];
  }
};

const handleFsEvent = async (
  did: string,
  rkey: string,
  action: "create" | "update" | "delete",
): Promise<void> => {
  const key = siteKey(did, rkey);

  if (action === "delete") {
    await kv.delete(key);
    console.log(`[-] fs  ${did}:${rkey}`);
    return;
  }

  const domains = await fetchSiteDomains(did, rkey);
  await kv.set(key, {
    fallbackUrl: fallbackUrl(did, rkey),
    domains,
    lastScanned: Date.now(),
  });
  console.log(`[+] fs  ${action}  ${did}:${rkey}  (${domains.length} domains)`);
};

const handleEvent = async (raw: string): Promise<void> => {
  let event: HydrantEvent;
  try { event = JSON.parse(raw) as HydrantEvent; }
  catch { return; }
  if (event.type !== "record") return;

  const { did, collection, rkey, action } = event.record;
  await kv.set(cursorKey(), event.id);

  if (collection === FS_COLLECTION) {
    await handleFsEvent(did, rkey, action);
  }
};

const connectToHydrant = async (cursor?: number): Promise<void> => {
  const wsUrl = new URL(`${HYDRANT_URL.replace(/^http/, "ws")}/stream`);
  if (cursor !== undefined) wsUrl.searchParams.set("cursor", String(cursor));

  console.log(`[?] connecting to hydrant: ${wsUrl}`);
  const ws = new WebSocket(wsUrl.toString());

  ws.onopen    = () => console.log("[?] hydrant stream connected");
  ws.onmessage = ({ data }) => { handleEvent(String(data)).catch(console.error); };
  ws.onerror   = (e) => console.error("[!] ws error:", e);
  ws.onclose   = async () => {
    const saved = (await kv.get<number>(cursorKey())).value ?? undefined;
    console.log(`[!] ws closed (cursor=${saved ?? "none"}), reconnecting in 5s...`);
    setTimeout(() => connectToHydrant(saved), 5_000);
  };
};

const isReachable = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    return res.status !== 404;
  } catch {
    return false;
  }
};

const PROBE_BATCH = 10;
const STALE_MS = 60 * 60 * 1000; // 1 hour

const refreshIfStale = async (entry: { key: Deno.KvKey; value: SiteValue }): Promise<SiteValue> => {
  const { key, value } = entry;
  if (Date.now() - value.lastScanned < STALE_MS) return value;

  // extract did and siteName from key ["sites", did, siteName]
  const did = key[1] as string;
  const siteName = key[2] as string;
  const domains = await fetchSiteDomains(did, siteName);
  const updated: SiteValue = { ...value, domains, lastScanned: Date.now() };
  await kv.set(key, updated);
  return updated;
};

const pickRandomReachable = async (sites: Map<Deno.KvKey, SiteValue>): Promise<SiteValue | null> => {
  const entries = [...sites.entries()].sort(() => Math.random() - 0.5);
  for (let i = 0; i < entries.length; i += PROBE_BATCH) {
    const batch = entries.slice(i, i + PROBE_BATCH);
    const results = await Promise.all(
      batch.map(async ([key, site]) => {
        const refreshed = await refreshIfStale({ key, value: site });
        return { site: refreshed, ok: await isReachable(resolveUrl(refreshed)) };
      })
    );
    const found = results.find((r) => r.ok);
    if (found) return found.site;
  }
  return null;
};

const corsHeaders = {
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
  }
};
Deno.serve({ port: PORT }, async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, ...corsHeaders });
  }

  const { pathname } = new URL(req.url);

  if (pathname === "/health") {
    const entries = await allSiteEntries();
    const data = {
      total: entries.size,
      withDomain: [...entries.values()].filter((s) => s.domains.length > 0).length,
    };
    return Response.json(data, corsHeaders);
  }

  const site = await pickRandomReachable(await allSiteEntries());
  return site
    ? Response.json(site, corsHeaders)
    : new Response(
        "no sites discovered yet, try again later",
        { status: 503, ...corsHeaders },
      );
});
console.log(`[?] listening on :${PORT}`);

console.log(`[?] starting hydrant on :${HYDRANT_PORT}...`);
try {
  const conf = (name: string, value: string) => Deno.env.set(`HYDRANT_${name}`, value);
  conf("API_PORT", `${HYDRANT_PORT}`);
  conf("ENABLE_CRAWLER", "true");
  conf("FILTER_SIGNALS", [FS_COLLECTION]);
  conf("FILTER_COLLECTIONS", [FS_COLLECTION].join(","));
  conf("PLC_URL", "https://plc.directory");
  conf("ENABLE_DEBUG", "true");

  const cmd = new Deno.Command(HYDRANT_BIN, {
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();

  const cleanup = () => {
    console.log("[?] shutting down hydrant...");
    child.kill("SIGTERM");
    Deno.exit();
  };

  Deno.addSignalListener("SIGTERM", cleanup);
  Deno.addSignalListener("SIGINT", cleanup);

  child.status.then((status) => {
    console.error(`[!] hydrant process exited with code ${status.code}`);
    Deno.exit(1);
  });
} catch (e) {
  console.error(`[!] failed to start hydrant: ${e.message}`);
  Deno.exit(2);
}

const savedCursor = (await kv.get<number>(cursorKey())).value ?? undefined;
console.log(`[?] resuming from cursor ${savedCursor ?? "start (0)"}`);
connectToHydrant(savedCursor ?? 0);
