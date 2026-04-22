# AI Relay Bridge — Setup Guide

## What it is

The AI Relay Bridge lets any AI chat service (ChatGPT, Claude.ai, Gemini, etc.) control VisGraph directly — no server, no browser extension required. A bookmarklet on the AI tab intercepts MCP JSON-RPC 2.0 tool calls, routes them to VisGraph via a shared popup bridge, and automatically injects the result back into the chat input.

## How it works

```text
AI chat tab                 relay.html popup            VisGraph tab
(chatgpt.com etc.)          (thhanke.github.io)         (thhanke.github.io)
     │                            │                            │
     │  postMessage(vg-call)      │                            │
     │ ─────────────────────────► │  BroadcastChannel(vg-call) │
     │                            │ ──────────────────────────► │
     │                            │                      execute tool
     │                            │  BroadcastChannel(vg-result)│
     │                            │ ◄────────────────────────── │
     │  postMessage(vg-result)    │                            │
     │ ◄───────────────────────── │                            │
   result injected into chat input automatically
```

## Prerequisites

- Modern browser (Chrome 115+ recommended; Firefox/Safari supported)
- VisGraph open at https://thhanke.github.io/visgraph
- Popup windows must be allowed for the AI chat site

## Setup

### Step 1 — Enable the relay in VisGraph

1. Open VisGraph at https://thhanke.github.io/visgraph
2. Open the left sidebar (☰ button)
3. Open the **"AI Relay"** accordion section
4. You'll see a **"⚡ VisGraph Relay"** button — drag it to your browser's bookmark bar

### Step 2 — Activate on your AI chat tab

1. Open ChatGPT, Claude.ai, or Gemini
2. Click the **"VisGraph Relay"** bookmarklet in your bookmark bar
3. A small popup window will open (the relay bridge) and a badge appears in the corner of the AI tab

### Step 3 — Start chatting

1. Paste the starter prompt (see below) into your AI chat
2. The AI issues MCP JSON-RPC 2.0 tool calls as inline backtick-wrapped JSON
3. Results are automatically injected into the chat input and submitted — no manual paste needed

## Starter prompt

Paste this as your opening message after installing the bookmarklet:

```text
You are connected to VisGraph via a relay. A script in your browser tab scans your responses for MCP tool calls, executes them in VisGraph, and injects the combined result back as a user message.

OUTPUT FORMAT — one MCP JSON-RPC 2.0 request per line, each wrapped in single backticks:
`{"jsonrpc":"2.0","id":<N>,"method":"tools/call","params":{"name":"<toolName>","arguments":{...}}}`

Rules:
1. You may output multiple tool calls in one response. They run sequentially in order.
2. Use a different integer id for each call.
3. Wait for the injected result message before issuing more calls.
4. Never output a tool call unless you intend it to run — the relay executes everything it finds.
5. addLink requires both nodes to already exist on canvas — never issue addNode and addLink for the same node in one response.

Reading results:
The relay injects a message like:
[VisGraph — N tools ✓]
`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"<summary>"}]}}`

- Parse each backtick-wrapped line as a JSON-RPC 2.0 response. id matches your request id.
- result means success; error means failure (check error.message).
- A Canvas summary line and SVG may follow after the responses.

Common prefixes you can use in argument values: rdf: rdfs: owl: xsd: foaf: skos: dc: dcterms: schema: ex:

Fetch https://thhanke.github.io/visgraph/.well-known/mcp.json for the full tool list with parameter names.

Now build a knowledge graph. What would you like to model?
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Popup window is blocked | Allow popups for the AI chat site in your browser settings |
| Badge doesn't appear | Check browser console for errors; try clicking the bookmarklet again |
| Results not appearing | Make sure VisGraph is open and the relay section shows the channel name |
| Relay stopped working | Platform DOM changed — check for bookmarklet updates at the VisGraph sidebar |
| Result not injected yet | If you switched to the VisGraph tab while a result was processing, it will inject automatically when you return to the chat tab |
| Tool calls not detected | The AI may not be using the JSON-RPC backtick format — paste the starter prompt again |

## Updating the bookmarklet

Re-drag the **"⚡ VisGraph Relay"** button from the VisGraph sidebar to replace your existing bookmark. The logic is embedded in the bookmark so re-installation is needed for updates.

## Supported platforms

| Platform | Status |
|----------|--------|
| ChatGPT (free + Plus) | Supported |
| Claude.ai | Supported |
| Gemini | Supported |
| Any AI chat with text output | Works if it outputs MCP JSON-RPC backtick format |
