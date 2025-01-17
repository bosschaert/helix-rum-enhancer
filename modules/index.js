/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
/* eslint-env browser */

import { KNOWN_PROPERTIES, DEFAULT_TRACKING_EVENTS } from './defaults.js';
import { urlSanitizers } from './utils.js';
import { targetSelector, sourceSelector } from './dom.js';
import {
  addAdsParametersTracking,
  addCookieConsentTracking,
  addEmailParameterTracking,
  addUTMParametersTracking,
} from './martech.js';
import { fflags } from './fflags.js';

const { sampleRUM, queue, isSelected } = (window.hlx && window.hlx.rum) ? window.hlx.rum
  /* c8 ignore next */ : {};

const formSubmitListener = (e) => sampleRUM('formsubmit', { target: targetSelector(e.target), source: sourceSelector(e.target) });

// eslint-disable-next-line no-use-before-define, max-len
const blocksMutationObserver = window.MutationObserver ? new MutationObserver(blocksMutationsCallback)
  /* c8 ignore next */ : {};

// eslint-disable-next-line no-use-before-define, max-len
const mediaMutationObserver = window.MutationObserver ? new MutationObserver(mediaMutationsCallback)
  /* c8 ignore next */ : {};

function trackCheckpoint(checkpoint, data, t) {
  const { weight, id } = window.hlx.rum;
  if (isSelected) {
    const sendPing = (pdata = data) => {
      // eslint-disable-next-line object-curly-newline, max-len
      const body = JSON.stringify({ weight, id, referer: urlSanitizers[window.hlx.RUM_MASK_URL || 'path'](), checkpoint, t, ...data }, KNOWN_PROPERTIES);
      const { href: url, origin } = new URL(`.rum/${weight}`, sampleRUM.collectBaseURL || sampleRUM.baseURL);
      if (window.location.origin === origin) {
        const headers = { type: 'application/json' };
        navigator.sendBeacon(url, new Blob([body], headers));
        /* c8 ignore next 3 */
      } else {
        navigator.sendBeacon(url, body);
      }
      // eslint-disable-next-line no-console
      console.debug(`ping:${checkpoint}`, pdata);
    };
    sendPing(data);
  }
}

function processQueue() {
  while (queue && queue.length) {
    const ck = queue.shift();
    trackCheckpoint(...ck);
  }
}

function addCWVTracking() {
  setTimeout(() => {
    try {
      const cwvScript = new URL('.rum/web-vitals/dist/web-vitals.iife.js', sampleRUM.baseURL).href;
      if (document.querySelector(`script[src="${cwvScript}"]`)) {
        // web vitals script has been loaded already
        return;
      }
      const script = document.createElement('script');
      script.src = cwvScript;
      script.onload = () => {
        const storeCWV = (measurement) => {
          const data = { cwv: {} };
          data.cwv[measurement.name] = measurement.value;
          if (measurement.name === 'LCP' && measurement.entries.length > 0) {
            const { element } = measurement.entries.pop();
            data.target = targetSelector(element);
            data.source = sourceSelector(element) || (element && element.outerHTML.slice(0, 30));
          }
          sampleRUM('cwv', data);
        };

        const isEager = (metric) => ['CLS', 'LCP'].includes(metric);

        // When loading `web-vitals` using a classic script, all the public
        // methods can be found on the `webVitals` global namespace.
        ['FID', 'INP', 'TTFB', 'CLS', 'LCP'].forEach((metric) => {
          const metricFn = window.webVitals[`on${metric}`];
          if (typeof metricFn === 'function') {
            let opts = {};
            fflags.enabled('eagercwv', () => {
              opts = { reportAllChanges: isEager(metric) };
            });
            metricFn(storeCWV, opts);
          }
        });
      };
      document.head.appendChild(script);
      /* c8 ignore next 3 */
    } catch (error) {
      // something went wrong
    }
  }, 2000); // wait for delayed
}

function addNavigationTracking() {
  // enter checkpoint when referrer is not the current page url
  const navigate = (source, type) => {
    const payload = { source, target: document.visibilityState };
    // reload: same page, navigate: same origin, enter: everything else
    if (type === 'reload' || source === window.location.href) {
      sampleRUM('reload', payload);
    } else if (type && type !== 'navigate') {
      sampleRUM(type, payload); // back, forward, prerender, etc.
    } else if (source && window.location.origin === new URL(source).origin) {
      sampleRUM('navigate', payload); // internal navigation
    } else {
      sampleRUM('enter', payload); // enter site
    }
  };

  new PerformanceObserver((list) => list
    .getEntries().map((entry) => navigate(window.hlx.referrer || document.referrer, entry.type)))
    .observe({ type: 'navigation', buffered: true });
}

