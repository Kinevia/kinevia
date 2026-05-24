const fs = require('fs');
const content = fs.readFileSync('public/app.html', 'utf8');
const idx = content.indexOf('mobile-menu-overlay');
if (idx > -1) {
    console.log('Found mobile-menu-overlay at index:', idx);
    console.log('Context:', JSON.stringify(content.slice(idx, idx + 300)));
} else {
    console.log('NOT FOUND!');
}

const idx2 = content.indexOf('mobile-menu-toggle');
if (idx2 > -1) {
    console.log('Found mobile-menu-toggle at index:', idx2);
}