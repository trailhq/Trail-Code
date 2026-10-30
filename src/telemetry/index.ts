/**
 * Anonymous adoption telemetry. `TELEMETRY.md` is the public contract;
 * `contract.ts` is the same list enforced in code.
 *
 * The whole subsystem is inert unless four things are true at once: the build
 * carries a key (published releases only), `DO_NOT_TRACK` is unset, this is not
 * CI, and the user has not disabled it. See `gate.ts`.
 */
export { EVENTS, VALUES, COMMON_KEYS, isTrackedCommand, errorCode, filesBucket, durationBucket, countBucket, savedTokensBucket, hookMsBucket, sessionSizeBucket, sessionMessagesBucket, langsValue } from './contract.js';
export type { AgentHost, Surface, TrackedCommand, BuildStage, ErrorCode } from './contract.js';
export { track, trackFirstRunIfNew, trackInstallIfNew, detectHost } from './track.js';
export type { QueuedEvent, TrackContext } from './track.js';
export { telemetryOn, offReason, explainOff } from './gate.js';
export { maybeFlushInBackground, runFlush } from './flush.js';
export { firstRunNotice, formatStatus, formatDebug, NOTICE, TELEMETRY_DOC_URL } from './notice.js';
export { patchState, readState } from './identity.js';
export { flushClosedSessions, summarizeSession } from './sessions.js';
