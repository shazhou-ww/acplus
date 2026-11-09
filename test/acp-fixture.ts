import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Config } from "../src/acp-types.js";

const sdk = pathToFileURL(
  createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
).href;
export const agentProgram = `
import {agent,methods,ndJsonStream} from ${JSON.stringify(sdk)};
import {Writable,Readable} from 'node:stream';
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.COUNTER_PATH,'start\\n');
const app=agent({name:'acplus-fixture'});
let signedIn=false;
let pending=new Map();
app.onRequest(methods.agent.initialize,()=>({
 protocolVersion:1,
 agentCapabilities:{loadSession:process.env.NO_LOAD!=='1',auth:{logout:{}}},
 authMethods:[{id:'sign-in',name:'Fixture sign in'}]
}));
app.onRequest(methods.agent.authenticate,()=>{signedIn=true;return {};});
app.onRequest(methods.agent.logout,()=>{signedIn=false;return {};});
app.onRequest(methods.agent.session.new,()=>({sessionId:'backend-'+Math.random().toString(16).slice(2)}));
app.onRequest(methods.agent.session.load,async({params,client})=>{
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'PAST'}}});
 return {};
});
app.onRequest(methods.agent.session.prompt,async({params,client})=>{
 const text=params.prompt.map(x=>x.text||'').join('');
 if(text==='HOLD'){
  await new Promise(resolve=>pending.set(params.sessionId,resolve));
  pending.delete(params.sessionId);
  return {stopReason:'cancelled'};
 }
 if(text==='DISCONNECT'){process.exit(0);}
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{
  sessionUpdate:'tool_call',toolCallId:'call-1',title:'Read test file',kind:'read',status:'in_progress'
 }});
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{
  sessionUpdate:'tool_call_update',toolCallId:'call-1',status:'completed',
  content:[{type:'content',content:{type:'text',text:'result '+(process.env.TEST_API_KEY||'safe')}}]
 }});
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OK'}}});
 return {stopReason:'end_turn'};
});
app.onNotification(methods.agent.session.cancel,({params})=>{pending.get(params.sessionId)?.();});
const connection=app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
await connection.closed;
`;

export function fixtureConfig(directory: string): Config {
  return {
    schemaVersion: 2,
    instance: "fixture",
    dataDir: join(directory, "data"),
    listen: { host: "127.0.0.1", port: 0 },
    agents: [
      {
        id: "copilot",
        label: "Fixture",
        command: process.execPath,
        args: ["--input-type=module", "-e", agentProgram],
        env: {
          COUNTER_PATH: join(directory, "counter"),
          TEST_API_KEY: "fixture-secret-value",
        },
        profileDir: join(directory, "profile"),
        workspaces: [directory],
        mcpServers: [],
        startupTimeoutMs: 5000,
        idleTimeoutMs: 0,
        permission: "deny",
      },
    ],
  };
}
