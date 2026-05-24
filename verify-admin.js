const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('wss://connect.anchorbrowser.io/?sessionId=8f143a9e-9891-4563-90bc-8871f77fdfff');
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to kinevia.pro
    await page.goto('https://kinevia.pro/connexion');
    await page.waitForLoadState('networkidle');
    console.log('Page title:', await page.title());

    // Navigate to dashboard to check sidebar
    await page.goto('https://kinevia.pro/dashboard');
    await page.waitForLoadState('networkidle');

    // Get sidebar content
    const sidebar = await page.evaluate(() => {
      const links = document.querySelectorAll('a.sidebar-link');
      return Array.from(links).map(a => a.textContent.trim()).filter(t => t);
    });
    console.log('Sidebar links:', JSON.stringify(sidebar));

    // Check if admin tab is present
    const adminTab = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a.sidebar-link')).some(a => a.textContent.includes('Admin'));
    });
    console.log('Admin tab present:', adminTab);

    // Check if logged in
    const userInfo = await page.evaluate(() => {
      return window.currentUser ? window.currentUser.is_admin : null;
    });
    console.log('currentUser.is_admin:', userInfo);

  } catch(e) {
    console.error('Error:', e.message);
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });