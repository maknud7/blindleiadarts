// Equipment bundle only. Keep this module focused: importing unrelated admin
// features here caused duplicate module execution, background API calls and heavy
// DOM work on every admin page load.
import "./pairing-claim-core.js?v=20260828-1745";
import "./equipment-admin-ux.js?v=20260826-1345";
import "./board-admin.js?v=20260831-1530";
import "./tablet-replacement.js?v=20260828-1700";
import "./terminal-pairing-ux.js?v=20260907-terminal-ux-01";
import "./scolia-admin.js?v=20260920-admin-perf-01";
import "./scolia-release-control.js?v=20260920-admin-perf-01";
import "./checkin-admin-v2.js?v=20260920-admin-perf-01";
