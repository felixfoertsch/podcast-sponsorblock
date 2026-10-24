declare module "ssrf-req-filter" {
	import type { Agent as HttpAgent } from "node:http";
	import type { Agent as HttpsAgent } from "node:https";
	function ssrfFilter(url: string): HttpAgent | HttpsAgent;
	export = ssrfFilter;
}
