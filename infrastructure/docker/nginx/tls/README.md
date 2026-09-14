# Web tier TLS

`docker-compose.production.yml` mounts this directory read-only at
`/etc/nginx/tls` in the `web` container, and into no other service. nginx
(`../web-tls.conf`) reads two files:

| File | Contents |
|---|---|
| `fullchain.pem` | the server certificate, then any intermediates |
| `privkey.pem` | its private key — readable by the deploying user only (`chmod 600`) |

Both are ignored by git. Until they exist, the `web` container fails to start;
there is no plaintext fallback on 443.

The certificate must name the host students type into a browser, which is also
`PUBLIC_ORIGIN`. Who issues it, how it is renewed, and what alerts before it
expires are open decisions — see `docs/runtime-architecture.md` §11.7. nginx
reads the files at startup, so a renewed certificate takes
`docker compose exec web nginx -s reload`.
