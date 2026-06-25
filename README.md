# bolboloxy

A VLESS-over-WebSocket proxy that runs on Cloudflare Workers. It accepts VLESS connections over a WebSocket path and forwards the inner TCP stream to the target destination, with optional SOCKS5 routing.

## How It Works

1. A client connects to `wss://<worker>/<path>` via WebSocket.
2. The first message contains a VLESS header with:

   * Target address
   * Target port
   * UUID for authentication
3. The worker validates the UUID, extracts the destination, and opens a TCP connection (directly or through a SOCKS5 proxy).
4. All subsequent WebSocket messages are relayed as raw TCP data between the client and the destination.

## Configuration

Create a `wrangler.toml` file:

```toml
name = "bolboloxy"
main = "src/worker.js"
compatibility_date = "2024-06-25"

[vars]
UUID = "your-uuid-here"
WS_PATH = "/ws"

SOCKS5_ENABLED = "false"
SOCKS5_HOST = "127.0.0.1"
SOCKS5_PORT = "1080"
SOCKS5_USER = ""
SOCKS5_PASS = ""
```

### Environment Variables

| Variable         | Required | Default                       | Description                                                    |
| ---------------- | -------- | ----------------------------- | -------------------------------------------------------------- |
| `UUID`           | Yes      | —                             | VLESS UUID used for authentication                             |
| `WS_PATH`        | No       | `/ws`                         | WebSocket path to listen on                                    |
| `SOCKS5_ENABLED` | No       | `false`                       | Routes outbound TCP through a SOCKS5 proxy                     |
| `SOCKS5_HOST`    | No       | `127.0.0.1`                   | SOCKS5 proxy hostname or IP                                    |
| `SOCKS5_PORT`    | No       | `1080`                        | SOCKS5 proxy port                                              |
| `SOCKS5_USER`    | No       | `bolbol`                      | SOCKS5 username (leave empty if no authentication is required) |
| `SOCKS5_PASS`    | No       | `your_secure_bolbol_password` | SOCKS5 password                                                |

## Deploy

```bash
npx wrangler deploy
```

## Landing Page

Requests to any path other than the configured `WS_PATH` return a simple HTML status page.

## SOCKS5 Support

When `SOCKS5_ENABLED` is set to `true`, the worker connects to the target destination through the specified SOCKS5 proxy.

### Features

* SOCKS5 `CONNECT` support
* Optional username/password authentication (RFC 1929)
* Supports IPv4, IPv6, and domain name destinations

This is useful when outbound connections must exit through a specific IP address, network, or gateway rather than being routed directly.

## Cloudflare Anycast Edge Behavior

Because this service runs on Cloudflare Workers, it is accessible via the Cloudflare Anycast network.

Any Cloudflare edge IP may be used as a transport endpoint, provided that TLS SNI headers correctly resolve to the deployed Worker domain.

## Limitations

* Cloudflare Workers enforce CPU and execution limits. Long-lived or high-throughput connections may be interrupted.
* Traffic is limited to VLESS over WebSocket.

## License

GPL-3.0-only