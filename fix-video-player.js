const fs = require('fs');
let content = fs.readFileSync('./public/patient.html', 'utf8');

const marker = '// Detail button\n        if (hasDetail && !allDone) {';
const idx = content.indexOf(marker);
console.log('Marker found at:', idx);

const endMarker = '        }\n\n        html += </div>'; // card end
const endIdx = content.indexOf(endMarker, idx);
console.log('End found at:', endIdx);

// Build the new code (9 lines)
const oldCode = content.slice(idx, idx + 500);
console.log('Old code (500 chars from marker):');
console.log(JSON.stringify(oldCode));

// The old code spans lines 850-858. Let's find the exact end.
const lines = oldCode.split('\n');
console.log('Lines:', lines.length);
lines.forEach((l, i) => console.log(i, JSON.stringify(l)));