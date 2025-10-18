(() => {
  const url = chrome.runtime.getURL('content/widget.module.js');
  import(url).catch((error) => {
    console.error('[Ekko] Unable to load floating widget module', error);
  });
})();