function addLoadResourceTracking() {
  const observer = new PerformanceObserver((list) => {
    try {
      list.getEntries()
        .filter((entry) => !entry.responseStatus || entry.responseStatus < 400)
        .filter((entry) => window.location.hostname === new URL(entry.name).hostname)
        .filter((entry) => new URL(entry.name).pathname.match('.*(\\.plain\\.html$|\\.json|graphql|api)'))
        .forEach((entry) => {
          sampleRUM('loadresource', { source: entry.name, target: Math.round(entry.duration) });
        });
      list.getEntries()
        .filter((entry) => entry.responseStatus === 404)
        .forEach((entry) => {
          sampleRUM('missingresource', { source: entry.name, target: entry.hostname });
        });
      /* c8 ignore next 3 */
    } catch (error) {
      // something went wrong
    }
  });
  observer.observe({ type: 'resource', buffered: true });
}

function activateBlocksMutationObserver() {
  if (!blocksMutationObserver || blocksMutationObserver.active) {
    return;
  }
  blocksMutationObserver.active = true;
  blocksMutationObserver.observe(
    document.body,
    // eslint-disable-next-line object-curly-newline
    { subtree: true, attributes: true, attributeFilter: ['data-block-status'] },
  );
}

function activateMediaMutationObserver() {
  if (!mediaMutationObserver || mediaMutationObserver.active) {
    return;
  }
  mediaMutationObserver.active = true;
  mediaMutationObserver.observe(
    document.body,
    // eslint-disable-next-line object-curly-newline
    { subtree: true, attributes: false, childList: true },
  );
}

function getIntersectionObsever(checkpoint) {
  /* c8 ignore next 3 */
  if (!window.IntersectionObserver) {
    return null;
  }
  activateBlocksMutationObserver();
  activateMediaMutationObserver();
  const observer = new IntersectionObserver((entries) => {
    try {
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry) => {
          observer.unobserve(entry.target); // observe only once
          const target = targetSelector(entry.target);
          const source = sourceSelector(entry.target);
          sampleRUM(checkpoint, { target, source });
        });
      /* c8 ignore next 3 */
    } catch (error) {
      // something went wrong
    }
  });
  return observer;
}
function addViewBlockTracking(element) {
  const blockobserver = getIntersectionObsever('viewblock');
  if (blockobserver) {
    const blocks = element.getAttribute('data-block-status') ? [element] : element.querySelectorAll('div[data-block-status="loaded"]');
    blocks.forEach((b) => blockobserver.observe(b));
  }
}

const observedMedia = new Set();
function addViewMediaTracking(parent) {
  const mediaobserver = getIntersectionObsever('viewmedia');
  if (mediaobserver) {
    parent.querySelectorAll('img, video, audio, iframe').forEach((m) => {
      if (!observedMedia.has(m)) {
        observedMedia.add(m);
        mediaobserver.observe(m);
      }
    });
  }
}

function addFormTracking(parent) {
  activateBlocksMutationObserver();
  activateMediaMutationObserver();
  parent.querySelectorAll('form').forEach((form) => {
    form.removeEventListener('submit', formSubmitListener); // listen only once
    form.addEventListener('submit', formSubmitListener);
  });
}

function addObserver(ck, fn, block) {
  return DEFAULT_TRACKING_EVENTS.includes(ck) && fn(block);
}

function blocksMutationsCallback(mutations) {
  // block specific mutations
  mutations
    .filter((m) => m.type === 'attributes' && m.attributeName === 'data-block-status')
    .filter((m) => m.target.dataset.blockStatus === 'loaded')
    .forEach((m) => {
      addObserver('form', addFormTracking, m.target);
      addObserver('viewblock', addViewBlockTracking, m.target);
    });
}

function mediaMutationsCallback(mutations) {
  // media mutations
  mutations
    .forEach((m) => {
      addObserver('viewmedia', addViewMediaTracking, m.target);
    });
}

function addTrackingFromConfig() {
  document.addEventListener('click', (event) => {
    sampleRUM('click', { target: targetSelector(event.target), source: sourceSelector(event.target) });
  });
  addCWVTracking();
  addFormTracking(window.document.body);
  addNavigationTracking();
  addLoadResourceTracking();
  addUTMParametersTracking(sampleRUM);
  addViewBlockTracking(window.document.body);
  addViewMediaTracking(window.document.body);
  addCookieConsentTracking(sampleRUM);
  addAdsParametersTracking(sampleRUM);
  addEmailParameterTracking(sampleRUM);
  fflags.enabled('language', () => {
    const target = navigator.language;
    const source = document.documentElement.lang;
    sampleRUM('language', { source, target });
  });
}

function initEnhancer() {
  try {
    if (sampleRUM) {
      addTrackingFromConfig();
      window.hlx.rum.collector = trackCheckpoint;
      processQueue();
    }
  /* c8 ignore next 3 */
  } catch (error) {
    // something went wrong
  }
}

initEnhancer();
