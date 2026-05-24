#!/usr/bin/env node
/**
 * Rebrand Kinévia from teal (#0D9B8C) to light blue (#38BDF8).
 * Replaces all color references across all HTML files, manifest, etc.
 */
const fs = require('fs');
const path = require('path');

// Color mapping: old → new
const COLOR_MAP = {
  // Primary teal → sky blue
  '#0D9B8C': '#38BDF8',  // primary
  '#0d9b8c': '#38BDF8',  // primary (lowercase)
  '#077A6E': '#0EA5E9',  // primary-dark → sky-500
  '#077a6e': '#0EA5E9',  // primary-dark (lowercase)
  '#e0f5f3': '#E0F2FE',  // primary-light → sky-100
  '#E0F5F3': '#E0F2FE',  // primary-light (uppercase)
  '#f0faf9': '#F0F9FF',  // very light teal bg → sky-50

  // Secondary green → teal (keeps logo connection)
  '#10b981': '#2DD4BF',  // secondary → teal-400
  '#10B981': '#2DD4BF',  // secondary (uppercase)
  '#059669': '#14B8A6',  // secondary-dark → teal-500
  '#d1fae5': '#CCFBF1',  // secondary-light → teal-100
  '#D1FAE5': '#CCFBF1',  // secondary-light (uppercase)

  // Gradient colors used in favicon/icon scripts
  '#0DB8A8': '#38BDF8',  // teal-light gradient → sky
  '#0db8a8': '#38BDF8',

  // Teal variants in beta.html
  '#0d9488': '#38BDF8',  // --teal in beta
  '#0f766e': '#0EA5E9',  // --teal-dark in beta
  '#ccfbf1': '#E0F2FE',  // --teal-light in beta
};

// Focus ring color (rgba format)
const RGBA_MAP = {
  'rgba(13, 155, 140,': 'rgba(56, 189, 248,',
  'rgba(13,155,140,': 'rgba(56,189,248,',
};

// Files to process
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function getHtmlFiles(dir) {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...getHtmlFiles(fullPath));
    } else if (item.name.endsWith('.html') || item.name.endsWith('.json') || item.name.endsWith('.svg') || item.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Also process files outside public
const extraFiles = [
  path.join(__dirname, '..', 'server.js'),
  path.join(__dirname, '..', 'public', 'pwa-install.js'),
];

const files = [...getHtmlFiles(PUBLIC_DIR), ...extraFiles.filter(f => fs.existsSync(f))];

let totalReplacements = 0;

for (const filePath of files) {
  let content = fs.readFileSync(filePath, 'utf8');
  let fileReplacements = 0;
  const relPath = path.relative(path.join(__dirname, '..'), filePath);

  // Apply hex color replacements (case-insensitive matching)
  for (const [oldColor, newColor] of Object.entries(COLOR_MAP)) {
    const regex = new RegExp(oldColor.replace('#', '\\#'), 'g');
    const matches = content.match(regex);
    if (matches) {
      fileReplacements += matches.length;
      content = content.replace(regex, newColor);
    }
  }

  // Apply rgba replacements
  for (const [oldRgba, newRgba] of Object.entries(RGBA_MAP)) {
    while (content.includes(oldRgba)) {
      content = content.replace(oldRgba, newRgba);
      fileReplacements++;
    }
  }

  if (fileReplacements > 0) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ${relPath}: ${fileReplacements} replacements`);
    totalReplacements += fileReplacements;
  }
}

console.log(`\nTotal: ${totalReplacements} color replacements across ${files.length} files`);
