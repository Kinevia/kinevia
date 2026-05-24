const fs = require('fs');
const files = [
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
  'server.js',
];

for (const f of files) {
  const c = fs.readFileSync(f, 'utf8');
  const fixed = c.replace(/Kinevia/g, 'Kinévia');
  if (fixed !== c) {
    fs.writeFileSync(f, fixed, 'utf8');
    const count = (c.match(/Kinevia/g) || []).length;
    console.log(f + ': fixed ' + count + ' Kinevia -> Kinévia');
  }
}
console.log('Done.');
