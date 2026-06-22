/**
 * Public SDK subpath for the shared `openclaw-interactive` fence regexes.
 * CLAW-FORK 2026-06-13 (MED-5): keeps the cron (slack extension) and reply
 * (core) fence parsers on one canonical pattern.
 */
export {
  getInteractiveFenceRe,
  getJsonBlockKitFenceRe,
  getJsonInteractiveFenceRe,
} from "../auto-reply/reply/interactive-fence-regex.js";
