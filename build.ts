const html = await Deno.readTextFile("index.html");
const url = Deno.env.get("API_URL") ?? "/";
await Deno.remove("dist", { recursive: true }).catch(() => {});
await Deno.mkdir("dist");
await Deno.writeTextFile("dist/index.html", html.replaceAll("__API_URL__", url));
