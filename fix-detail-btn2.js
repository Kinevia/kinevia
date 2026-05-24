const fs = require('fs');
let content = fs.readFileSync('./public/patient.html', 'utf8');

// Find the problematic section (lines around 849-870)
// The current broken code has both old and new
const marker = '        // Detail button\n        if (hasDetail && !allDone) // Detail / Video button';
const idx = content.indexOf(marker);
if (idx < 0) {
    console.log('Marker not found, checking current state...');
    // Just show what's around line 849
    const lines = content.split('\n');
    for (let i = 847; i < 875; i++) {
        console.log((i+1) + ': ' + JSON.stringify(lines[i]));
    }
    process.exit(1);
}

console.log('Found at:', idx);
// Now find the closing of this bad block - it's a multi-line block
// The block starts at marker and ends at the closing } before 'html += </div>; // card end'
const nextHtml = content.indexOf('        html += </div>; // card end', idx);
console.log('Next html div at:', nextHtml);

if (nextHtml < 0) { console.log('Could not find next html'); process.exit(1); }

// The bad block is from marker to the } before the next html line
// Let's find the } that closes this if block
let scan = idx;
let braceCount = 0;
let blockStart = -1;
let blockEnd = -1;
let inString = false;
let stringChar = '';

for (let i = scan; i < content.length; i++) {
    const c = content[i];
    const prev = i > 0 ? content[i-1] : '';

    if (!inString) {
        if (c === '\\'' || c === '\\\"') {
            inString = true;
            stringChar = c;
        } else if (c === '{') {
            if (braceCount === 0) blockStart = i;
            braceCount++;
        } else if (c === '}') {
            braceCount--;
            if (braceCount === 0 && i < nextHtml) {
                blockEnd = i + 1;
                // Check if what follows is the html div
                const after = content.slice(blockEnd, blockEnd + 30).replace(/\\s+/g, ' ');
                if (after.indexOf('html += </div>') >= 0 || after.indexOf('html +=') >= 0) {
                    break;
                }
            }
        }
    } else {
        if (c === stringChar && prev !== '\\\\') {
            inString = false;
        }
    }
}

console.log('Block from', blockStart, 'to', blockEnd);
const oldBlock = content.slice(blockStart, blockEnd);
console.log('Block:');
console.log(JSON.stringify(oldBlock));

// New block
const newBlock = `        // Detail / Video button
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