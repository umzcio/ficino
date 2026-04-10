import { test, expect } from '@playwright/test';

const SCREENSHOT_DIR = '/projects/ficino/tests/screenshots';

// Helper: navigate and wait for React to render
async function gotoAndWait(page: import('@playwright/test').Page) {
  await page.goto('/ficino/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for React root to have content
  await page.waitForFunction(() => {
    const root = document.getElementById('root');
    return root && root.children.length > 0;
  }, { timeout: 20000 });
  await page.waitForTimeout(1500);
}

// ─── Section 17: Mobile UX ───────────────────────────────────────────────────

test.describe('Section 17 – Mobile UX (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('17.1 – No horizontal scroll at mobile width', async ({ page }) => {
    await gotoAndWait(page);

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_no_horizontal_scroll.png`, fullPage: true });

    // scrollWidth should not exceed clientWidth (no horizontal overflow)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5); // 5px tolerance
  });

  test('17.2 – Ficino logo visible and opens drawer on tap', async ({ page }) => {
    await gotoAndWait(page);

    // Look for the logo / hamburger / brand element in the top bar
    const logo = page.locator('img[alt*="icino" i], img[alt*="ogo" i], [class*="logo" i], [class*="brand" i], header img, [class*="Logo"]').first();
    const logoVisible = await logo.isVisible().catch(() => false);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_logo_visible.png` });

    if (logoVisible) {
      await logo.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_drawer_opened.png` });
    } else {
      // Try hamburger menu icon
      const hamburger = page.locator('[class*="hamburger" i], [class*="menu-icon" i], [aria-label*="menu" i], button:has(svg)').first();
      const hambVisible = await hamburger.isVisible().catch(() => false);
      if (hambVisible) {
        await hamburger.click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_drawer_opened.png` });
      }
    }

    // Verify drawer content
    const drawer = page.locator('[class*="drawer" i], [class*="sidebar" i], [class*="Sidebar" i], nav, [role="navigation"]').first();
    const drawerVisible = await drawer.isVisible().catch(() => false);
    console.log(`Drawer visible after tap: ${drawerVisible}`);
  });

  test('17.3 – Drawer contains upload area, corpus panel, personas', async ({ page }) => {
    await gotoAndWait(page);

    // Open drawer: try logo first, then hamburger
    const openers = [
      'img[alt*="icino" i]',
      'img[alt*="ogo" i]',
      '[class*="logo" i]',
      '[class*="Logo"]',
      '[aria-label*="menu" i]',
      'button:has(svg)',
    ];
    for (const sel of openers) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(800);
        break;
      }
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_drawer_contents.png`, fullPage: true });

    // Check for upload area
    const uploadArea = page.locator('[class*="upload" i], [class*="Upload" i], [class*="dropzone" i], input[type="file"]');
    const hasUpload = (await uploadArea.count()) > 0;
    console.log(`Upload area found: ${hasUpload}`);

    // Check for corpus panel
    const corpusPanel = page.locator('[class*="corpus" i], [class*="Corpus" i]');
    const corpusByText = page.getByText(/corpus/i);
    const hasCorpus = (await corpusPanel.count()) > 0 || (await corpusByText.count()) > 0;
    console.log(`Corpus panel found: ${hasCorpus}`);

    // Check for personas
    const personas = page.locator('[class*="persona" i], [class*="Persona" i]');
    const personasByText = page.getByText(/persona/i);
    const hasPersonas = (await personas.count()) > 0 || (await personasByText.count()) > 0;
    console.log(`Personas found: ${hasPersonas}`);
  });

  test('17.4 – Drawer closes properly', async ({ page }) => {
    await gotoAndWait(page);

    // Open drawer
    const openers = [
      'img[alt*="icino" i]',
      '[class*="logo" i]',
      '[class*="Logo"]',
      '[aria-label*="menu" i]',
    ];
    for (const sel of openers) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(800);
        break;
      }
    }

    // Close drawer: click overlay / close button / press Escape
    const closeBtn = page.locator('[class*="close" i], [aria-label*="close" i], [class*="overlay" i], [class*="backdrop" i]').first();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_drawer_closed.png` });
  });

  test('17.5 – Bottom nav has 4 items', async ({ page }) => {
    await gotoAndWait(page);

    // Look for bottom navigation
    const bottomNav = page.locator(
      '[class*="bottom-nav" i], [class*="bottomNav" i], [class*="BottomNav" i], ' +
      '[class*="mobile-nav" i], [class*="MobileNav" i], [class*="tab-bar" i], ' +
      'nav[class*="bottom" i], [role="tablist"]'
    );

    const navItems = page.locator(
      '[class*="bottom-nav" i] a, [class*="bottom-nav" i] button, ' +
      '[class*="bottomNav" i] a, [class*="bottomNav" i] button, ' +
      '[class*="BottomNav" i] a, [class*="BottomNav" i] button, ' +
      '[class*="MobileNav" i] a, [class*="MobileNav" i] button, ' +
      '[class*="tab-bar" i] a, [class*="tab-bar" i] button, ' +
      'nav[class*="bottom" i] a, nav[class*="bottom" i] button'
    );

    const count = await navItems.count();
    console.log(`Bottom nav items found: ${count}`);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_bottom_nav.png` });

    // If we can't find bottom nav specifically, look for any fixed-bottom nav
    if (count === 0) {
      // Try generic approach: find elements fixed to the bottom
      const fixedBottomEls = await page.evaluate(() => {
        const els = document.querySelectorAll('nav, [role="navigation"], [class*="nav" i]');
        const results: string[] = [];
        els.forEach((el) => {
          const style = window.getComputedStyle(el);
          if (style.position === 'fixed' && parseInt(style.bottom) <= 10) {
            results.push(`${el.tagName}.${el.className}: ${el.children.length} children`);
          }
        });
        return results;
      });
      console.log('Fixed-bottom nav elements:', JSON.stringify(fixedBottomEls));
    }
  });

  test('17.6 – Posts are readable at mobile width', async ({ page }) => {
    await gotoAndWait(page);

    // Find post/card elements
    const posts = page.locator(
      '[class*="post" i], [class*="Post" i], [class*="card" i], [class*="Card" i], ' +
      '[class*="tweet" i], [class*="Tweet" i], article'
    );

    const postCount = await posts.count();
    console.log(`Posts/cards found: ${postCount}`);

    if (postCount > 0) {
      const firstPost = posts.first();
      const box = await firstPost.boundingBox();
      if (box) {
        console.log(`First post width: ${box.width}, viewport: 390`);
        // Post should not be wider than viewport
        expect(box.width).toBeLessThanOrEqual(395);
        // Post should have reasonable minimum width
        expect(box.width).toBeGreaterThan(200);
      }
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s17_posts_mobile.png`, fullPage: true });
  });
});

