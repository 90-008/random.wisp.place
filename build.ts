const html = await Deno.readTextFile("redirect.html");
const url = Deno.env.get("API_URL") ?? "/";
await Deno.remove("dist", { recursive: true }).catch(() => {});
await Deno.mkdir("dist");
await Deno.writeTextFile("dist/redirect.html", html.replaceAll("__API_URL__", url));
