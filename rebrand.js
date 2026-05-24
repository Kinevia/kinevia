const fs = require('fs');

function replaceBranding(content) {
  return content
    .replace(/MonKiné/g, 'Kinévia')
    .replace(/Monkiné/g, 'Kinévia')
    .replace(/Mon Kiné/g, 'Kinévia')
    .replace(/MonKine/g, 'Kinevia');
}

const files = [
  'public/index.html',
  'public/app.html',
  'public/admin.html',
  'public/patient.html',
  'public/exercices-public.html',
  'public/abonnement-succes.html',
  'public/cgu.html',
  'public/mentions-legales.html',
  'public/confidentialite.html',
  'public/blog/index.html',
  'public/blog/exercices-epaule-kine.html',
  'public/blog/lombalgie-exercices-dos.html',
  'public/blog/programme-kine-patient-maison.html',
  'public/blog/suivi-patient-kinesitherapeute.html',
  'public/llms.txt',
  'server.js',
  'package.json',
  'README.md',
];

for (const file of files) {
  try {
    const original = fs.readFileSync(file, 'utf8');
    const updated = replaceBranding(original);
    if (original !== updated) {
      fs.writeFileSync(file, updated, 'utf8');
      const matches = original.match(/MonKiné|Monkiné|Mon Kiné|MonKine/g) || [];
      console.log(file + ': replaced ' + matches.length + ' occurrences');
    } else {
      console.log(file + ': no changes');
    }
  } catch(e) {
    console.log(file + ': ERROR - ' + e.message);
  }
}
