if (!document.querySelector('link[data-admin-ux]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './admin-ux.css';
  link.dataset.adminUx = '1';
  document.head.appendChild(link);
}

// Legacy admin-ux.js used to create a second tournament room with its own
// selector and tabs. The phase-based tournament workspace is now canonical.
import("./tournament-attendance-polish.js?v=20260829-2010");
