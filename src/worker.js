import { connect } from "cloudflare:sockets";

function parseVless(data) {
  if (data.length < 24) return { error: true };
  if (data[0] !== 0) return { error: true };

  const uuidBytes = data.slice(1, 17);
  const uuidHex = Array.from(uuidBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const uuid = [
    uuidHex.substring(0, 8),
    uuidHex.substring(8, 12),
    uuidHex.substring(12, 16),
    uuidHex.substring(16, 20),
    uuidHex.substring(20, 32)
  ].join('-');

  const port = (data[19] << 8) | data[20];
  const addrType = data[21];

  let addr;
  let pos = 22;

  if (addrType === 1) {
    addr = `${data[22]}.${data[23]}.${data[24]}.${data[25]}`;
    pos = 26;
  } else if (addrType === 2) {
    const len = data[22];
    addr = new TextDecoder().decode(data.slice(23, 23 + len));
    pos = 23 + len;
  } else if (addrType === 3) {
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(((data[22 + i * 2] << 8) | data[23 + i * 2]).toString(16));
    }
    addr = parts.join(':');
    pos = 38;
  } else {
    return { error: true };
  }

  return { uuid, addr, port, headerLen: pos };
}

function getConfig(env) {
  return {
    path: env.WS_PATH || "/ws",
    socks5: {
      enabled: env.SOCKS5_ENABLED === "true",
      host: env.SOCKS5_HOST || "127.0.0.1",
      port: parseInt(env.SOCKS5_PORT || "1080"),
      username: env.SOCKS5_USER || "",
      password: env.SOCKS5_PASS || ""
    }
  };
}

