# random.wisp.place

visit [random.wisp.place](https://random.wisp.place) and you'll be redirected to a random [wisp.place](https://wisp.place) site. under the hood, a [hydrant](https://tangled.org/did:plc:dfl62fgb7wtjj3fcbb72naae/hydrant) instance indexes `place.wisp.fs` and `place.wisp.domain` records from the network, keeping a database of known sites, allowing the backend to pick a random website to redirect you to.

custom domains are resolved via the wisp.place domain API and kept in sync as records are created or deleted.

you can inspect the deployed backend instance at `https://wisp-random.ptr.pet`.

## running

```sh
deno task dev
```

environment variables:

| variable | default | description |
| :--- | :--- | :--- |
| `PORT` | `8080` | port to listen on |
| `WISP_API_URL` | `https://wisp.place` | wisp.place appview base URL |
| `HYDRANT_BIN` | `hydrant` | path to the hydrant binary |
| `KV_PATH` | `random-wisp-place.kv` | deno KV database path |

## building the frontend

```sh
API_URL=https://example.org deno task build
```

outputs to `dist/`.
