const fs = require('fs');
const files = [
  'public/exercices-public.html',
];
files.forEach(function(f) {
  const c = fs.readFileSync(f, 'utf8');
  const fixed = c.replace(/MonKin&eacute;/g, 'Kinévia');
  if (fixed !== c) {
    fs.writeFileSync(f, fixed, 'utf8');
    const count = (c.match(/MonKin&eacute;/g) || []).length;
    console.log(f + ': fixed ' + count + ' HTML entity occurrences');
  }
});
console.log('Done.');
