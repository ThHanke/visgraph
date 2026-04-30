async (page) => {
  const pages = page.context().pages();
  const ontospherePage = pages.find(p => p.url().includes('docker-dev'));
  if (!ontospherePage) return { ok: false, error: 'Ontosphere tab not found' };

  const code = await ontospherePage.evaluate(async () => {
    const r = await fetch('/relay-bookmarklet.js');
    let src = await r.text();
    src = src.replace(/__RELAY_URL__/g, 'http://docker-dev.iwm.fraunhofer.de:8080/relay.html');
    src = src.replace(/__RELAY_ORIGIN__/g, 'http://docker-dev.iwm.fraunhofer.de:8080');
    // Expose relay internals globally before the IIFE closes
    src = src.replace(/\}\)\(\);\s*$/, [
      '  window.__vgInjectResult = injectResult;',
      '  window.__vgIsStreaming   = isAiStreaming;',
      '  window.__vgWaitForIdle  = waitForIdle;',
      '})();'
    ].join('\n'));
    return src;
  });

  await page.addScriptTag({ content: code });
  return await page.evaluate(() => ({
    ok: true,
    instanceId: window.__vgRelayInstanceId,
    popup: window.__vgRelayPopup ? !window.__vgRelayPopup.closed : false,
    exposed: typeof window.__vgInjectResult === 'function'
  }));
}
