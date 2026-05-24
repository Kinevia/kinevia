const fs = require('fs');
let content = fs.readFileSync('./public/patient.html', 'utf8');

// Find the broken section starting with '// Detail button'
const marker = '        // Detail button\n        if (hasDetail && !allDone) // Detail / Video button';
const idx = content.indexOf(marker);
if (idx < 0) { console.log('Marker not found'); process.exit(1); }

// Find the end marker - actual line 869: html += '</div>'; // card end
const endMarker = '        html += </div>; // card end';  // WRONG - missing quotes around div
// Correct end marker:
const endMarkerCorrect = '        html += \u0027</div>\u0027; // card end';
const endIdx = content.indexOf(endMarkerCorrect);
if (endIdx < 0) { console.log('End marker not found'); process.exit(1); }

// Find the closing } before endMarker
let scan = endIdx - 1;
while (scan > idx && content[scan] !== '}') scan--;
const closeBrace = scan;
if (content[closeBrace] !== '}') { console.log('Close brace not found'); process.exit(1); }

const oldBlock = content.slice(idx, closeBrace + 1);
console.log('Old block length:', oldBlock.length);

// New block using unicode escapes for quotes - \u0027 = single quote, \u003E = >
// In single-quoted JS strings, \u0027 produces literal ' character
const newBlock = [
    '        // Detail / Video button',
    '        if (hasDetail && !allDone) {',
    '            if (ex.r2_video_url) {',
    '                html += \u0027<button onclick=\u0027openVideoPlayer(\u0027 + idx + \u0027)\u0027 \u0027 +',
    '                    \u0027class=\u0027w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 \u0027\u0027 +',
    '                    \u0027hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all\u0027\u003E\u0027 +',
    '                    \u0027<svg class=\u0027w-3.5 h-3.5\u0027 fill=\u0027currentColor\u0027 viewBox=\u00270 0 24 24\u0027>\u0027 +',
    '                    \u0027<path d=\u0027M8 5v14l11-7z\u0027/></svg>Video</button>\u0027;',
    '            } else {',
    '                html += \u0027<button onclick=\u0027openExerciseDetail(\u0027 + idx + \u0027)\u0027 \u0027 +',
    '                    \u0027class=\u0027w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 \u0027\u0027 +',
    '                    \u0027hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all\u0027\u003E\u0027 +',
    '                    \u0027<svg class=\u0027w-3.5 h-3.5\u0027 fill=\u0027none\u0027 stroke=\u0027currentColor\u0027 viewBox=\u00270 0 24 24\u0027>\u0027 +',
    '                    \u0027<path stroke-linecap=\u0027round\u0027 stroke-linejoin=\u0027round\u0027 stroke-width=\u00272\u0027 d=\u0027M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z\u0027/></svg>\u0027 +',
    '                    \u0027Voir les d\u00e9tails</button>\u0027;',
    '            }',
    '        }'
].join('\n');

console.log('New block:');
console.log(newBlock);

// Do replacement
content = content.slice(0, idx) + newBlock + content.slice(closeBrace + 1);
fs.writeFileSync('./public/patient.html', content);
console.log('Fixed!');