# HTTPS reverse proxy

Place an intranet certificate and its private key outside source control, then
set `TLS_CERT_DIR` to that directory before starting Compose. Nginx expects:

- `tls.crt`: the server certificate followed by any intermediate certificates;
- `tls.key`: the matching private key, readable only by the Docker service.

The checked-in `certs` directory is only a mount point. Never commit a real
certificate private key. HTTP is redirected to HTTPS, login requests are rate
limited, and the proxy forwards a generated request ID to the application.

