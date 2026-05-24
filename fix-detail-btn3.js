const fs = require('fs');
let content = fs.readFileSync('./public/patient.html', 'utf8');

// Find the broken section
const marker = '        // Detail button\n        if (hasDetail && !allDone) // Detail / Video button';
const idx = content.indexOf(marker);
if (idx < 0) { console.log('Marker not found'); process.exit(1); }

// Find end of block
const endMarker = '        html += </div>; // card end';
const endIdx = content.indexOf(endMarker, idx);
if (endIdx < 0) { console.log('End marker not found'); process.exit(1); }

// Find closing } of the if block
let scan = endIdx - 1;
while (scan > idx && content[scan] !== '}') scan--;
const closeBrace = scan;

// New block - using template literal so quotes are literal characters
const newBlock = `        // Detail / Video button
        if (hasDetail && !allDone) {
            if (ex.r2_video_url) {
                html += '<button onclick='openVideoPlayer(' + idx + ')'' +
                    'class='w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 '' +
                    'hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all'>' +
                    '<svg class='w-3.5 h-3.5' fill='currentColor' viewBox='0 0 24 24'>' +
                    '<path d='M8 5v14l11-7z'/></svg>Video</button>';
            } else {
                html += '<button onclick='openExerciseDetail(' + idx + ')'' +
                    'class='w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 '' +
                    'hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all'>' +
                    '<svg class='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>' +
                    '<path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'/></svg>' +
                    'Voir les détails</button>';
            }
        }`;

console.log('New block:');
console.log(newBlock);

content = content.slice(0, idx) + newBlock + content.slice(closeBrace + 1);
fs.writeFileSync('./public/patient.html', content);
console.log('Fixed!');