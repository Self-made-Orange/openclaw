export const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
export const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";

// CLAW-FORK 2026-04-30: RLHF feedback buttons (thread-followup, post-delivery).
export const SLACK_FEEDBACK_GOOD_ACTION_ID = "openclaw:feedback_good";
export const SLACK_FEEDBACK_BAD_ACTION_ID = "openclaw:feedback_bad";
// CLAW-FORK 2026-04-30: undo accidental feedback click. value = "<thread_ts>:<positive|negative>".
export const SLACK_FEEDBACK_UNDO_ACTION_ID = "openclaw:feedback_undo";
