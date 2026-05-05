// Narrow entry point for registerSlackTools — avoids pulling in the full
// runtime-api barrel during plugin register(). Mirrors http-routes-api.ts.
export { registerSlackTools } from "./src/tools/index.js";
