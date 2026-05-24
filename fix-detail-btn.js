const fs = require('fs');
let content = fs.readFileSync('./public/patient.html', 'utf8');

const marker = '// Detail button\n        if (hasDetail && !allDone) {';
const idx = content.indexOf(marker);
if (idx < 0) { console.log('Marker not found'); process.exit(1); }

// Find the closing } of this block by scanning forward
// The block ends with '        }' followed by '\n\n        html += '</div>'; // card end'
let scan = idx;
let braceCount = 0;
let blockStart = -1;
let blockEnd = -1;

for (let i = scan; i < content.length; i++) {
    if (content[i] === '{') {
        if (braceCount === 0) blockStart = i;
        braceCount++;
    } else if (content[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
            blockEnd = i + 1;
            break;
        }
    }
}

if (blockEnd < 0) { console.log('Could not find closing brace'); process.exit(1); }

const oldBlock = content.slice(blockStart, blockEnd);
console.log('Old block length:', oldBlock.length);
console.log('Old block:');
console.log(oldBlock);

// New block
const newBlock = `// Detail / Video button
        if (hasDetail && !allDone) {
            if (ex.r2_video_url) {
                html += '<button onclick=\\'openVideoPlayer(\\' + idx + \\')\\'' +
                    '\\'class=\\'w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 \\'' +
                    '\\'hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all\\'>' +
                    '\\'<svg class=\\'w-3.5 h-3.5\\' fill=\\'currentColor\\' viewBox=\\'0 0 24 24\\'>' +
                    '\\'<path d=\\'M8 5v14l11-7z\\'/></svg>Video</button>\\';
            } else {
                html += '<button onclick=\\'openExerciseDetail(\\' + idx + \\')\\'' +
                    '\\'class=\\'w-full border-t border-gray-100 py-2.5 text-xs font-semibold text-primary-500 \\'' +
                    '\\'hover:bg-primary-50 flex items-center justify-center gap-1.5 transition-all\\'>' +
                    '\\'<svg class=\\'w-3.5 h-3.5\\' fill=\\'none\\' stroke=\\'currentColor\\' viewBox=\\'0 0 24 24\\'>' +
                    '\\'<path stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'2\\' d=\\'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z\\'/></svg>\\'' +
                    '\\'Voir les détails</button>\\';
            }
        }`;

content = content.slice(0, blockStart) + newBlock + content.slice(blockEnd);
fs.writeFileSync('./public/patient.html', content);
console.log('Done!');