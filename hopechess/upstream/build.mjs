import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js', 'multiplayer.js', 'pieces.js', 'engine.js']) await copyFile(file, `dist/${file}`);
console.log('Hopechess built to dist/');
