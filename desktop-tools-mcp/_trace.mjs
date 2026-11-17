import { Client } from './node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from './node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const t = new StdioClientTransport({ command: process.execPath, args: ['./server.mjs','/tmp/mcptest'], stderr:'ignore' });
const c = new Client({name:'t',version:'1'},{capabilities:{}});
await c.connect(t);
await c.listTools();
await c.callTool({name:'list_dir',arguments:{path:'/tmp/mcptest'}});
await c.close();
console.log('OK');
