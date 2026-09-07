/*
 * #6262 — destroy() must cancel a pending resize debounce so applyLayout()
 * cannot re-add `ai-docked` after the assistant has been torn down.
 *
 * Uses the shared Playwright harness: a real browser is the only honest way
 * to reproduce the queued-timer ordering across resize -> destroy -> tick.
 */
import { openApp, reporter, run, stubEngine } from './ai-ui-support.mjs';

await run(async ({ browser }) => {
  const { check, state } = reporter();
  const { page, errors } = await openApp(browser, { width: 1440, height: 900, sample: true });

  await stubEngine(page, { answer: 'ok' });

  const setup = await page.evaluate(() => {
    window.__hexAi.open();
    return {
      docked: document.getElementById('viewport')?.classList.contains('ai-docked') ||
        document.documentElement.classList.contains('ai-docked') ||
        !!document.querySelector('.ai-docked'),
      open: window.__hexAi.isOpen(),
    };
  });
  check('assistant opens docked at desktop width', setup.open, JSON.stringify(setup));

  // Queue the resize debounce, then destroy before the 100ms timer fires.
  const after = await page.evaluate(async () => {
    const root = document.documentElement;
    const dockedBefore = root.classList.contains('ai-docked')
      || document.body.classList.contains('ai-docked')
      || !!document.querySelector('.ai-docked');
    window.dispatchEvent(new Event('resize'));
    window.__hexAi.destroy();
    // Wait well past the 100ms debounce window.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      dockedBefore,
      dockedAfter: root.classList.contains('ai-docked')
        || document.body.classList.contains('ai-docked')
        || !!document.querySelector('.ai-docked'),
      openAfter: root.classList.contains('ai-open') || document.body.classList.contains('ai-open'),
      panelGone: !document.getElementById('ai-panel'),
      launcherGone: !document.getElementById('ai-launcher'),
      apiGone: !window.__hexAi,
    };
  });

  check('assistant was docked before destroy', after.dockedBefore);
  check('no ai-docked reappears after destroy (pending timer cancelled)', !after.dockedAfter, JSON.stringify(after));
  check('no ai-open reappears after destroy', !after.openAfter);
  check('panel is removed from the DOM', after.panelGone);
  check('launcher is removed from the DOM', after.launcherGone);
  check('window.__hexAi is cleaned up', after.apiGone);

  // A post-destroy resize must not resurrect layout classes either.
  const postResize = await page.evaluate(async () => {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      docked: document.documentElement.classList.contains('ai-docked')
        || document.body.classList.contains('ai-docked')
        || !!document.querySelector('.ai-docked'),
    };
  });
  check('resize/orientationchange after destroy has no layout side effect', !postResize.docked, JSON.stringify(postResize));

  check('no page errors during destroy sequence', errors.length === 0, errors.join(' | '));

  console.log(`failures: ${state.failures}`);
  if (state.failures) process.exit(1);
});
