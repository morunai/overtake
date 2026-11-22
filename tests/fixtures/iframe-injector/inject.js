// Mimics real extensions:
//  1. a plain iframe with a chrome-extension:// src (simple injectors)
//  2. LastPass-style: a host element with a CLOSED shadow root holding an iframe that
//     is navigated through contentWindow.location (no src attribute)
const plain = document.createElement('iframe');
plain.src = chrome.runtime.getURL('frame.html');
plain.className = 'injected-ext-frame';
plain.style.cssText = 'position:fixed;right:8px;bottom:8px;width:120px;height:40px;border:0;z-index:2147483646';
(document.body || document.documentElement).appendChild(plain);

const host = document.createElement('div');
host.className = 'injected-ext-shadow-host';
(document.body || document.documentElement).appendChild(host);
const root = host.attachShadow({ mode: 'closed' });
const hidden = document.createElement('iframe');
hidden.style.cssText = 'width:120px;height:40px;border:0';
root.appendChild(hidden);
hidden.contentWindow.location = chrome.runtime.getURL('frame.html');
window.__fixtureShadowRoot = undefined; // closed: unreachable from the page
