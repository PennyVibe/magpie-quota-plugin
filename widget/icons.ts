const paths = {
  quota: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  calls: '<path d="M4 7h16l-4-4M20 17H4l4 4"/>',
  tokens: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  cost: '<path d="M20 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v11H6a3 3 0 0 1-3-3V6"/><path d="M20 12h-5v5h5"/>',
  refresh: '<path d="M20 7v-4m0 4h-4"/><path d="M20 7a9 9 0 1 0 1 9"/>',
  manage: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
};

export const icon = (name: keyof typeof paths) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
