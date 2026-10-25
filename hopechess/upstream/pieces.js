const shapes = {
 p: `<circle cx="32" cy="16" r="8"/><path d="M26 24h12l-3 10 6 10H23l6-10z"/><path d="M23 44h18l4 7H19z"/><path d="M18 51h28v6H18z"/>`,
 n: `<path d="M21 44c0-10 6-13 15-18l-7-2-10 8-6-6 10-17 1-6 8 5c12 0 16 10 15 21l-2 15z"/><path d="m24 15 4-3" fill="none"/><path d="M22 44h23l2 7H18z"/><path d="M17 51h31v6H17z"/><circle cx="32" cy="17" r="1.5" class="piece-eye" stroke="none"/>`,
 b: `<path d="M32 5c-3 6-13 10-13 19 0 7 6 10 13 10s13-3 13-10C45 15 35 11 32 5z"/><path d="m35 14-8 12" fill="none"/><path d="M28 34h8l3 10H25z"/><path d="M23 44h18l5 7H18z"/><path d="M17 51h30v6H17z"/>`,
 r: `<path d="M16 8h8v7h5V8h7v7h5V8h8v17l-7 5v14H23V30l-7-5z"/><path d="M23 30h19" fill="none"/><path d="M21 44h23l3 7H18z"/><path d="M17 51h31v6H17z"/>`,
 q: `<path d="m16 19 7 20h19l7-20-12 10-5-15-5 15z"/><circle cx="15" cy="15" r="4"/><circle cx="32" cy="10" r="4"/><circle cx="50" cy="15" r="4"/><path d="M24 39h17l2 6H22z"/><path d="M21 45h23l3 6H18z"/><path d="M17 51h31v6H17z"/>`,
 k: `<path d="M29 4h6v7h7v6h-7v8h-6v-8h-7v-6h7z"/><path d="M32 27c-14-12-24 2-11 14h22c13-12 3-26-11-14z"/><path d="M23 41h19l2 10H21z"/><path d="M18 51h29v6H18z"/>`
};
export function pieceSVG(type, color = 'white', className = '') {
 return `<svg class="chess-piece ${color}-piece ${className}" viewBox="0 0 64 64" fill="currentColor" stroke="var(--piece-stroke)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[type] || shapes.p}</svg>`;
}
export const icons = {
 sound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m11 5-6 4H2v6h3l6 4z"/><path d="M15 8c2 2 2 6 0 8m3-11c4 4 4 10 0 14"/></svg>`,
 mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m11 5-6 4H2v6h3l6 4zM16 9l6 6m0-6-6 6"/></svg>`,
 flip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 8h13l-4-4m5 12H6l4 4M18 8l-4 4M6 16l4-4"/></svg>`
};
