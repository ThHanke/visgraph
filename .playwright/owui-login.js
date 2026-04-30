async (page) => {
  await page.context().addCookies([{
    name: 'token',
    value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjRmNjQwZjYzLThmY2MtNGMxMy1iNDcyLTFhMzBjZTU5ZjAwNCIsImp0aSI6Ijc0M2JiMmQ1LWVhMTQtNDc2Yi1iMTFkLTJlZWNmMDY2NTM3OCJ9.88gzl7KSJY_S2s_xJkxXi1f_nP2gQHtrBYzlVmrdPls',
    domain: 'gpuserver1-sit.iwm.fraunhofer.de',
    path: '/',
  }]);
  await page.reload();
  await page.waitForLoadState('networkidle');
  return { url: page.url(), title: await page.title() };
}
