import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerFast } from "./runtime.ts";

export default function fast(pi: ExtensionAPI) {
	registerFast(pi, join(getAgentDir(), "extensions", "fast.json"));
}