async function connectViaSOCKS5(targetHost, targetPort, config) {
  const { host, port, username, password } = config.socks5;
  const hasAuth = username && password;
  
  const socket = connect({ hostname: host, port });
  await socket.opened; // Ensure the socket is formally established

  const rawReader = socket.readable.getReader();
  const writer = socket.writable.getWriter();

  let buffer = new Uint8Array(0);

  async function readBytes(count) {
    while (buffer.length < count) {
      const { done, value } = await rawReader.read();
      if (done) throw new Error("SOCKS5 connection closed");
      const newBuf = new Uint8Array(buffer.length + value.length);
      newBuf.set(buffer, 0);
      newBuf.set(value, buffer.length);
      buffer = newBuf;
    }
    const result = buffer.slice(0, count);
    buffer = buffer.slice(count);
    return result;
  }

  try {
    // 1. Greeting
    if (hasAuth) {
      await writer.write(new Uint8Array([5, 2, 0, 2]));
    } else {
      await writer.write(new Uint8Array([5, 1, 0]));
    }
    
    // 2. Server method selection
    const choice = await readBytes(2);
    if (choice[0] !== 5) throw new Error("Invalid SOCKS version");
    
    if (hasAuth) {
      if (choice[1] === 2) {
        const userBytes = new TextEncoder().encode(username);
        const passBytes = new TextEncoder().encode(password);
        
        const authMsg = new Uint8Array(3 + userBytes.length + passBytes.length);
        authMsg[0] = 1;
        authMsg[1] = userBytes.length;
        authMsg.set(userBytes, 2);
        authMsg[2 + userBytes.length] = passBytes.length;
        authMsg.set(passBytes, 3 + userBytes.length);
        
        await writer.write(authMsg);
        
        const authResult = await readBytes(2);
        if (authResult[1] !== 0) {
          throw new Error("SOCKS5 authentication failed");
        }
      } else if (choice[1] !== 0) {
        throw new Error(`SOCKS5 unsupported auth method: ${choice[1]}`);
      }
    } else {
      if (choice[1] !== 0) throw new Error("SOCKS5 auth required but not configured");
    }

    // 3. Connect request
    const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(targetHost);
    const isIPv6 = targetHost.includes(':');
    
    let addrType, addrBytes;
    
    if (isIPv4) {
      addrType = 1;
      addrBytes = targetHost.split('.').map(Number);
    } else if (isIPv6) {
      addrType = 4;
      const parts = targetHost.split(':');
      const expandedParts = [];
      let emptyIndex = -1;
      
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '') { emptyIndex = i; break; }
      }
      
      if (emptyIndex !== -1) {
        const fillCount = 8 - (parts.length - 1);
        for (let i = 0; i < emptyIndex; i++) expandedParts.push(parts[i]);
        for (let i = 0; i < fillCount; i++) expandedParts.push('0');
        for (let i = emptyIndex + 1; i < parts.length; i++) {
          if (parts[i] !== '') expandedParts.push(parts[i]);
        }
      } else {
        expandedParts.push(...parts);
      }
      
      addrBytes = [];
      for (const part of expandedParts) {
        const val = parseInt(part || '0', 16);
        addrBytes.push((val >> 8) & 0xFF, val & 0xFF);
      }
    } else {
      addrType = 3;
      addrBytes = new TextEncoder().encode(targetHost);
    }

    const request = new Uint8Array(
      addrType === 3 ? 7 + addrBytes.length : addrType === 1 ? 10 : 22
    );
    
    request[0] = 5; request[1] = 1; request[2] = 0; request[3] = addrType;
    
    if (addrType === 3) {
      request[4] = addrBytes.length;
      request.set(addrBytes, 5);
      request[5 + addrBytes.length] = (targetPort >> 8) & 0xFF;
      request[6 + addrBytes.length] = targetPort & 0xFF;
    } else if (addrType === 1) {
      request.set(addrBytes, 4);
      request[8] = (targetPort >> 8) & 0xFF;
      request[9] = targetPort & 0xFF;
    } else {
      request.set(addrBytes, 4);
      request[20] = (targetPort >> 8) & 0xFF;
      request[21] = targetPort & 0xFF;
    }
    
    await writer.write(request);

    // 4. Reply
    const reply = await readBytes(4);
    if (reply[1] !== 0) {
      throw new Error(`SOCKS5 error code: ${reply[1]}`);
    }

    const addrType2 = reply[3];
    if (addrType2 === 1) await readBytes(4);
    else if (addrType2 === 3) await readBytes((await readBytes(1))[0]);
    else if (addrType2 === 4) await readBytes(16);
    await readBytes(2);

    return {
      socket,
      writer,
      read: async () => {
        if (buffer.length > 0) {
          const data = buffer;
          buffer = new Uint8Array(0);
          return { done: false, value: data };
        }
        return rawReader.read();
      }
    };
  } catch (e) {
    try { writer.close(); } catch {}
    try { rawReader.cancel(); } catch {}
    try { socket.close(); } catch {}
    throw e;
  }
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BOLBOL</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; }
        .container { text-align: center; padding: 2rem; }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; }
        p { color: #94a3b8; }
        .status { color: #22c55e; font-weight: 600; }
    </style>
</head>
<body>
    <div class="container">
        <h1>BOLBOL</h1>
        <p class="status">Service Active</p>
    </div>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const config = getConfig(env);
    const url = new URL(request.url);

    if (url.pathname !== config.path) {
      if (request.headers.get("Upgrade") === "websocket") {
        return new Response("Not found", { status: 404 });
      }
      return new Response(LANDING_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    let tcpWriter = null;
    let tcpSocket = null;
    let closed = false;
    let connecting = false;
    let pendingMessages = [];

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { tcpWriter?.close(); } catch {}
      try { tcpSocket?.close(); } catch {}
      pendingMessages = [];
      try { server.close(1000); } catch {} // Close cleanly if not already closed
    };

    server.addEventListener("message", async (event) => {
      if (closed) return;

      try {
        const data = new Uint8Array(event.data);

        // Queue messages arriving while initial connection is being set up
        if (connecting && !tcpSocket) {
          pendingMessages.push(data);
          return;
        }

        if (!tcpSocket) {
          const header = parseVless(data);
          if (header.error) { cleanup(); return; }
          if (env.UUID && header.uuid !== env.UUID) { cleanup(); return; }

          connecting = true;

          let reader;
          const CONNECT_TIMEOUT = 10_000;
          let timeoutId;
          const createTimeout = () => new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Connection timed out')), CONNECT_TIMEOUT);
          });

          try {
            if (config.socks5.enabled) {
              const result = await Promise.race([
                connectViaSOCKS5(header.addr, header.port, config),
                createTimeout()
              ]);
              clearTimeout(timeoutId);
              tcpSocket = result.socket;
              tcpWriter = result.writer;
              reader = result.read;
            } else {
              tcpSocket = connect({ hostname: header.addr, port: header.port });
              
              // Wait for HTTP/TCP handshake securely
              await Promise.race([tcpSocket.opened, createTimeout()]);
              clearTimeout(timeoutId);

              tcpWriter = tcpSocket.writable.getWriter();
              const tcpReader = tcpSocket.readable.getReader();
              reader = () => tcpReader.read();
            }

            // Connection successful
            try {
              server.send(new Uint8Array([0, 0]));
            } catch (e) {
              // Client disconnected exactly as we connected
              throw new Error("Client disconnect");
            }

            // Write initial payload if it exists
            if (data.length > header.headerLen) {
              await tcpWriter.write(data.slice(header.headerLen));
            }

            connecting = false;

            // Flush queued messages safely
            for (const msg of pendingMessages) {
              if (closed) break;
              await tcpWriter.write(msg);
            }
            pendingMessages = [];

            // Start relay: target -> client
            (async () => {
              try {
                while (!closed) {
                  const { done, value } = await reader();
                  if (done) break;
                  if (value && value.length > 0 && server.readyState === 1) {
                    server.send(value);
                  }
                }
              } catch (e) {
                // Ignore safe drop errors
              } finally {
                cleanup();
              }
            })();

          } catch (e) {
            clearTimeout(timeoutId);
            connecting = false;
            cleanup();
            return;
          }
        } else {
          // Already connected: forward data to target
          try {
            await tcpWriter.write(data);
          } catch (e) {
            // Socket write failed, cleanly shut down
            cleanup();
          }
        }
      } catch (e) {
        cleanup();
      }
    });

    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
};