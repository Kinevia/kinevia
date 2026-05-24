const fs = require('fs');
let content = fs.readFileSync('public/app.html', 'utf8');

// Replace the mobile nav with hamburger + overlay
const oldStr = `'<nav class=\u0022mobile-nav relative fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-40 px-2 py-2 gap-2 items-center flex-nowrap\u0022>' +
                    mobileNavHtml +
                '</nav>' +`;

const newStr = `'<div id=\u0022mobile-menu-overlay\u0022 class=\u0022hidden fixed inset-0 z-50 bg-white flex flex-col\u0022>' +
                    '<div class=\u0022flex items-center justify-between p-4 border-b border-gray-100\u0022>' +
                        '<div class=\u0022flex items-center gap-2\u0022>' +
                            '<img src=\u0022/icons/icon-96.png\u0022 alt=\u0022Kinévia\u0022 class=\u0022w-8 h-8 rounded-lg object-cover\u0022>' +
                            '<span class=\u0022text-lg font-bold\u0022 style=\u0022letter-spacing:-0.3px;\u0022><span style=\u0022color:#0f172a;\u0022>Kiné</span><span style=\u0022color:#38BDF8;\u0022>via</span></span>' +
                        '</div>' +
                        '<button id=\u0022mobile-menu-close\u0022 class=\u0022p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors\u0022>' +
                            '<svg xmlns=\u0022http://www.w3.org/2000/svg\u0022 class=\u0022w-6 h-6\u0022 fill=\u0022none\u0022 viewBox=\u00220 0 24 24\u0022 stroke=\u0022currentColor\u0022 stroke-width=\u00222\u0022><path stroke-linecap=\u0022round\u0022 stroke-linejoin=\u0022round\u0022 d=\u0022M19 9l-7 7-7-7\u0022/></svg>' +
                        '</button>' +
                    '</div>' +
                    '<nav class=\u0022flex-1 flex flex-col gap-1 p-4 overflow-y-auto\u0022>' +
                        navItems.map(function(item) {
                            var isActive = currentRoute === item.route || (item.route === 'patients' && currentRoute === 'patient-detail') || (item.route === 'programmes' && currentRoute === 'programme-detail') || (item.route === 'suivi' && currentRoute === 'suivi-detail') || (item.route === 'protocoles' && currentRoute === 'protocole-detail');
                            var badge = (item.badge) ? '<span class=\u0022ml-auto text-xs bg-red-500 text-white rounded-full px-1.5 py-0.5 min-w-[1.2rem] text-center\u0022>' + item.badge + '</span>' : '';
                            return '<a href=\u0022' + item.href + '\u0022 data-link class=\u0022flex items-center gap-3 px-4 py-3 rounded-lg text-base font-medium ' + (isActive ? 'bg-blue-50 text-primary' : 'text-gray-700 hover:bg-gray-50') + '\u0022>' +
                                icons[item.icon] + '<span>' + item.label + '</span>' + badge +
                            '</a>';
                        }).join('') +
                        '<a href=\u0022/aide\u0022 data-link class=\u0022flex items-center gap-3 px-4 py-3 rounded-lg text-base font-medium text-gray-700 hover:bg-gray-50\u0022>' + icons.help + '<span>Aide & Support</span></a>' +
                    '</nav>' +
                '</div>' +
                '<button id=\u0022mobile-menu-toggle\u0022 class=\u0022md:hidden fixed bottom-4 right-4 w-14 h-14 bg-white border border-gray-200 rounded-2xl shadow-lg flex items-center justify-center z-40 hover:bg-gray-50 active:bg-gray-100 transition-colors\u0022>' +
                    '<svg xmlns=\u0022http://www.w3.org/2000/svg\u0022 class=\u0022w-6 h-6 text-gray-700\u0022 fill=\u0022none\u0022 viewBox=\u00220 0 24 24\u0022 stroke=\u0022currentColor\u0022 stroke-width=\u00222\u0022><path stroke-linecap=\u0022round\u0022 stroke-linejoin=\u0022round\u0022 d=\u0022M4 6h16M4 12h16M4 18h16\u0022/></svg>' +
                '</button>' +`;

if (!content.includes(oldStr)) {
    console.log('ERROR: old string not found. Trying to find it...');
    const idx = content.indexOf('mobile-nav relative fixed');
    console.log('Found at index:', idx);
    if (idx !== -1) {
        console.log('Context:', JSON.stringify(content.slice(idx - 50, idx + 200)));
    }
    process.exit(1);
}

content = content.replace(oldStr, newStr);
fs.writeFileSync('public/app.html', content);
console.log('Replaced mobile nav with hamburger button.');