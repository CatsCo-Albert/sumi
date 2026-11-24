import { render } from "@solidjs/web";
import "@ui-sdk/core/web.css";
import "./app.css";
import { Shell } from "./components/shell";

render(() => <Shell />, document.getElementById("root")!);
