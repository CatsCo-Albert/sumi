/**
 * One-off live probe: does the bridge classify the real dashboard correctly?
 *
 * Run against the machine's own dashboard; it answers 403 until the attach gate
 * is opened, which is exactly the state this asserts.
 */
import { ArtifactBridgeClient } from "../src/artifacts/bridge";

const client = new ArtifactBridgeClient({ baseUrl: "http://127.0.0.1:3800", timeoutMs: 8000 });

const attach = await client.attach({
  artifactId: "prj_live_probe",
  sessionKey: "ses_live_probe",
  url: "http://127.0.0.1:8794/sumi/mcp",
});
console.log("attach:", JSON.stringify(attach));

const emit = await client.emit({
  artifactId: "prj_live_probe",
  sessionKey: "ses_live_probe",
  interactions: [{ kind: "a2ui_action", componentId: "c1", actionName: "toggle" }],
});
console.log("emit:", JSON.stringify(emit));
