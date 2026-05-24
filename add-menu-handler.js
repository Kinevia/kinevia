const fs = require('fs');
let content = fs.readFileSync('public/app.html', 'utf8');

// Add mobile menu handlers in setupLayoutEvents, after the mobileLogoutBtn block
const oldStr = `if (mobileLogoutBtn) mobileLogoutBtn.addEventListener('click', doLogout);

            // Modal close handlers (exercice detail)`;

const newStr = `if (mobileLogoutBtn) mobileLogoutBtn.addEventListener('click', doLogout);

            // Mobile hamburger menu
            var mobileMenuToggle = document.getElementById('mobile-menu-toggle');
            var mobileMenuOverlay = document.getElementById('mobile-menu-overlay');
            var mobileMenuClose = document.getElementById('mobile-menu-close');
            if (mobileMenuToggle) mobileMenuToggle.addEventListener('click', function() {
                if (mobileMenuOverlay) mobileMenuOverlay.classList.remove('hidden');
                document.body.style.overflow = 'hidden';
            });
            if (mobileMenuClose) mobileMenuClose.addEventListener('click', function() {
                if (mobileMenuOverlay) mobileMenuOverlay.classList.add('hidden');
                document.body.style.overflow = '';
            });
            if (mobileMenuOverlay) mobileMenuOverlay.addEventListener('click', function(e) {
                if (e.target === mobileMenuOverlay) {
                    mobileMenuOverlay.classList.add('hidden');
                    document.body.style.overflow = '';
                }
            });
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && mobileMenuOverlay && !mobileMenuOverlay.classList.contains('hidden')) {
                    mobileMenuOverlay.classList.add('hidden');
                    document.body.style.overflow = '';
                }
            });

            // Modal close handlers (exercice detail)`;

if (!content.includes(oldStr)) {
    console.log('ERROR: old string not found for JS handler.');
    const idx = content.indexOf('mobileLogoutBtn.addEventListener');
    if (idx > -1) {
        console.log('Found at index:', idx);
        console.log('Context:', JSON.stringify(content.slice(idx, idx + 200)));
    }
    process.exit(1);
}

content = content.replace(oldStr, newStr);
fs.writeFileSync('public/app.html', content);
console.log('Added mobile menu JS handlers.');