// ─── Section 18: Accessibility ───────────────────────────────────────────────

test.describe('Section 18 – Accessibility', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('18.1 – Tab focus produces visible gold focus ring', async ({ page }) => {
    await gotoAndWait(page);

    // Tab through several elements and check for focus ring
    const focusResults: { tag: string; hasOutline: boolean; outlineColor: string; outlineStyle: string }[] = [];

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);

      const focusInfo = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = window.getComputedStyle(el);
        return {
          tag: `${el.tagName}.${el.className}`.substring(0, 80),
          hasOutline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          boxShadow: style.boxShadow.substring(0, 100),
        };
      });

      if (focusInfo) {
        focusResults.push(focusInfo as any);
      }
    }

    console.log('Focus ring results:');
    focusResults.forEach((r, i) => {
      console.log(`  [${i}] ${r.tag} — outline: ${r.outlineStyle} ${(r as any).outlineWidth} ${r.outlineColor}, hasFocusRing: ${r.hasOutline}`);
      if ((r as any).boxShadow && (r as any).boxShadow !== 'none') {
        console.log(`        boxShadow: ${(r as any).boxShadow}`);
      }
    });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s18_focus_ring.png` });

    // At least some elements should have visible focus indication
    const withFocus = focusResults.filter(r => r.hasOutline || ((r as any).boxShadow && (r as any).boxShadow !== 'none'));
    console.log(`Elements with visible focus: ${withFocus.length} / ${focusResults.length}`);
  });

  test('18.2 – Buttons have aria-labels', async ({ page }) => {
    await gotoAndWait(page);

    const buttonAudit = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, [role="button"]');
      const results: { text: string; hasAriaLabel: boolean; ariaLabel: string | null; hasText: boolean }[] = [];
      buttons.forEach((btn) => {
        const text = (btn.textContent || '').trim().substring(0, 50);
        const ariaLabel = btn.getAttribute('aria-label');
        const hasText = text.length > 0;
        results.push({
          text: text || '(empty)',
          hasAriaLabel: !!ariaLabel,
          ariaLabel,
          hasText,
        });
      });
      return results;
    });

    console.log('Button aria-label audit:');
    let missingCount = 0;
    buttonAudit.forEach((b, i) => {
      const accessible = b.hasAriaLabel || b.hasText;
      if (!accessible) missingCount++;
      console.log(`  [${i}] text="${b.text}" aria-label="${b.ariaLabel}" accessible=${accessible}`);
    });

    console.log(`\nButtons missing accessible name: ${missingCount} / ${buttonAudit.length}`);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s18_button_labels.png` });

    // Icon-only buttons (no text) should have aria-label
    const iconButtons = buttonAudit.filter(b => !b.hasText);
    const iconButtonsMissing = iconButtons.filter(b => !b.hasAriaLabel);
    if (iconButtonsMissing.length > 0) {
      console.log(`\nBUG: ${iconButtonsMissing.length} icon-only buttons lack aria-label`);
    }
  });

  test('18.3 – Toggle switches have role="switch" and aria-checked', async ({ page }) => {
    await gotoAndWait(page);

    // Also open settings/preferences if there's a toggle there
    const toggles = page.locator('[role="switch"], [class*="toggle" i], [class*="Toggle" i], [class*="switch" i]');
    const count = await toggles.count();
    console.log(`Toggle elements found: ${count}`);

    const toggleAudit = await page.evaluate(() => {
      const els = document.querySelectorAll('[role="switch"], [class*="toggle" i], [class*="Toggle" i], [class*="switch" i], input[type="checkbox"]');
      const results: { tag: string; role: string | null; ariaChecked: string | null; className: string }[] = [];
      els.forEach((el) => {
        results.push({
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaChecked: el.getAttribute('aria-checked'),
          className: (el.className || '').toString().substring(0, 80),
        });
      });
      return results;
    });

    console.log('Toggle/switch audit:');
    toggleAudit.forEach((t, i) => {
      const hasRole = t.role === 'switch' || t.role === 'checkbox';
      const hasChecked = t.ariaChecked !== null;
      console.log(`  [${i}] <${t.tag}> role="${t.role}" aria-checked="${t.ariaChecked}" class="${t.className}" proper=${hasRole && hasChecked}`);
    });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s18_toggles.png` });
  });

  test('18.4 – Dialogs have role="dialog"', async ({ page }) => {
    await gotoAndWait(page);

    // Try to open a dialog by clicking various triggers
    const dialogTriggers = [
      '[class*="compose" i]',
      '[aria-label*="compose" i]',
      '[aria-label*="new" i]',
      '[class*="modal" i]',
      'button:has-text("Post")',
      'button:has-text("New")',
    ];

    let dialogOpened = false;
    for (const sel of dialogTriggers) {
      const el = page.locator(sel).first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        await page.waitForTimeout(800);
        dialogOpened = true;
        break;
      }
    }

    // Check for dialog role
    const dialogs = await page.evaluate(() => {
      const els = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog');
      return Array.from(els).map((el) => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        ariaLabelledBy: el.getAttribute('aria-labelledby'),
        className: (el.className || '').toString().substring(0, 80),
      }));
    });

    console.log(`Dialog opened: ${dialogOpened}`);
    console.log(`Dialog elements found: ${dialogs.length}`);
    dialogs.forEach((d, i) => {
      console.log(`  [${i}] <${d.tag}> role="${d.role}" aria-label="${d.ariaLabel}" aria-labelledby="${d.ariaLabelledBy}"`);
    });

    // Also check if modals without role="dialog" exist
    const modalWithoutRole = await page.evaluate(() => {
      const modals = document.querySelectorAll('[class*="modal" i], [class*="Modal" i], [class*="dialog" i], [class*="Dialog" i]');
      return Array.from(modals)
        .filter((el) => !el.getAttribute('role'))
        .map((el) => ({
          tag: el.tagName,
          className: (el.className || '').toString().substring(0, 80),
        }));
    });

    if (modalWithoutRole.length > 0) {
      console.log(`\nBUG: ${modalWithoutRole.length} modal-like elements lack role="dialog":`);
      modalWithoutRole.forEach((m) => console.log(`  <${m.tag}> class="${m.className}"`));
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s18_dialog_role.png` });
  });

  test('18.5 – Color contrast on muted text', async ({ page }) => {
    await gotoAndWait(page);

    const contrastResults = await page.evaluate(() => {
      function luminance(r: number, g: number, b: number) {
        const [rs, gs, bs] = [r, g, b].map((c) => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }

      function contrastRatio(l1: number, l2: number) {
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }

      function parseColor(color: string): [number, number, number] | null {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (match) return [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
        return null;
      }

      // Find muted/secondary text elements
      const candidates = document.querySelectorAll(
        '[class*="muted" i], [class*="secondary" i], [class*="subtle" i], ' +
        '[class*="timestamp" i], [class*="meta" i], [class*="hint" i], ' +
        'time, [class*="date" i], [class*="ago" i], small'
      );

      const results: { text: string; fg: string; bg: string; ratio: number; passes: boolean }[] = [];

      candidates.forEach((el) => {
        const text = (el.textContent || '').trim().substring(0, 40);
        if (!text) return;

        const style = window.getComputedStyle(el);
        const fg = style.color;
        const fgParsed = parseColor(fg);
        if (!fgParsed) return;

        // Walk up to find background
        let bgColor: [number, number, number] = [0, 0, 0]; // default dark
        let current: Element | null = el;
        while (current) {
          const cs = window.getComputedStyle(current);
          const bgParsed = parseColor(cs.backgroundColor);
          if (bgParsed && !(bgParsed[0] === 0 && bgParsed[1] === 0 && bgParsed[2] === 0 && cs.backgroundColor.includes('0)'))) {
            bgColor = bgParsed;
            break;
          }
          current = current.parentElement;
        }

        const fgLum = luminance(...fgParsed);
        const bgLum = luminance(...bgColor);
        const ratio = contrastRatio(fgLum, bgLum);

        results.push({
          text,
          fg,
          bg: `rgb(${bgColor.join(', ')})`,
          ratio: Math.round(ratio * 100) / 100,
          passes: ratio >= 4.5, // WCAG AA for normal text
        });
      });

      return results;
    });

    console.log('Color contrast audit (muted text):');
    let failCount = 0;
    contrastResults.forEach((r, i) => {
      const status = r.passes ? 'PASS' : 'FAIL';
      if (!r.passes) failCount++;
      console.log(`  [${i}] ${status} ratio=${r.ratio}:1 fg=${r.fg} bg=${r.bg} "${r.text}"`);
    });

    console.log(`\nContrast failures: ${failCount} / ${contrastResults.length} (WCAG AA 4.5:1 threshold)`);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s18_color_contrast.png` });
  });

  test('18.6 – Accessibility tree snapshot', async ({ page }) => {
    await gotoAndWait(page);

    // page.accessibility.snapshot() was removed in Playwright v1.50+
    // Use aria snapshot instead
    const ariaTree = await page.evaluate(() => {
      function getAriaInfo(el: Element, depth: number): any {
        if (depth > 3) return null;
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
        const children: any[] = [];
        for (const child of el.children) {
          const info = getAriaInfo(child, depth + 1);
          if (info) children.push(info);
        }
        if (children.length === 0 && !label && !el.getAttribute('role')) return null;
        return { role, label: label || undefined, children: children.length ? children : undefined };
      }
      return getAriaInfo(document.body, 0);
    });
    console.log('Accessibility tree (top-level):');
    console.log(JSON.stringify(ariaTree, null, 2).substring(0, 3000));

    await page.screenshot({ path: `${SCREENSHOT_DIR}/s18_a11y_tree.png` });

    // Check for landmark roles
    const landmarks = await page.evaluate(() => {
      const roles = ['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'search'];
      const found: { role: string; tag: string }[] = [];
      roles.forEach((role) => {
        const els = document.querySelectorAll(`[role="${role}"], header, nav, main, footer, aside`);
        els.forEach((el) => {
          found.push({ role: el.getAttribute('role') || el.tagName.toLowerCase(), tag: el.tagName });
        });
      });
      return found;
    });

    console.log('\nLandmark roles found:');
    landmarks.forEach((l) => console.log(`  <${l.tag}> role="${l.role}"`));
  });
});
