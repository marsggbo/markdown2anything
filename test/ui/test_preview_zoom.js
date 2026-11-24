const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { buildTestHtml } = require('../helpers/webview');

(async () => {
  const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(buildTestHtml());
    await page.evaluate(() => {
      const paragraph = '<p>' + '这段预览文字用来检查放大前后每行的换行位置。'.repeat(15) + '</p>';
      const image = '<img alt="Zoom fixture" width="1000" height="400" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
      document.getElementById('preview-content').innerHTML = image + paragraph.repeat(30);
    });

    const measure = () => page.evaluate(() => {
      const viewport = document.getElementById('preview-scroll');
      const canvas = document.getElementById('zoom-canvas');
      const range = document.createRange();
      range.selectNodeContents(canvas.querySelector('p') || canvas);
      const lines = Array.from(range.getClientRects());
      const rect = canvas.getBoundingClientRect();
      const image = canvas.querySelector('img');
      return {
        width: canvas.offsetWidth,
        imageWidth: image?.getBoundingClientRect().width,
        imageHeight: image?.getBoundingClientRect().height,
        visualWidth: rect.width,
        visualHeight: rect.height,
        lineCount: lines.length,
        firstLineWidth: lines[0]?.width,
        left: rect.left,
        top: rect.top,
        scrollX: viewport.scrollLeft,
        scrollY: viewport.scrollTop,
        maxX: viewport.scrollWidth - viewport.clientWidth,
        maxY: viewport.scrollHeight - viewport.clientHeight,
        viewport: viewport.getBoundingClientRect().toJSON(),
      };
    });
    const wheel = (point, deltaY) => page.locator('#preview-scroll').dispatchEvent('wheel', {
      ...point, deltaY, ctrlKey: true, bubbles: true, cancelable: true,
    });
    const near = (actual, expected, tolerance = 1) => {
      assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ≈ ${expected}`);
    };

    const mode = page.locator('#zoom-mode');
    const value = page.locator('#zoom-value');
    assert.equal(await mode.inputValue(), 'canvas');
    const original = await measure();
    const anchor = {
      clientX: Math.round(original.viewport.left + original.viewport.width * 0.6),
      clientY: Math.round(original.viewport.top + original.viewport.height * 0.4),
    };
    for (let i = 0; i < 8; i++) await wheel(anchor, -100);
    const before = await measure();
    assert.equal(await value.textContent(), '180%');
    assert.equal(before.width, original.width);
    assert.equal(before.lineCount, original.lineCount);
    near(before.firstLineWidth / 1.8, original.firstLineWidth, 0.05);
    near(before.visualHeight, original.visualHeight * 1.8);
    near(before.imageWidth, original.imageWidth * 1.8);
    near(before.imageHeight, original.imageHeight * 1.8);

    await wheel(anchor, -100);
    const after = await measure();
    near((anchor.clientX - after.left) / 1.9, (anchor.clientX - before.left) / 1.8);
    near((anchor.clientY - after.top) / 1.9, (anchor.clientY - before.top) / 1.8);
    near(after.visualWidth, original.visualWidth * 1.9);
    assert.ok(after.maxX > 0 && after.maxY > original.maxY);

    // Ordinary trackpad scrolling pans the enlarged canvas on both axes.
    await page.mouse.move(anchor.clientX, anchor.clientY);
    await page.mouse.wheel(48, 64);
    await page.waitForFunction(({ scrollX, scrollY }) => {
      const viewport = document.getElementById('preview-scroll');
      return viewport.scrollLeft > scrollX && viewport.scrollTop > scrollY;
    }, after);
    assert.equal(await value.textContent(), '190%');

    await mode.selectOption('text');
    const reflowed = await measure();
    assert.equal(await value.textContent(), '190%');
    assert.ok(reflowed.width < original.width);
    assert.ok(reflowed.lineCount > original.lineCount);
    await page.locator('#preview-content img').dispatchEvent('wheel', {
      ...anchor, deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true,
    });
    const pinched = await measure();
    assert.equal(await mode.inputValue(), 'text');
    assert.equal(await value.textContent(), '200%');
    assert.equal(pinched.lineCount, original.lineCount);
    near(pinched.imageWidth, original.imageWidth * 2);
    near(pinched.imageHeight, original.imageHeight * 2);
    await mode.selectOption('canvas');
    assert.equal((await measure()).lineCount, original.lineCount);

    // Resizing and replacing the document must refresh the scaled scroll bounds.
    await page.setViewportSize({ width: 740, height: 640 });
    const narrow = await measure();
    assert.ok(narrow.width < original.width);
    await page.evaluate(() => {
      document.getElementById('preview-content').replaceChildren();
    });
    await page.waitForFunction(() => {
      const viewport = document.getElementById('preview-scroll');
      return viewport.scrollHeight === viewport.clientHeight;
    });
    await page.locator('#btn-zoom-reset').click();
    assert.equal(await value.textContent(), '100%');
    assert.equal((await measure()).maxX, 0);
    await page.locator('#btn-zoom-out').click();
    assert.equal(await value.textContent(), '90%');
    const small = await measure();
    assert.equal(small.width, narrow.width);
    assert.equal(small.maxX, 0);
    // Pinch deltas smaller than a percentage point accumulate.
    for (let i = 0; i < 4; i++) await wheel(anchor, -0.5);
    assert.equal(await value.textContent(), '91%');
    assert.deepEqual(errors, []);
    console.log('Preview zoom: layout, gesture anchor, scrolling, mode switch and resizing passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
