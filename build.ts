const html = await Deno.readTextFile("redirect.html");
const url = Deno.env.get("API_URL") ?? "/";
await Deno.writeTextFile("redirect.out.html", html.replaceAll("__API_URL__", url));
