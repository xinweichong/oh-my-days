/**
 * Bulk limits shared by the Worker and the Mini App client. Workers Free
 * allows 50 D1 queries per invocation, and each task changed in bulk costs one
 * or two statements, so one change request holds at most MAX_BULK_WRITE tasks;
 * the app sends a larger selection (up to MAX_SELECTION) in parts. A cancel
 * preview only reads, so it covers the whole selection.
 */
export const MAX_BULK_WRITE = 20;
export const MAX_SELECTION = 100;
