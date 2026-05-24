const fs = require('fs');
let content = fs.readFileSync('public/app.html', 'utf8');

// Update CSS: remove old mobile-nav styles and update main-content padding
const oldStr = `@media (max-width: 768px) {
            .desktop-sidebar { display: none !important; }
            .mobile-nav { display: flex !important; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; scroll-behavior: smooth; }
            .mobile-nav::-webkit-scrollbar { height: 3px; }
            .mobile-nav::-webkit-scrollbar-track { background: transparent; }
            .mobile-nav::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
            .mobile-nav::after { content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 20px; background: linear-gradient(to left, rgba(255,255,255,1), rgba(255,255,255,0)); pointer-events: none; }
            .main-content { margin-left: 0 !important; padding-bottom: 5rem; }
        }
        @media (min-width: 769px) {
            .desktop-sidebar { display: flex !important; }
            .mobile-nav { display: none !important; }
            .main-content { margin-left: 16rem; }
        }`;

const newStr = `@media (max-width: 768px) {
            .desktop-sidebar { display: none !important; }
            .main-content { margin-left: 0 !important; }
        }
        @media (min-width: 769px) {
            .desktop-sidebar { display: flex !important; }
            .main-content { margin-left: 16rem; }
        }
        #mobile-menu-toggle { box-shadow: 0 4px 20px rgba(0,0,0,0.15); }`;

if (!content.includes(oldStr)) {
    console.log('ERROR: old CSS string not found.');
    const idx = content.indexOf('.mobile-nav { display: flex');
    if (idx > -1) {
        console.log('Found at index:', idx);
        console.log('Context:', JSON.stringify(content.slice(idx - 50, idx + 300)));
    }
    process.exit(1);
}

content = content.replace(oldStr, newStr);
fs.writeFileSync('public/app.html', content);
console.log('Updated CSS for new mobile nav.');