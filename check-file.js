const fs = require('fs');
const content = fs.readFileSync('./public/patient.html', 'utf8');
const lines = content.split('\n');
console.log('Total lines:', lines.length);

// Show lines 848-870
for (let i = 848; i < 870; i++) {
    console.log((i+1) + ': ' + JSON.stringify(lines[i]));
}