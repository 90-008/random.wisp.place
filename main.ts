const WISP_API    = Deno.env.get("WISP_API_URL") ?? "https://wisp.place";
const HYDRANT_BIN = Deno.env.get("HYDRANT_BIN") ?? "hydrant";
const PORT        = parseInt(Deno.env.get("PORT") ?? "8080");
const KV_PATH     = Deno.env.get("KV_PATH") ?? "random-wisp-place.kv";

const getFreePort = () => {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
};

const HYDRANT_PORT = getFreePort();
const HYDRANT_URL  = `http://localhost:${HYDRANT_PORT}`;

const FS_COLLECTION     = "place.wisp.fs";
const DOMAIN_COLLECTION = "place.wisp.domain";

type SiteValue = {
  fallbackUrl: string;
  domainUrl: string | null;
};

// secondary index: domain -> site key components
type DomainIndexValue = {
  did: string;
  siteName: string;
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

type DomainRegistered = {
  readonly registered: true;
  readonly type: "wisp" | "custom";
  readonly domain: string;
  readonly did: string;
  readonly rkey: string | null;
};

type DomainStatus = DomainRegistered | { readonly registered: false };

const siteKey  = (did: string, siteName: string) => ["sites", did, siteName] as const;
const domainKey = (domain: string)               => ["domain_idx", domain] as const;
const cursorKey = ()                             => ["cursor"] as const;

const fallbackUrl = (did: string, siteName: string): string =>
  `https://sites.wisp.place/${did}/${siteName}`;
const resolveUrl = (site: SiteValue): string =>
  site.domainUrl ?? site.fallbackUrl;

const kv = await Deno.openKv(KV_PATH);

const allSites = async (): Promise<SiteValue[]> => {
  const entries: SiteValue[] = [];
  for await (const entry of kv.list<SiteValue>({ prefix: ["sites"] })) {
    entries.push(entry.value);
  }
  return entries;
};

const queryDomainRegistered = async (domain: string): Promise<DomainStatus | null> => {
  const url = new URL(`${WISP_API}/api/domain/registered`);
  url.searchParams.set("domain", domain);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.ok ? await res.json() as DomainStatus : null;
  } catch {
    return null;
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

  // preserve existing domainUrl on upsert
  const existing = await kv.get<SiteValue>(key);
  await kv.set(key, {
    fallbackUrl: fallbackUrl(did, rkey),
    domainUrl: existing.value?.domainUrl ?? null,
  });
  console.log(`[+] fs  ${action}  ${did}:${rkey}`);
};

const handleDomainEvent = async (
  _did: string,
  rkey: string,
  action: "create" | "update" | "delete",
): Promise<void> => {
  // rkey is the subdomain label e.g. "alice" -> alice.wisp.place
  const domain = `${rkey}.wisp.place`;
  const dKey = domainKey(domain);

  if (action === "delete") {
    const idx = await kv.get<DomainIndexValue>(dKey);
    if (idx.value) {
      const sKey = siteKey(idx.value.did, idx.value.siteName);
      const site = await kv.get<SiteValue>(sKey);
      if (site.value) {
        await kv.set(sKey, { ...site.value, domainUrl: null });
      }
    }
    await kv.delete(dKey);
    console.log(`[-] domain  ${domain}  unlinked`);
    return;
  }

  const status = await queryDomainRegistered(domain);
  if (!status?.registered || !status.rkey) {
    console.warn(`[!] domain ${domain}: not registered, no site mapped, or api error`);
    return;
  }

  const domainUrl = `https://${status.domain}/`;
  const sKey = siteKey(status.did, status.rkey);

  // update or pre-create the site row with the resolved domainUrl
  const existing = await kv.get<SiteValue>(sKey);
  await kv.atomic()
    .set(sKey, {
      fallbackUrl: existing.value?.fallbackUrl ?? fallbackUrl(status.did, status.rkey),
      domainUrl,
    })
    .set(dKey, { did: status.did, siteName: status.rkey } satisfies DomainIndexValue)
    .commit();

  console.log(`[+] domain  ${domain}  -> ${status.did}:${status.rkey}  (${status.type})`);
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
  } else if (collection === DOMAIN_COLLECTION) {
    await handleDomainEvent(did, rkey, action);
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
const pickRandomReachable = async (sites: SiteValue[]): Promise<SiteValue | null> => {
  const shuffled = [...sites].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length; i += PROBE_BATCH) {
    const batch = shuffled.slice(i, i + PROBE_BATCH);
    const results = await Promise.all(
      batch.map(async (site) => ({ site, ok: await isReachable(resolveUrl(site)) }))
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
    const sites = await allSites();
    const data = {
      total: sites.length,
      withDomain: sites.filter((s) => s.domainUrl).length,
    };
    return Response.json(data, corsHeaders);
  }

  const site = await pickRandomReachable(await allSites());
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
  conf("FILTER_COLLECTIONS", [FS_COLLECTION, DOMAIN_COLLECTION].join(","));
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
