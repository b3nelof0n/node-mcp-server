// server.js
// Run with: node server.js
//
// Desired MCP flow:
//  1) GET /sse-cursor => SSE => event:endpoint => /message?sessionId=XYZ
//  2) POST /message?sessionId=XYZ => {method:"initialize"} => minimal HTTP ack => SSE => big "capabilities"
//  3) {method:"tools/list"} => SSE => Tools array (including addNumbersTool)
//  4) {method:"tools/call"} => SSE => result of the call (like summing two numbers)
//  5) notifications/initialized => ack
//
// To avoid "unknown ID" errors, we always use rpc.id in the SSE response.

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const port = 4000;

// Enable CORS if needed
app.use(cors());
// Parse JSON bodies
app.use(express.json());

// We store sessions by sessionId => { sseRes, initialized: boolean }
const sessions = new Map();

/*
|--------------------------------------------------------------------------
| 1) SSE => GET /sse-cursor
|--------------------------------------------------------------------------
|  => Sends event:endpoint => /message?sessionId=XYZ
|  => Does NOT send big JSON at this point
|  => Also sends a heartbeat every 10 seconds
*/
app.get("/sse-cursor", (req, res) => {
    console.log("[MCP] SSE => /sse-cursor connected");

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Generate a sessionId
    const sessionId = uuidv4();
    sessions.set(sessionId, { sseRes: res, initialized: false });
    console.log("[MCP] Created sessionId:", sessionId);

    // event: endpoint => /message?sessionId=...
    res.write(`event: endpoint\n`);
    res.write(`data: /message?sessionId=${sessionId}\n\n`);

    // Heartbeat every 10 seconds
    const hb = setInterval(() => {
        res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
    }, 10000);

    // Cleanup on disconnect
    req.on("close", () => {
        clearInterval(hb);
        sessions.delete(sessionId);
        console.log("[MCP] SSE closed => sessionId=", sessionId);
    });
});

/*
|--------------------------------------------------------------------------
| 2) JSON-RPC => POST /message?sessionId=...
|--------------------------------------------------------------------------
|   => "initialize" => minimal ack => SSE => big "capabilities"
|   => "tools/list" => minimal ack => SSE => array of tools
|   => "tools/call" => minimal ack => SSE => result of the call, e.g. sum
|   => "notifications/initialized" => ack
|--------------------------------------------------------------------------
*/
app.post("/message", (req, res) => {
    console.log("[MCP] POST /message => body:", req.body, " query:", req.query);

    const sessionId = req.query.sessionId;
    if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId in ?sessionId=..." });
    }
    const sessionData = sessions.get(sessionId);
    if (!sessionData) {
        return res.status(404).json({ error: "No SSE session with that sessionId" });
    }

    const rpc = req.body;
    // Check JSON-RPC formatting
    if (!rpc || rpc.jsonrpc !== "2.0" || !rpc.method) {
        return res.json({
            jsonrpc: "2.0",
            id: rpc?.id ?? null,
            error: {
                code: -32600,
                message: "Invalid JSON-RPC request"
            }
        });
    }

    // Minimal HTTP ack
    res.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { ack: `Received ${rpc.method}` }
    });

    // The actual response => SSE
    const sseRes = sessionData.sseRes;
    if (!sseRes) {
        console.log("[MCP] No SSE response found => sessionId=", sessionId);
        return;
    }

    switch (rpc.method) {
        // -- initialize
        case "initialize": {
            sessionData.initialized = true;

            // SSE => event: message => big "capabilities"
            const initCaps = {
                jsonrpc: "2.0",
                id: rpc.id, // Use the same ID => no "unknown ID" error
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: {
                        tools: { listChanged: true },
                        resources: { subscribe: true, listChanged: true },
                        prompts: { listChanged: true },
                        logging: {}
                    },
                    serverInfo: {
                        name: "final-capabilities-server",
                        version: "1.0.0"
                    }
                }
            };
            sseRes.write(`event: message\n`);
            sseRes.write(`data: ${JSON.stringify(initCaps)}\n\n`);
            console.log("[MCP] SSE => event: message => init caps => sessionId=", sessionId);
            return;
        }

        // -- tools/list
        case "tools/list": {
            const toolsMsg = {
                jsonrpc: "2.0",
                id: rpc.id, // same ID => no "unknown ID"
                result: {
                    tools: [
                        {
                            name: "addNumbersTool",
                            description: "Adds two numbers 'a' and 'b' and returns their sum.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    a: { type: "number" },
                                    b: { type: "number" }
                                },
                                required: ["a", "b"]
                            }
                        }
                    ],
                    count: 1
                }
            };
            sseRes.write(`event: message\n`);
            sseRes.write(`data: ${JSON.stringify(toolsMsg)}\n\n`);
            console.log("[MCP] SSE => event: message => tools/list => sessionId=", sessionId);
            return;
        }

        // -- tools/call: e.g. addNumbersTool
        case "tools/call": {
            // e.g. { name: "addNumbersTool", arguments: { a:..., b:... } }
            const toolName = rpc.params?.name;
            const args = rpc.params?.arguments || {};
            console.log("[MCP] tools/call => name=", toolName, "args=", args);

            if (toolName === "addNumbersTool") {
                const sum = (args.a || 0) + (args.b || 0);
                // SSE => event: message => the result
                const callMsg = {
                    jsonrpc: "2.0",
                    id: rpc.id, // use the same ID => no unknown ID
                    result: {
                        content: [
                            {
                                type: "text",
                                text: `Sum of ${args.a} + ${args.b} = ${sum}`
                            }
                        ]
                    }
                };
                sseRes.write(`event: message\n`);
                sseRes.write(`data: ${JSON.stringify(callMsg)}\n\n`);
                console.log("[MCP] SSE => event: message => tools/call => sum", sum);
            } else {
                // unknown tool
                const callErr = {
                    jsonrpc: "2.0",
                    id: rpc.id,
                    error: {
                        code: -32601,
                        message: `No such tool '${toolName}'`
                    }
                };
                sseRes.write(`event: message\n`);
                sseRes.write(`data: ${JSON.stringify(callErr)}\n\n`);
                console.log("[MCP] SSE => event: message => unknown tool call");
            }
            return;
        }

        // -- notifications/initialized
        case "notifications/initialized": {
            console.log("[MCP] notifications/initialized => sessionId=", sessionId);
            // done, no SSE needed
            return;
        }

        default: {
            console.log("[MCP] unknown method =>", rpc.method);
            const errObj = {
                jsonrpc: "2.0",
                id: rpc.id,
                error: {
                    code: -32601,
                    message: `Method '${rpc.method}' not recognized`
                }
            };
            sseRes.write(`event: message\n`);
            sseRes.write(`data: ${JSON.stringify(errObj)}\n\n`);
            return;
        }
    }
});

app.listen(port, () => {
    console.log(`[MCP] final server with tools/call at http://localhost:${port}`);
    console.log("GET  /sse-cursor => SSE => endpoint => /message?sessionId=...");
    console.log("POST /message?sessionId=... => initialize => SSE => capabilities, tools/list => SSE => Tools, tools/call => SSE => sum, etc.");
});
