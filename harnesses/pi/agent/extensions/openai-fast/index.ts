import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerOpenAIFast } from "./runtime.ts";

export default function openaiFast(pi: ExtensionAPI) {
	registerOpenAIFast(pi, join(getAgentDir(), "extensions", "openai-fast.json"));
}
