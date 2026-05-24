const fs = require('fs');
let content = fs.readFileSync('./public/patient.html', 'utf8');

// The broken section starts at '        // Detail button'
// and ends just before '        html += '</div>'; // card end'
const startMarker = '        // Detail button\n        if (hasDetail && !allDone) // Detail / Video button';
const endMarker = '        html += \u0027</div>\u0027; // card end';

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker);

if (startIdx < 0) { console.log('Start marker not found'); process.exit(1); }
if (endIdx < 0) { console.log('End marker not found'); process.exit(1); }

// Find the closing } before endMarker
let scan = endIdx - 1;
while (scan > startIdx && content[scan] !== '}') scan--;
const closeBrace = scan;
console.log('Close brace at index:', closeBrace);

const oldBlock = content.slice(startIdx, closeBrace + 1);
console.log('Old block length:', oldBlock.length);

// Build new block using string concat to avoid all quote escaping issues
const newBlock =
    '        // Detail / Video button\n' +
    '        if (hasDetail && !allDone) {\n' +
    '            if (ex.r2_video_url) {\n' +
    '                html += \u0027<button onclick=\u0027openVideoPlayer(\u0027 + idx + \u0027)\u0027 \u0027 +\n' +
    '                    \u0027class=\u0027w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 \u0027\u0027 +\n' +
    '                    \u0027hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all\u0027\u003E\u0027 +\n' +
    '                    \u0027<svg class=\u0027w-3.5 h-3.5\u0027 fill=\u0027currentColor\u0027 viewBox=\u00270 0 24 24\u0027>\u0027 +\n' +
    '                    \u0027<path d=\u0027M8 5v14l11-7z\u0027/></svg>Video</button>\u0027;\n' +
    '            } else {\n' +
    '                html += \u0027<button onclick=\u0027openExerciseDetail(\u0027 + idx + \u0027)\u0027 \u0027 +\n' +
    '                    \u0027class=\u0027w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 \u0027\u0027 +\n' +
    '                    \u0027hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all\u0027\u003E\u0027 +\n' +
    '                    \u0027<svg class=\u0027w-3.5 h-3.5\u0027 fill=\u0027none\u0027 stroke=\u0027currentColor\u0027 viewBox=\u00270 0 24 24\u0027>\u0027 +\n' +
    '                    \u0027<path stroke-linecap=\u0027round\u0027 stroke-linejoin=\u0027round\u0027 stroke-width=\u00272\u0027 d=\u0027M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z\u0027/></svg>\u0027 +\n' +
    '                    \u0027Voir les d\u00e9tails</button>\u0027;\n' +
    '            }\n' +
    '        }';

console.log('\nNew block:');
console.log(newBlock);

content = content.slice(0, startIdx) + newBlock + content.slice(closeBrace + 1);
fs.writeFileSync('./public/patient.html', content);
console.log('\nFixed!');