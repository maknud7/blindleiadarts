if (!document.querySelector('link[data-admin-ux]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './admin-ux.css';
  link.dataset.adminUx = '1';
  document.head.appendChild(link);
}

import('./admin-ux.js');
