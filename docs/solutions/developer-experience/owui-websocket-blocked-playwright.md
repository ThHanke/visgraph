---
module: e2e/demo
tags: [playwright, owui, websocket, socket.io, chrome, private-network-access]
problem_type: infrastructure
---

# OWUI Socket.io WebSocket Blocked in Playwright Browser

## Problem

When Playwright (Chromium) navigates to the OWUI instance at
`https://gpuserver1-sit.iwm.fraunhofer.de/`, the socket.io WebSocket connection
fails with:

```
WebSocket connection to 'wss://gpuserver1-sit.iwm.fraunhofer.de/ws/socket.io/...'
failed: Error in connection establishment: net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS
```

**Symptom:** OWUI shows the "thinking" black dot indefinitely and never renders the
AI response in the browser window, even though qwen3 responds correctly on the
server (the response is stored in OWUI's database and visible if you reload or
navigate to the chat).

**Root cause:** Chrome 104+ applies Private Network Access checks. The GPU server
hostname resolves to an internal (Fraunhofer intranet) IP address. Chrome
classifies this as a private network and blocks WebSocket upgrade requests from
an HTTPS page to that endpoint, because the server does not respond to the
`Access-Control-Request-Private-Network` preflight with
`Access-Control-Allow-Private-Network: true`.

OWUI uses socket.io as its real-time channel to stream tokens into the UI; without
it, the UI does not update until the response is fully loaded via polling.

## Fix

Add `--disable-features=BlockInsecurePrivateNetworkRequests` to the Chromium
launch args. This disables Chrome's private network request blocking for the
browser session.

### `playwright.demo.config.ts` (demo recordings)

```ts
launchOptions: {
  args: ['--disable-features=BlockInsecurePrivateNetworkRequests'],
},
```

### MCP Playwright server (interactive sessions via Claude Code)

The MCP server is started by the IDE extension as:
```
npm exec @playwright/mcp@latest --browser chromium --ignore-https-errors
```

To add the flag, configure the MCP server launch command in the IDE/settings
to pass it via the `--args` option (if supported by the MCP version) or
replace the launch with:
```
npx @playwright/mcp --browser chromium --ignore-https-errors \
  --cdp-endpoint http://localhost:9222
```
and pre-launch Chrome with:
```
chromium-browser --remote-debugging-port=9222 \
  --disable-features=BlockInsecurePrivateNetworkRequests
```

## Relay impact

The OWUI relay (bookmarklet/stage page) reads the OWUI DOM via
`MutationObserver`/idle-poll and does **not** depend on socket.io for its
tool-call extraction. The relay still works correctly without socket.io; only
the visual streaming in the Playwright browser is affected.
